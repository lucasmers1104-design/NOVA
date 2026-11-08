//! "Clip das!": while a game runs (see `agent::play`) ffmpeg records the screen
//! the game is on, with what the PC plays, into two-second pieces on disk:
//! always the last 80 seconds, encoded on the graphics card. A clip joins the
//! latest pieces into one video in Videos\NOVA Clips without encoding again.
//! Nothing is recorded unless the user turned clips on, and nothing outside
//! games. ffmpeg is downloaded once, when clips are turned on, and checked
//! against its SHA-256. Capture goes through Windows (Desktop Duplication), so
//! nothing touches the game itself.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::speech::catalog::File;
use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

const FFMPEG: File = File {
    name: "ffmpeg.exe",
    url: "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip",
    sha256: "228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb",
    size: 101_457_920,
    zip_entry: Some("ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe"),
};
/// What the download costs (ffmpeg.exe compressed in the archive).
const DOWNLOAD_SIZE: u64 = 35_563_623;
const PREFS_KEY: &str = "nova.replay";
const WEBHOOK_TARGET: &str = "NOVA:discord-webhook";
const EVENT_STATUS: &str = "replay://status";
const PIECE_SECONDS: u64 = 2;
const PIECES: &str = "40";
pub const LONGEST_CLIP: u64 = 60;
pub const DEFAULT_CLIP: u64 = 30;
/// Discord takes 10 MB per file without server boosts.
const DISCORD_LIMIT: u64 = 9_500_000;
const RATE: u64 = 48_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A video encoder ffmpeg may use, tried in this order.
struct Encoder {
    label: &'static str,
    codec: &'static str,
    /// Graphics cards take the captured frames as they are; Windows' own encoder wants them in memory.
    filter: &'static str,
}

const ENCODERS: [Encoder; 3] = [
    Encoder { label: "NVIDIA", codec: "h264_nvenc", filter: "" },
    Encoder { label: "AMD", codec: "h264_amf", filter: "" },
    Encoder { label: "Windows", codec: "h264_mf", filter: ",hwdownload,format=bgra,format=nv12" },
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReplayPrefs {
    pub enabled: bool,
    /// What the user calls the Discord channel, e.g. "die Jungs".
    pub discord_name: String,
}

struct Recorder {
    child: Child,
    stop: Arc<AtomicBool>,
    dir: PathBuf,
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[derive(Default)]
struct Inner {
    prefs: ReplayPrefs,
    recorder: Option<Recorder>,
    /// Which of `ENCODERS` works here, once tried; `Some(None)`: none.
    encoder: Option<Option<usize>>,
    failures: u32,
    error: Option<String>,
    /// Bytes downloaded so far while ffmpeg downloads.
    downloading: Option<u64>,
    /// The latest clip and its length in seconds.
    last_clip: Option<(PathBuf, u64)>,
}

#[derive(Default)]
pub struct ReplayState {
    inner: Mutex<Inner>,
}

impl ReplayState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let prefs = app
        .state::<Database>()
        .with(|conn| crate::storage::kv_get(conn, PREFS_KEY))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<ReplayPrefs>(&raw).ok())
        .unwrap_or_default();
    app.state::<ReplayState>().lock().prefs = prefs;
}

fn tools_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|dir| dir.join("tools")).map_err(|e| e.to_string())
}

fn ffmpeg<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let path = tools_dir(app).ok()?.join(FFMPEG.name);
    std::fs::metadata(&path).is_ok_and(|m| m.len() == FFMPEG.size).then_some(path)
}

/// Videos\NOVA Clips.
pub fn clips_folder() -> PathBuf {
    let videos = crate::files::known_folders().into_iter().find(|f| f.id == "videos").map(|f| PathBuf::from(f.path));
    videos.or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("Videos"))).unwrap_or_default().join("NOVA Clips")
}

fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.arg("-hide_banner").arg("-nostdin").args(["-loglevel", "error"]);
    command
}

/// Runs ffmpeg to the end, or stops it after `limit`.
fn run(mut command: Command, limit: Duration) -> Result<(), String> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("ffmpeg didn't start: {e}"))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            let mut text = String::new();
            let _ = std::io::Read::read_to_string(&mut child.stderr.take().ok_or("no output")?, &mut text);
            return Err(text.lines().last().unwrap_or("ffmpeg failed").trim().to_string());
        }
        if started.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ffmpeg took too long".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The graphics adapter and output showing the window in front, as ffmpeg counts them.
#[cfg(windows)]
fn display_in_front() -> (u32, u32) {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: read-only queries; every COM object is released when dropped.
    unsafe {
        let monitor = MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY);
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return (0, 0) };
        for a in 0..16 {
            let Ok(adapter) = factory.EnumAdapters1(a) else { break };
            for o in 0..16 {
                let Ok(output) = adapter.EnumOutputs(o) else { break };
                if output.GetDesc().is_ok_and(|desc| desc.Monitor == monitor) {
                    return (a, o);
                }
            }
        }
        (0, 0)
    }
}

#[cfg(not(windows))]
fn display_in_front() -> (u32, u32) {
    (0, 0)
}

fn capture_args(command: &mut Command, (adapter, output): (u32, u32), encoder: &Encoder, fps: u32) {
    command
        .args(["-init_hw_device", &format!("d3d11va=dx:{adapter}"), "-filter_hw_device", "dx"])
        .args(["-filter_complex", &format!("ddagrab=output_idx={output}:framerate={fps}{}[v]", encoder.filter)]);
}

/// Which encoder works on this PC: a few frames of the screen with each.
fn pick_encoder(ffmpeg: &Path, display: (u32, u32)) -> Option<usize> {
    ENCODERS.iter().position(|encoder| {
        let mut probe = command(ffmpeg);
        capture_args(&mut probe, display, encoder, 30);
        probe.args(["-map", "[v]", "-frames:v", "5", "-c:v", encoder.codec, "-f", "null", "-"]);
        run(probe, Duration::from_secs(15)).is_ok()
    })
}

/// Hands ffmpeg what the PC plays, 48 kHz stereo, at the pace of the clock:
/// silence where Windows delivers nothing, so sound and picture stay together.
fn feed_audio(mut sink: ChildStdin, stop: Arc<AtomicBool>) {
    let began = Instant::now();
    let mut written: u64 = 0;
    let write = |sink: &mut ChildStdin, frames: &[u8], written: &mut u64| -> bool {
        *written += frames.len() as u64 / 8;
        sink.write_all(frames).is_ok()
    };
    let silence = vec![0u8; (RATE / 10 * 8) as usize];
    let catch_up = |sink: &mut ChildStdin, written: &mut u64| -> bool {
        let due = began.elapsed().as_millis() as u64 * RATE / 1000;
        while *written + RATE / 50 < due {
            let frames = (due - *written).min(RATE / 10);
            if !write(sink, &silence[..(frames * 8) as usize], written) {
                return false;
            }
        }
        true
    };
    #[cfg(windows)]
    {
        // SAFETY: WASAPI loopback on objects this thread owns; each buffer is released after it is copied.
        let loopback = unsafe { loopback() };
        if let Ok((client, reader)) = loopback {
            unsafe {
                use windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT;
                let _ = client.Start();
                let mut chunk = Vec::new();
                'outer: while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(10));
                    while reader.GetNextPacketSize().unwrap_or(0) > 0 {
                        let mut data = std::ptr::null_mut();
                        let (mut frames, mut flags) = (0u32, 0u32);
                        if reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None).is_err() {
                            break 'outer;
                        }
                        chunk.clear();
                        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                            chunk.resize(frames as usize * 8, 0);
                        } else {
                            chunk.extend_from_slice(std::slice::from_raw_parts(data, frames as usize * 8));
                        }
                        let _ = reader.ReleaseBuffer(frames);
                        // Ahead of the clock (a hiccup on NOVA's side): drop rather than drift.
                        let due = began.elapsed().as_millis() as u64 * RATE / 1000;
                        if written < due + RATE / 10 && !write(&mut sink, &chunk, &mut written) {
                            break 'outer;
                        }
                    }
                    if !catch_up(&mut sink, &mut written) {
                        break;
                    }
                }
                let _ = client.Stop();
            }
            return;
        }
    }
    // No sound device: silence, so the video still records.
    while !stop.load(Ordering::Relaxed) && catch_up(&mut sink, &mut written) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The default speakers, captured as they play, converted by Windows to 48 kHz float stereo.
