//! Media controls through the Windows global media session (what the
//! volume flyout shows) and the default output device's master volume.
//!
//! Capabilities are reported per player: a control is only offered when the
//! current player says it supports it.

use serde::Serialize;

type CommandResult<T> = Result<T, String>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    source_app_id: String,
    title: String,
    artist: String,
    album: String,
    /// playing | paused | stopped | changing | opened | closed
    status: &'static str,
    can_play_pause: bool,
    can_next: bool,
    can_previous: bool,
    can_seek: bool,
    /// Position at `sampled_at_ms`, extrapolated while playing. `None` when the player does not report a timeline.
    position_ms: Option<u64>,
    duration_ms: Option<u64>,
    sampled_at_ms: u64,
    /// Changes whenever the artwork changes; `None` when there is no artwork.
    artwork_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeState {
    level: f32,
    muted: bool,
}

/// A program's own volume in the Windows mixer, all its sessions together.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioApp {
    /// Program name without ".exe", lower case; "system sounds" for Windows' own.
    pub name: String,
    pub level: f32,
    pub muted: bool,
}

/// A sound output of this PC.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// One line of a song's text; `at_ms` is `None` when the text isn't synced.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    at_ms: Option<u64>,
    text: String,
}

/// The program `wanted` means: its exact name, or the only one containing it.
pub fn pick_audio_app<'a>(apps: &'a [AudioApp], wanted: &str) -> Result<&'a AudioApp, String> {
    let lower = wanted.trim().to_lowercase();
    let lower = lower.strip_suffix(".exe").unwrap_or(&lower);
    if let Some(app) = apps.iter().find(|app| app.name == lower) {
        return Ok(app);
    }
    let similar: Vec<&AudioApp> = apps.iter().filter(|app| app.name.contains(lower)).collect();
    match similar.as_slice() {
        [one] => Ok(*one),
        [] => Err(format!("“{wanted}” isn't making sound right now. These can be changed: {}.", apps.iter().map(|app| app.name.as_str()).collect::<Vec<_>>().join(", "))),
        many => Err(format!("That could be {}.", many.iter().map(|app| app.name.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

/// Videos name the song in their title ("Queen - Radio Ga Ga (Official Video)"), players in their fields.
pub fn song_of(title: &str, artist: &str) -> (String, String) {
    let without_notes = title.split(['(', '[']).next().unwrap_or(title).trim();
    if !artist.trim().is_empty() && !artist.contains(" - Topic") {
        return (without_notes.to_string(), artist.trim().to_string());
    }
    match without_notes.split_once(" - ") {
        Some((artist, song)) => (song.trim().to_string(), artist.trim().to_string()),
        None => (without_notes.to_string(), artist.trim_end_matches(" - Topic").trim().to_string()),
    }
}

/// "[01:23.45] text" lines; lines without a time are left out.
fn parse_synced(text: &str) -> Vec<LyricLine> {
    text.lines()
        .filter_map(|line| {
            let (time, rest) = line.strip_prefix('[')?.split_once(']')?;
            let (minutes, seconds) = time.split_once(':')?;
            let at = minutes.parse::<u64>().ok()? * 60_000 + (seconds.parse::<f64>().ok()? * 1000.0) as u64;
            Some(LyricLine { at_ms: Some(at), text: rest.trim().to_string() })
        })
        .collect()
}

/// A song's text from LRCLIB, a free public database; asked only when the user
/// opens the lyrics. Empty when it doesn't know the song.
async fn lyrics(title: &str, artist: &str, duration_ms: Option<u64>) -> CommandResult<Vec<LyricLine>> {
    let (song, singer) = song_of(title, artist);
    let mut query = vec![("track_name", song.clone()), ("artist_name", singer.clone())];
    query.extend(duration_ms.map(|ms| ("duration", (ms / 1000).to_string())));
    let exact = url::Url::parse_with_params("https://lrclib.net/api/get", &query).map_err(|e| e.to_string())?;
    let found = |value: &serde_json::Value| -> Vec<LyricLine> {
        let synced = value["syncedLyrics"].as_str().map(parse_synced).unwrap_or_default();
        if !synced.is_empty() {
            return synced;
        }
        value["plainLyrics"].as_str().map(|text| text.lines().map(|line| LyricLine { at_ms: None, text: line.trim().to_string() }).collect()).unwrap_or_default()
    };
    let ask = |url: url::Url| async move {
        let response = crate::http::client().get(url).timeout(std::time::Duration::from_secs(10)).send().await.map_err(crate::http::describe)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(serde_json::Value::Null);
        }
        let body = crate::http::read_limited(response, 2 * 1024 * 1024).await?;
        serde_json::from_slice::<serde_json::Value>(&body).map_err(|e| e.to_string())
    };
    let lines = found(&ask(exact).await?);
    if !lines.is_empty() {
        return Ok(lines);
    }
    // The length or the spelling may differ a little.
    let wide = url::Url::parse_with_params("https://lrclib.net/api/search", &[("q", format!("{singer} {song}"))]).map_err(|e| e.to_string())?;
    Ok(ask(wide).await?.as_array().and_then(|results| results.first().map(found)).unwrap_or_default())
}

impl MediaState {
    pub(crate) fn is_playing(&self) -> bool {
        self.status == "playing"
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    pub(crate) fn artist(&self) -> &str {
        &self.artist
    }

    pub(crate) fn source_app_id(&self) -> &str {
        &self.source_app_id
    }

    /// Where it is and how long it is, in milliseconds, when the player tells.
    pub(crate) fn timeline(&self) -> Option<(u64, u64)> {
        self.position_ms.zip(self.duration_ms)
    }

    /// "Song by Artist".
    pub(crate) fn track(&self) -> String {
        if self.artist.is_empty() { self.title.clone() } else { format!("{} by {}", self.title, self.artist) }
    }

    /// "Song by Artist (Spotify, playing)", for NOVA AI.
    pub(crate) fn describe(&self) -> String {
        let source = if self.source_app_id.to_lowercase().contains("spotify") { "Spotify" } else { self.source_app_id.as_str() };
        let by = if self.artist.is_empty() { String::new() } else { format!(" by {}", self.artist) };
        format!("{}{by} ({source}, {})", self.title, self.status)
    }
}

impl VolumeState {
    pub(crate) fn level(&self) -> f32 {
        self.level
    }

    pub(crate) fn describe(&self) -> String {
        format!("Volume {} %{}", (self.level * 100.0).round(), if self.muted { ", muted" } else { "" })
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Converts a Windows FILETIME-style timestamp (100 ns ticks since 1601) to Unix milliseconds.
pub fn filetime_to_unix_ms(ticks: i64) -> Option<u64> {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;
    let ms = ticks / 10_000 - EPOCH_DIFF_MS;
    (ms > 0).then_some(ms as u64)
}

/// Extrapolates the playback position, clamped to the track length.
pub fn extrapolate_position(position_ms: u64, updated_ms: Option<u64>, now_ms: u64, playing: bool, duration_ms: Option<u64>) -> u64 {
    let advanced = match (playing, updated_ms) {
        (true, Some(updated)) if now_ms > updated => position_ms + (now_ms - updated),
        _ => position_ms,
    };
    duration_ms.map_or(advanced, |d| advanced.min(d))
}

#[cfg(windows)]
pub(crate) mod platform {
    use super::*;
    use crate::shell::with_com;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;

    fn err(e: windows::core::Error) -> String {
        e.message().to_string()
    }

    fn current_session() -> CommandResult<Option<Session>> {
        let manager = Manager::RequestAsync().map_err(err)?.join().map_err(err)?;
        Ok(manager.GetCurrentSession().ok())
    }

    pub fn state() -> CommandResult<Option<MediaState>> {
        with_com(false, || {
            let Some(session) = current_session()? else { return Ok(None) };
            let props = session.TryGetMediaPropertiesAsync().map_err(err)?.join().map_err(err)?;
            let playback = session.GetPlaybackInfo().map_err(err)?;
            let controls = playback.Controls().map_err(err)?;
            let status = match playback.PlaybackStatus().map_err(err)? {
                Status::Playing => "playing",
                Status::Paused => "paused",
                Status::Stopped => "stopped",
                Status::Changing => "changing",
                Status::Opened => "opened",
                _ => "closed",
            };

            let now = unix_millis();
            let (position_ms, duration_ms) = match session.GetTimelineProperties() {
                Ok(timeline) => {
                    let ticks = |r: windows::core::Result<windows::Foundation::TimeSpan>| r.map(|t| t.Duration).unwrap_or(0);
                    let start = ticks(timeline.StartTime());
                    let end = ticks(timeline.EndTime());
                    let position = ticks(timeline.Position());
                    let duration = (end > start).then(|| ((end - start) / 10_000) as u64);
                    let updated = timeline.LastUpdatedTime().ok().and_then(|t| filetime_to_unix_ms(t.UniversalTime));
                    let position = duration.map(|_| {
                        extrapolate_position(((position - start).max(0) / 10_000) as u64, updated, now, status == "playing", duration)
                    });
                    (position, duration)
                }
                Err(_) => (None, None),
            };

            let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
            let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
            let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
            let has_artwork = props.Thumbnail().is_ok();
            Ok(Some(MediaState {
                source_app_id: session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default(),
                artwork_key: has_artwork.then(|| crate::apps::stable_id("art", &format!("{title}\u{1f}{artist}\u{1f}{album}"))),
                title,
                artist,
                album,
                status,
                can_play_pause: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
                can_next: controls.IsNextEnabled().unwrap_or(false),
                can_previous: controls.IsPreviousEnabled().unwrap_or(false),
                can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false) && duration_ms.is_some(),
                position_ms,
                duration_ms,
                sampled_at_ms: now,
            }))
        })
    }

    pub fn artwork() -> CommandResult<Option<String>> {
        use base64::Engine;
        with_com(false, || {
            let Some(session) = current_session()? else { return Ok(None) };
            let props = session.TryGetMediaPropertiesAsync().map_err(err)?.join().map_err(err)?;
            let Ok(reference) = props.Thumbnail() else { return Ok(None) };
            let stream = reference.OpenReadAsync().map_err(err)?.join().map_err(err)?;
            let size = stream.Size().map_err(err)?;
            if size == 0 || size > 8 * 1024 * 1024 {
                return Ok(None);
            }
            let content_type = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
            let mime = if content_type.starts_with("image/") { content_type } else { "image/png".into() };
            let reader = DataReader::CreateDataReader(&stream).map_err(err)?;
            reader.LoadAsync(size as u32).map_err(err)?.join().map_err(err)?;
            let mut bytes = vec![0u8; size as usize];
            reader.ReadBytes(&mut bytes).map_err(err)?;
            Ok(Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
        })
    }

    pub fn control(action: &str) -> CommandResult<()> {
        with_com(false, || {
            let session = current_session()?.ok_or("Nothing is playing")?;
            let controls = session.GetPlaybackInfo().map_err(err)?.Controls().map_err(err)?;
            let (supported, operation) = match action {
                "toggle" => (controls.IsPlayPauseToggleEnabled().unwrap_or(false), session.TryTogglePlayPauseAsync()),
                "play" => (controls.IsPlayEnabled().unwrap_or(false), session.TryPlayAsync()),
                "pause" => (controls.IsPauseEnabled().unwrap_or(false), session.TryPauseAsync()),
                "next" => (controls.IsNextEnabled().unwrap_or(false), session.TrySkipNextAsync()),
                "previous" => (controls.IsPreviousEnabled().unwrap_or(false), session.TrySkipPreviousAsync()),
                other => return Err(format!("Unknown media action “{other}”")),
            };
            if !supported {
                return Err("The current player doesn't support this control".into());
            }
            let accepted = operation.map_err(err)?.join().map_err(err)?;
            if accepted {
                Ok(())
            } else {
                Err("The player ignored the request".into())
            }
        })
    }

    /// Jumps to a position in what is playing.
    pub fn seek(position_ms: u64) -> CommandResult<()> {
        with_com(false, || {
            let session = current_session()?.ok_or("Nothing is playing")?;
            let accepted = session.TryChangePlaybackPositionAsync(position_ms as i64 * 10_000).map_err(err)?.join().map_err(err)?;
            if accepted { Ok(()) } else { Err("This player doesn't let NOVA jump around in it".into()) }
        })
    }

    fn all_sessions() -> CommandResult<Vec<Session>> {
        let manager = Manager::RequestAsync().map_err(err)?.join().map_err(err)?;
        Ok(manager.GetSessions().map_err(err)?.into_iter().collect())
    }

    /// Pauses everything that plays, except players whose id contains `keep`.
    pub fn pause_all(keep: Option<&str>) -> CommandResult<()> {
        with_com(false, || {
            for session in all_sessions()? {
                let source = session.SourceAppUserModelId().map(|s| s.to_string().to_lowercase()).unwrap_or_default();
                let playing = session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).is_ok_and(|status| status == Status::Playing);
                if playing && !keep.is_some_and(|keep| source.contains(keep)) {
                    let _ = session.TryPauseAsync().and_then(|operation| operation.join());
                }
            }
            Ok(())
        })
    }

    /// Whether a player shows something whose title fits `fits`: playing, or paused.
    /// A paused one is started with `start`.
    pub fn find_playing(fits: &dyn Fn(&str) -> bool, start: bool) -> CommandResult<Option<bool>> {
        with_com(false, || {
            for session in all_sessions()? {
                let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|operation| operation.join()) else { continue };
                if !fits(&props.Title().map(|s| s.to_string()).unwrap_or_default()) {
                    continue;
                }
                let playing = session.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()).is_ok_and(|status| status == Status::Playing);
                if !playing && start {
                    let _ = session.TryPlayAsync().and_then(|operation| operation.join());
                }
                return Ok(Some(playing));
            }
            Ok(None)
        })
    }

    fn devices_enumerator() -> CommandResult<windows::Win32::Media::Audio::IMMDeviceEnumerator> {
        use windows::Win32::Media::Audio::MMDeviceEnumerator;
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        // SAFETY: called with COM initialized.
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(err)
    }

    /// Runs `visit` on every volume in the mixer of every sound output.
    fn each_session(mut visit: impl FnMut(u32, &windows::Win32::Media::Audio::ISimpleAudioVolume) -> CommandResult<()>) -> CommandResult<()> {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::{eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, ISimpleAudioVolume, DEVICE_STATE_ACTIVE};
        use windows::Win32::System::Com::CLSCTX_ALL;
        // SAFETY: COM calls on interfaces owned here; COM is initialized by the caller.
        unsafe {
            let devices = devices_enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(err)?;
            for index in 0..devices.GetCount().map_err(err)? {
                let Ok(device) = devices.Item(index) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
                for at in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(control) = sessions.GetSession(at) else { continue };
                    if control.GetState().is_ok_and(|state| state == AudioSessionStateExpired) {
                        continue;
                    }
                    let (Ok(details), Ok(volume)) = (control.cast::<IAudioSessionControl2>(), control.cast::<ISimpleAudioVolume>()) else { continue };
                    visit(details.GetProcessId().unwrap_or(0), &volume)?;
                }
            }
        }
        Ok(())
    }

    fn program_of(pid: u32, names: &[(u32, String)]) -> Option<String> {
        if pid == 0 {
            return Some("system sounds".into());
        }
        names.iter().find(|(id, _)| *id == pid).map(|(_, name)| name.clone())
    }

    /// The programs in the Windows mixer, without NOVA itself.
    pub fn audio_apps() -> CommandResult<Vec<AudioApp>> {
        let names = crate::agent::pc::processes()?;
        with_com(false, || {
            let mut apps: Vec<AudioApp> = Vec::new();
            each_session(|pid, volume| {
                let Some(name) = program_of(pid, &names) else { return Ok(()) };
                // SAFETY: a volume interface handed out just now.
                let (level, muted) = unsafe { (volume.GetMasterVolume().unwrap_or(1.0), volume.GetMute().is_ok_and(|m| m.as_bool())) };
                if !apps.iter().any(|app| app.name == name) {
                    apps.push(AudioApp { name, level, muted });
                }
                Ok(())
            })?;
            apps.sort_by(|a, b| (a.name == "system sounds").cmp(&(b.name == "system sounds")).then(a.name.cmp(&b.name)));
            Ok(apps)
        })
    }

    /// Changes one program's own volume.
    pub fn set_audio_app(name: &str, level: Option<f32>, muted: Option<bool>) -> CommandResult<()> {
        let names = crate::agent::pc::processes()?;
        with_com(false, || {
            each_session(|pid, volume| {
                if program_of(pid, &names).as_deref() != Some(name) {
                    return Ok(());
                }
                // SAFETY: a volume interface handed out just now; a null event context is allowed.
                unsafe {
                    if let Some(level) = level {
                        volume.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null()).map_err(err)?;
                    }
                    if let Some(muted) = muted {
                        volume.SetMute(muted, std::ptr::null()).map_err(err)?;
                    }
                }
                Ok(())
            })
        })
    }

    pub fn output_devices() -> CommandResult<Vec<OutputDevice>> {
        use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
        use windows::Win32::Media::Audio::{eConsole, eRender, DEVICE_STATE_ACTIVE};
        use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
        use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};
        with_com(false, || {
            // SAFETY: COM calls on interfaces owned here; strings Windows allocated are copied and freed.
            unsafe {
                let take = |text: windows::core::PWSTR| {
                    let owned = text.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(text.0 as *const _));
                    owned
                };
                let enumerator = devices_enumerator()?;
                let default = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|device| device.GetId().ok()).map(take);
                let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(err)?;
                let mut found = Vec::new();
                for index in 0..devices.GetCount().map_err(err)? {
                    let Ok(device) = devices.Item(index) else { continue };
                    let Ok(id) = device.GetId().map(take) else { continue };
                    let name = device.OpenPropertyStore(STGM_READ).and_then(|store| store.GetValue(&PKEY_Device_FriendlyName)).and_then(|value| PropVariantToStringAlloc(&value)).map(take).unwrap_or_else(|_| "Unknown device".into());
                    found.push(OutputDevice { default: default.as_deref() == Some(id.as_str()), id, name });
                }
                Ok(found)
            }
        })
    }

    /// Windows has no public way to change the default output. This is the interface
    /// its own sound settings use; checked by reading the default back.
    pub fn set_output_device(id: &str) -> CommandResult<()> {
        use windows::core::{IUnknown, Interface, GUID, HRESULT, PCWSTR};
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        const POLICY_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
        const POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
        /// IUnknown's three methods, ten that NOVA doesn't use, then this one.
        #[repr(C)]
        struct Table {
            _before: [usize; 13],
            set_default_endpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, u32) -> HRESULT,
        }
        let wide: Vec<u16> = id.encode_utf16().chain([0]).collect();
        with_com(false, || {
            // SAFETY: the table matches IPolicyConfig for this id on every Windows since Vista;
            // the pointer from `query` holds a reference that `from_raw` hands back.
            unsafe {
                let client: IUnknown = CoCreateInstance(&POLICY_CLIENT, None, CLSCTX_ALL).map_err(err)?;
                let mut raw = std::ptr::null_mut();
                client.query(&POLICY_CONFIG, &mut raw).ok().map_err(err)?;
                let policy = IUnknown::from_raw(raw);
                let table = *(raw as *const *const Table);
                // Console, multimedia and communications: all that Windows distinguishes.
                for role in 0..3 {
                    ((*table).set_default_endpoint)(policy.as_raw(), PCWSTR(wide.as_ptr()), role).ok().map_err(err)?;
                }
            }
            Ok(())
        })?;
        if output_devices()?.iter().any(|device| device.default && device.id == id) { Ok(()) } else { Err("Windows didn't switch the output".into()) }
    }

    fn endpoint_volume() -> CommandResult<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
        use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
        use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
        // SAFETY: called with COM initialized; interfaces are reference counted by the bindings.
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(err)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "No audio output device".to_string())?;
            device.Activate(CLSCTX_ALL, None).map_err(err)
        }
    }

    pub fn volume() -> CommandResult<VolumeState> {
        with_com(false, || {
            let endpoint = endpoint_volume()?;
            // SAFETY: valid interface obtained above.
            unsafe {
                Ok(VolumeState {
                    level: endpoint.GetMasterVolumeLevelScalar().map_err(err)?,
                    muted: endpoint.GetMute().map_err(err)?.as_bool(),
                })
            }
        })
    }

    pub fn set_volume(level: Option<f32>, muted: Option<bool>) -> CommandResult<VolumeState> {
        with_com(false, || {
            let endpoint = endpoint_volume()?;
            // SAFETY: valid interface; a null event context is allowed by the API.
            unsafe {
                if let Some(level) = level {
                    endpoint.SetMasterVolumeLevelScalar(level.clamp(0.0, 1.0), std::ptr::null()).map_err(err)?;
                }
                if let Some(muted) = muted {
                    endpoint.SetMute(muted, std::ptr::null()).map_err(err)?;
                }
            }
            Ok(())
        })?;
        volume()
    }
}