#[cfg(windows)]
unsafe fn loopback() -> windows::core::Result<(windows::Win32::Media::Audio::IAudioClient, windows::Win32::Media::Audio::IAudioCaptureClient)> {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    let format = WAVEFORMATEX { wFormatTag: 3, nChannels: 2, nSamplesPerSec: RATE as u32, nAvgBytesPerSec: RATE as u32 * 8, nBlockAlign: 8, wBitsPerSample: 32, cbSize: 0 };
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None)?;
    let reader: IAudioCaptureClient = client.GetService()?;
    Ok((client, reader))
}

fn record(ffmpeg: &Path, dir: &Path, display: (u32, u32), encoder: &Encoder) -> Result<Recorder, String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(dir.join("ffmpeg.log")).map_err(|e| e.to_string())?;
    let mut recorder = command(ffmpeg);
    capture_args(&mut recorder, display, encoder, 60);
    recorder
        .args(["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-map", "[v]", "-map", "0:a"])
        .args(["-c:v", encoder.codec, "-b:v", "16M", "-maxrate", "24M", "-bufsize", "32M", "-g", "120", "-force_key_frames", "expr:gte(t,n_forced*2)"])
        .args(["-c:a", "aac", "-b:a", "160k"])
        .args(["-f", "segment", "-segment_time", &PIECE_SECONDS.to_string(), "-segment_wrap", PIECES, "-reset_timestamps", "1"])
        .arg(dir.join("piece%02d.ts"));
    let mut child = recorder.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(log).spawn().map_err(|e| format!("ffmpeg didn't start: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let sink = child.stdin.take().ok_or("ffmpeg has no input")?;
    let audio_stop = stop.clone();
    std::thread::spawn(move || feed_audio(sink, audio_stop));
    Ok(Recorder { child, stop, dir: dir.to_path_buf() })
}

/// Called once a second by `agent::play`: records while a game is in front
/// (and a little after) and clips are on; stops otherwise.
pub fn follow<R: Runtime>(app: &AppHandle<R>, active: bool) {
    let state = app.state::<ReplayState>();
    let tool = ffmpeg(app);
    let (encoder, display) = {
        let mut inner = state.lock();
        if !(active && inner.prefs.enabled && tool.is_some()) {
            let stopped = inner.recorder.take().is_some();
            // A new game gets new tries.
            if !active {
                inner.failures = 0;
            }
            drop(inner);
            if stopped {
                emit_status(app);
            }
            return;
        }
        if let Some(recorder) = inner.recorder.as_mut() {
            if !matches!(recorder.child.try_wait(), Ok(Some(_))) {
                return;
            }
            let log = std::fs::read_to_string(recorder.dir.join("ffmpeg.log")).unwrap_or_default();
            inner.error = Some(log.lines().last().map_or("The recording stopped.".to_string(), |line| format!("The recording stopped: {}", line.trim())));
            inner.recorder = None;
            inner.failures += 1;
        }
        if inner.failures >= 3 || inner.encoder == Some(None) {
            return;
        }
        (inner.encoder, display_in_front())
    };
    let Some(tool) = tool else { return };
    let encoder = encoder.unwrap_or_else(|| pick_encoder(&tool, display));
    let Ok(dir) = app.path().app_cache_dir().map(|dir| dir.join("replay")) else { return };
    let started = encoder.map(|index| record(&tool, &dir, display, &ENCODERS[index]));
    {
        let mut inner = state.lock();
        inner.encoder = Some(encoder);
        match started {
            None => inner.error = Some("No video encoder works on this PC, so NOVA can't record clips.".into()),
            Some(Err(error)) => {
                inner.failures += 1;
                inner.error = Some(error);
            }
            Some(Ok(recorder)) => {
                inner.error = None;
                inner.recorder = Some(recorder);
            }
        }
    }
    emit_status(app);
}

/// The pieces covering the last `seconds`, oldest first: each was last written when it ended.
fn recent_pieces(dir: &Path, seconds: u64, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut pieces: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "ts"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .filter(|(modified, _)| now.duration_since(*modified).map_or(true, |age| age.as_secs() <= seconds + PIECE_SECONDS))
        .collect();
    pieces.sort();
    pieces.into_iter().map(|(_, path)| path).collect()
}

/// A file name Windows accepts.
fn file_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    clean.chars().take(80).collect::<String>().trim_end_matches(['.', ' ']).to_string()
}

#[cfg(windows)]
fn stamp() -> String {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: fills a plain struct.
    let t = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

#[cfg(not(windows))]
fn stamp() -> String {
    String::new()
}

/// Why there is nothing to clip right now, or `None` when the recording runs.
fn not_recording(inner: &Inner, installed: bool) -> Option<String> {
    if !inner.prefs.enabled {
        return Some("Clips are off. The user can turn on \"Clip das\" under Settings → Games & clips; nothing was saved.".into());
    }
    if !installed {
        return Some("Clips are on, but ffmpeg isn't downloaded yet (Settings → Games & clips).".into());
    }
    if inner.recorder.is_none() {
        return Some(match &inner.error {
            Some(error) => format!("Nothing was saved. {error}"),
            None => "Nothing was saved: NOVA only records while a game runs in fullscreen, and for two minutes after.".into(),
        });
    }
    None
}

/// Why a clip didn't work, said to the user in a sentence.
pub fn clip_problem_words<R: Runtime>(app: &AppHandle<R>, de: bool) -> &'static str {
    let installed = ffmpeg(app).is_some();
    let state = app.state::<ReplayState>();
    let inner = state.lock();
    match (inner.prefs.enabled, installed, inner.recorder.is_some()) {
        (false, ..) if de => "Clips sind noch aus. Du schaltest sie in den Einstellungen unter Games & clips ein.",
        (false, ..) => "Clips are off. Turn them on in Settings under Games & clips.",
        (true, false, _) if de => "Für Clips muss ich erst ffmpeg herunterladen, in den Einstellungen unter Games & clips.",
        (true, false, _) => "For clips I need to download ffmpeg first, in Settings under Games & clips.",
        (true, true, false) if de => "Ich nehme gerade nichts auf. Clips gehen, während ein Spiel im Vollbild läuft.",
        (true, true, false) => "I'm not recording right now. Clips work while a game runs in fullscreen.",
        _ if de => "Der Clip hat nicht geklappt.",
        _ => "The clip didn't work.",
    }
}