#[cfg(not(windows))]
pub(crate) mod platform {
    use super::*;
    const UNSUPPORTED: &str = "Media controls require Windows";
    pub fn state() -> CommandResult<Option<MediaState>> {
        Err(UNSUPPORTED.into())
    }
    pub fn artwork() -> CommandResult<Option<String>> {
        Err(UNSUPPORTED.into())
    }
    pub fn control(_: &str) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
    pub fn volume() -> CommandResult<VolumeState> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_volume(_: Option<f32>, _: Option<bool>) -> CommandResult<VolumeState> {
        Err(UNSUPPORTED.into())
    }
    pub fn seek(_: u64) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
    pub fn pause_all(_: Option<&str>) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
    pub fn find_playing(_: &dyn Fn(&str) -> bool, _: bool) -> CommandResult<Option<bool>> {
        Err(UNSUPPORTED.into())
    }
    pub fn audio_apps() -> CommandResult<Vec<AudioApp>> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_audio_app(_: &str, _: Option<f32>, _: Option<bool>) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
    pub fn output_devices() -> CommandResult<Vec<OutputDevice>> {
        Err(UNSUPPORTED.into())
    }
    pub fn set_output_device(_: &str) -> CommandResult<()> {
        Err(UNSUPPORTED.into())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CommandResult<T> + Send + 'static) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_state() -> CommandResult<Option<MediaState>> {
    blocking(platform::state).await
}

#[tauri::command]
pub async fn media_artwork() -> CommandResult<Option<String>> {
    blocking(platform::artwork).await
}

#[tauri::command]
pub async fn media_control(action: String) -> CommandResult<()> {
    blocking(move || platform::control(&action)).await
}

#[tauri::command]
pub async fn media_volume() -> CommandResult<VolumeState> {
    blocking(platform::volume).await
}

#[tauri::command]
pub async fn media_volume_set(level: Option<f32>, muted: Option<bool>) -> CommandResult<VolumeState> {
    blocking(move || platform::set_volume(level, muted)).await
}

#[tauri::command]
pub async fn media_seek(position_ms: u64) -> CommandResult<()> {
    blocking(move || platform::seek(position_ms)).await
}

#[tauri::command]
pub async fn media_mixer() -> CommandResult<Vec<AudioApp>> {
    blocking(platform::audio_apps).await
}

#[tauri::command]
pub async fn media_mixer_set(name: String, level: Option<f32>, muted: Option<bool>) -> CommandResult<()> {
    blocking(move || platform::set_audio_app(&name, level, muted)).await
}

#[tauri::command]
pub async fn media_outputs() -> CommandResult<Vec<OutputDevice>> {
    blocking(platform::output_devices).await
}

#[tauri::command]
pub async fn media_output_set(id: String) -> CommandResult<()> {
    blocking(move || platform::set_output_device(&id)).await
}

#[tauri::command]
pub async fn media_lyrics(title: String, artist: String, duration_ms: Option<u64>) -> CommandResult<Vec<LyricLine>> {
    lyrics(&title, &artist, duration_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_filetime() {
        // 2026-01-01T00:00:00Z
        assert_eq!(filetime_to_unix_ms(134_116_992_000_000_000), Some(1_767_225_600_000));
        assert_eq!(filetime_to_unix_ms(0), None);
    }

    #[test]
    fn extrapolates_only_while_playing() {
        assert_eq!(extrapolate_position(10_000, Some(1_000), 3_000, true, Some(60_000)), 12_000);
        assert_eq!(extrapolate_position(10_000, Some(1_000), 3_000, false, Some(60_000)), 10_000);
        assert_eq!(extrapolate_position(59_000, Some(1_000), 9_000, true, Some(60_000)), 60_000);
        assert_eq!(extrapolate_position(10_000, None, 3_000, true, None), 10_000);
    }

    #[test]
    fn finds_programs_in_the_mixer() {
        let app = |name: &str| AudioApp { name: name.into(), level: 1.0, muted: false };
        let apps = [app("discord"), app("fortniteclient-win64-shipping"), app("opera"), app("operagx")];
        assert_eq!(pick_audio_app(&apps, "Discord").unwrap().name, "discord");
        assert_eq!(pick_audio_app(&apps, "discord.exe").unwrap().name, "discord");
        assert_eq!(pick_audio_app(&apps, "fortnite").unwrap().name, "fortniteclient-win64-shipping");
        assert_eq!(pick_audio_app(&apps, "opera").unwrap().name, "opera", "exact beats similar");
        assert!(pick_audio_app(&apps, "oper").unwrap_err().contains("could be"));
        assert!(pick_audio_app(&apps, "spotify").unwrap_err().contains("discord"));
    }

    #[test]
    fn reads_the_song_out_of_a_title() {
        assert_eq!(song_of("Blinding Lights", "The Weeknd"), ("Blinding Lights".into(), "The Weeknd".into()));
        assert_eq!(song_of("Queen - Radio Ga Ga (Official Video)", ""), ("Radio Ga Ga".into(), "Queen".into()));
        assert_eq!(song_of("Radio Ga Ga [Remastered]", "Queen - Topic"), ("Radio Ga Ga".into(), "Queen".into()));
        assert_eq!(song_of("Nur ein Titel", ""), ("Nur ein Titel".into(), String::new()));
    }

    #[test]
    fn parses_synced_lyrics() {
        let lines = parse_synced("[00:13.13] Erste Zeile\n[01:02.50]\nkeine Zeit\n[kaputt] x");
        assert_eq!(lines, [LyricLine { at_ms: Some(13_130), text: "Erste Zeile".into() }, LyricLine { at_ms: Some(62_500), text: String::new() }]);
    }

    /// Against this PC's real mixer: every value is set to what it already is, so nothing
    /// changes. `cargo test --lib -- --ignored mixer_live --nocapture`
    #[test]
    #[ignore]
    fn mixer_live() {
        let apps = platform::audio_apps().unwrap();
        eprintln!("{apps:#?}");
        for app in &apps {
            platform::set_audio_app(&app.name, Some(app.level), Some(app.muted)).unwrap();
        }
        assert_eq!(platform::audio_apps().unwrap().len(), apps.len());
        let devices = platform::output_devices().unwrap();
        eprintln!("{devices:#?}");
        let current = devices.iter().find(|device| device.default).expect("a default output");
        platform::set_output_device(&current.id).unwrap();
        assert!(platform::output_devices().unwrap().iter().any(|device| device.default && device.id == current.id));
    }

    #[test]
    fn state_query_does_not_fail() {
        // Environment-dependent: nothing playing is a valid `None`.
        assert!(platform::state().is_ok());
    }

    #[test]
    fn rejects_unknown_actions() {
        if let Err(message) = platform::control("explode") {
            assert!(message.contains("Unknown") || message.contains("Nothing is playing"));
        }
    }
}