/// "Clip das!": the last `seconds` into Videos\NOVA Clips. Returns the file.
pub fn clip<R: Runtime>(app: &AppHandle<R>, seconds: u64, name: Option<&str>, game: Option<&str>) -> Result<PathBuf, String> {
    let seconds = seconds.clamp(5, LONGEST_CLIP);
    let tool = ffmpeg(app);
    let dir = {
        let state = app.state::<ReplayState>();
        let inner = state.lock();
        if let Some(reason) = not_recording(&inner, tool.is_some()) {
            return Err(reason);
        }
        inner.recorder.as_ref().map(|r| r.dir.clone()).ok_or("Nothing was saved.")?
    };
    let tool = tool.ok_or("ffmpeg is missing")?;
    let pieces = recent_pieces(&dir, seconds, SystemTime::now());
    if pieces.is_empty() {
        return Err("The recording only just started; nothing to clip yet.".into());
    }
    let list = dir.join("clip.txt");
    let lines: String = pieces.iter().map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', "'\\''"))).collect();
    std::fs::write(&list, lines).map_err(|e| e.to_string())?;
    let folder = clips_folder();
    std::fs::create_dir_all(&folder).map_err(|e| format!("Couldn't create {}: {e}", folder.display()))?;
    let title = name.or(game).map(file_name).filter(|n| !n.is_empty()).unwrap_or_else(|| "Clip".into());
    let mut path = folder.join(format!("{title} {}.mp4", stamp()));
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = folder.join(format!("{title} {} ({n}).mp4", stamp()));
    }
    let mut join = command(&tool);
    join.args(["-f", "concat", "-safe", "0", "-i"]).arg(&list).args(["-c", "copy", "-movflags", "+faststart"]).arg(&path);
    run(join, Duration::from_secs(60)).map_err(|e| format!("The clip couldn't be saved: {e}"))?;
    let length = (pieces.len() as u64 * PIECE_SECONDS).min(seconds + PIECE_SECONDS);
    app.state::<ReplayState>().lock().last_clip = Some((path.clone(), length));
    Ok(path)
}

pub fn last_clip<R: Runtime>(app: &AppHandle<R>) -> Option<(PathBuf, u64)> {
    app.state::<ReplayState>().lock().last_clip.clone().filter(|(path, _)| path.is_file())
}

pub fn discord_name<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let name = app.state::<ReplayState>().lock().prefs.discord_name.clone();
    (credentials_set() && !name.trim().is_empty()).then_some(name)
}

fn credentials_set() -> bool {
    crate::credentials::get(WEBHOOK_TARGET).ok().flatten().is_some()
}

/// Only Discord's own webhook addresses: a clip never goes anywhere else.
pub fn valid_webhook(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return false };
    parsed.scheme() == "https"
        && matches!(parsed.host_str(), Some("discord.com" | "discordapp.com" | "ptb.discord.com" | "canary.discord.com"))
        && parsed.path().starts_with("/api/webhooks/")
        && parsed.path().split('/').filter(|p| !p.is_empty()).count() >= 4
}

/// Bits per second for the video so a clip of `seconds` fits under Discord's limit.
pub fn fitting_bitrate(seconds: u64) -> u64 {
    let total = (DISCORD_LIMIT - 500_000) * 8 / seconds.max(1);
    total.saturating_sub(96_000).max(300_000)
}

/// A smaller copy for Discord: 720p and a bitrate that fits.
fn shrink(tool: &Path, clip: &Path, seconds: u64, codec: &str) -> Result<PathBuf, String> {
    let out = std::env::temp_dir().join("nova-clip-discord.mp4");
    let rate = fitting_bitrate(seconds);
    let mut encode = command(tool);
    encode
        .arg("-y")
        .arg("-i")
        .arg(clip)
        .args(["-vf", "scale=-2:'min(720,ih)'", "-c:v", codec, "-b:v", &rate.to_string(), "-maxrate", &rate.to_string(), "-bufsize", &(rate * 2).to_string()])
        .args(["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
        .arg(&out);
    run(encode, Duration::from_secs(180))?;
    Ok(out)
}

/// Sends the latest clip to the user's Discord channel.
pub async fn send_to_discord<R: Runtime>(app: &AppHandle<R>, message: &str) -> Result<String, String> {
    let webhook = crate::credentials::get(WEBHOOK_TARGET)?.ok_or("No Discord channel is set up. The user adds one under Settings → Games & clips.")?;
    if !valid_webhook(&webhook) {
        return Err("The saved Discord address isn't a Discord webhook.".into());
    }
    let (clip, seconds) = last_clip(app).ok_or("There's no clip to send yet. Say \"Clip das\" first.")?;
    let size = std::fs::metadata(&clip).map_err(|e| e.to_string())?.len();
    let file = if size > DISCORD_LIMIT {
        let tool = ffmpeg(app).ok_or("ffmpeg is missing")?;
        let codec = app.state::<ReplayState>().lock().encoder.flatten().map_or("h264_mf", |i| ENCODERS[i].codec);
        let (clip, codec) = (clip.clone(), codec.to_string());
        tauri::async_runtime::spawn_blocking(move || shrink(&tool, &clip, seconds, &codec)).await.map_err(|e| e.to_string())??
    } else {
        clip.clone()
    };
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DISCORD_LIMIT {
        return Err("The clip is too big for Discord even after making it smaller. Try a shorter one.".into());
    }
    let boundary = format!("nova{}", crate::storage::now_millis());
    let name = clip.file_name().map_or("clip.mp4".into(), |n| n.to_string_lossy().replace('"', ""));
    let mut body = Vec::with_capacity(bytes.len() + 1024);
    write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{}\r\n", serde_json::json!({ "content": message })).map_err(|e| e.to_string())?;
    write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"files[0]\"; filename=\"{name}\"\r\nContent-Type: video/mp4\r\n\r\n").map_err(|e| e.to_string())?;
    body.extend_from_slice(&bytes);
    write!(body, "\r\n--{boundary}--\r\n").map_err(|e| e.to_string())?;
    let response = crate::http::client()
        .post(webhook.trim())
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(crate::http::describe)?;
    if !response.status().is_success() {
        return Err(format!("Discord didn't take the clip ({}).", response.status()));
    }
    Ok(name)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    enabled: bool,
    installed: bool,
    /// Bytes so far while ffmpeg downloads.
    downloading: Option<u64>,
    download_size: u64,
    recording: bool,
    /// Which encoder records ("NVIDIA", "AMD", "Windows"), once known.
    encoder: Option<&'static str>,
    error: Option<String>,
    folder: String,
    discord_name: String,
    discord_set: bool,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> ReplayStatus {
    let installed = ffmpeg(app).is_some();
    let state = app.state::<ReplayState>();
    let inner = state.lock();
    ReplayStatus {
        enabled: inner.prefs.enabled,
        installed,
        downloading: inner.downloading,
        download_size: DOWNLOAD_SIZE,
        recording: inner.recorder.is_some(),
        encoder: inner.encoder.flatten().map(|i| ENCODERS[i].label),
        error: inner.error.clone(),
        folder: clips_folder().to_string_lossy().into_owned(),
        discord_name: inner.prefs.discord_name.clone(),
        discord_set: credentials_set(),
    }
}

fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT_STATUS, status(app));
}

#[tauri::command]
pub async fn replay_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<ReplayStatus> {
    Ok(status(&app))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayUpdate {
    enabled: bool,
    discord_name: String,
}

#[tauri::command]
pub async fn replay_configure<R: Runtime>(app: AppHandle<R>, update: ReplayUpdate) -> CommandResult<ReplayStatus> {
    let prefs = ReplayPrefs { enabled: update.enabled, discord_name: update.discord_name.trim().chars().take(40).collect() };
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json)).map_err(|e| e.to_string())?;
    {
        let state = app.state::<ReplayState>();
        let mut inner = state.lock();
        inner.prefs = prefs;
        inner.failures = 0;
        if !inner.prefs.enabled {
            inner.recorder = None;
        }
    }
    emit_status(&app);
    Ok(status(&app))
}

/// Downloads ffmpeg (once); progress arrives as status events.
#[tauri::command]
pub async fn replay_install<R: Runtime>(app: AppHandle<R>) -> CommandResult<ReplayStatus> {
    {
        let state = app.state::<ReplayState>();
        let mut inner = state.lock();
        if inner.downloading.is_some() || ffmpeg(&app).is_some() {
            drop(inner);
            return Ok(status(&app));
        }
        inner.downloading = Some(0);
        inner.error = None;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let dir = tools_dir(&handle)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let last = Mutex::new(Instant::now());
            let progress = |bytes: u64| {
                let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
                if last.elapsed() > Duration::from_millis(250) {
                    *last = Instant::now();
                    // Reported against the unpacked size; shown against the download.
                    handle.state::<ReplayState>().lock().downloading = Some(bytes * DOWNLOAD_SIZE / FFMPEG.size);
                    emit_status(&handle);
                }
            };
            crate::speech::download::fetch(&FFMPEG, &dir.join(FFMPEG.name), &progress).await
        }
        .await;
        {
            let state = handle.state::<ReplayState>();
            let mut inner = state.lock();
            inner.downloading = None;
            if let Err(error) = outcome {
                inner.error = Some(format!("ffmpeg couldn't be downloaded: {error}"));
            }
        }
        emit_status(&handle);
    });
    Ok(status(&app))
}

#[tauri::command]
pub async fn replay_open_folder() -> CommandResult<()> {
    let folder = clips_folder();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    crate::shell::open_path(&folder)
}

/// Saves the channel's webhook address (in Windows' Credential Manager), or removes it when empty.
#[tauri::command]
pub async fn replay_discord_set<R: Runtime>(app: AppHandle<R>, webhook: String) -> CommandResult<ReplayStatus> {
    let webhook = webhook.trim();
    if webhook.is_empty() {
        crate::credentials::delete(WEBHOOK_TARGET)?;
    } else if valid_webhook(webhook) {
        crate::credentials::set(WEBHOOK_TARGET, webhook)?;
    } else {
        return Err("That isn't a Discord webhook address. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.".into());
    }
    emit_status(&app);
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_discord_webhooks() {
        assert!(valid_webhook("https://discord.com/api/webhooks/123456/abcDEF-xyz"));
        assert!(valid_webhook(" https://canary.discord.com/api/webhooks/1/x "));
        assert!(!valid_webhook("http://discord.com/api/webhooks/1/x"));
        assert!(!valid_webhook("https://discord.com.evil.example/api/webhooks/1/x"));
        assert!(!valid_webhook("https://discord.com/api/webhooks/"));
        assert!(!valid_webhook("https://example.com/api/webhooks/1/x"));
    }

    #[test]
    fn clips_fit_into_discord() {
        // 30 seconds: about 2.4 Mbit/s for the picture, the whole file under the limit.
        let rate = fitting_bitrate(30);
        assert!((30 * (rate + 96_000)) / 8 < DISCORD_LIMIT, "{rate}");
        assert!(rate > 2_000_000);
        assert_eq!(fitting_bitrate(100_000), 300_000);
    }

    #[test]
    fn clip_names_windows_accepts() {
        assert_eq!(file_name("Fortnite: \"Victory\" Royale?"), "Fortnite Victory Royale");
        assert_eq!(file_name("  Monsterkill...  "), "Monsterkill");
    }

    #[test]
    fn takes_the_pieces_of_the_last_seconds() {
        let dir = std::env::temp_dir().join(format!("nova-replay-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..3 {
            std::fs::write(dir.join(format!("piece{i:02}.ts")), b"x").unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::write(dir.join("ffmpeg.log"), b"").unwrap();
        let now = SystemTime::now();
        let names = |list: Vec<PathBuf>| list.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(names(recent_pieces(&dir, 30, now)), ["piece00.ts", "piece01.ts", "piece02.ts"]);
        assert!(recent_pieces(&dir, 30, now + Duration::from_secs(60)).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
