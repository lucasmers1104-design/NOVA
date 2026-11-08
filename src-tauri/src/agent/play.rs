//! While a game is in front (Windows reports a fullscreen app) and two minutes
//! after: which game it is and since when ("Wie lange zock ich schon?"), and
//! what the PC did in the last two minutes, second by second ("Was hat da eben
//! geruckelt?"). The replay buffer for clips follows the same rhythm. Nothing
//! of this runs while no game is in front.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{CpuRefreshKind, Gpus, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Runtime};

/// How long after the game leaves the front NOVA keeps watching (alt-tab, "clip das" right after).
const LINGER: Duration = Duration::from_secs(120);
/// Seconds of history for "what just stuttered".
const HISTORY: usize = 120;
/// Disk activity worth naming (bytes per second).
const BUSY_DISK: u64 = 20 << 20;
/// Fullscreen browsers, players and slides are videos and presentations, not games.
const NOT_GAMES: &[&str] = &[
    "chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "arc", "vlc", "mpc-hc64", "mpc-be64", "potplayermini64", "wmplayer", "video.ui", "microsoft.media.player", "netflix", "powerpnt", "nova", "explorer",
];

/// The game in front, or the last one.
#[derive(Debug, Clone, PartialEq)]
pub struct Game {
    pub title: String,
    pub pid: u32,
    /// Unix seconds the game's process started.
    pub started: u64,
    /// Unix seconds it was gone, once it is.
    pub ended: Option<u64>,
}

/// One second of the PC.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub at: u64,
    pub cpu: f32,
    pub gpu: Option<f32>,
    pub memory: f32,
    /// The three programs using the most CPU (share of the whole CPU).
    pub top: Vec<(String, f32)>,
    /// Programs reading or writing a lot (bytes per second).
    pub disk: Vec<(String, u64)>,
    /// Programs that started since the second before.
    pub started: Vec<String>,
}

#[derive(Default)]
pub struct PlayState {
    inner: Mutex<(Option<Game>, VecDeque<Sample>)>,
}

impl PlayState {
    fn lock(&self) -> std::sync::MutexGuard<'_, (Option<Game>, VecDeque<Sample>)> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

struct Sampler {
    sys: System,
    gpus: Option<Gpus>,
    pids: HashSet<u32>,
}

impl Sampler {
    fn new() -> Option<Self> {
        let mut sys = System::new().ok()?;
        sys.refresh_cpu_list(CpuRefreshKind::nothing().with_usage());
        Some(Self { sys, gpus: Gpus::new_with_refreshed_list().ok(), pids: HashSet::new() })
    }

    fn sample(&mut self) -> Sample {
        let first = self.pids.is_empty();
        self.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_usage());
        self.sys.refresh_memory();
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_disk_usage());
        let cores = self.sys.cpus().len().max(1) as f32;
        let mut programs: Vec<(String, f32, u64)> = Vec::new();
        let mut started = Vec::new();
        let mut pids = HashSet::new();
        for process in self.sys.processes().values().filter(|p| p.pid().as_u32() != 0) {
            let name = super::pc::stem(&process.name().to_string_lossy());
            pids.insert(process.pid().as_u32());
            if !first && !self.pids.contains(&process.pid().as_u32()) && started.len() < 5 && !started.contains(&name) {
                started.push(name.clone());
            }
            let disk = process.disk_usage();
            let (cpu, io) = ((process.cpu_usage() / cores).clamp(0.0, 100.0), disk.read_bytes + disk.written_bytes);
            match programs.iter_mut().find(|(n, ..)| *n == name) {
                Some(program) => {
                    program.1 += cpu;
                    program.2 += io;
                }
                None => programs.push((name, cpu, io)),
            }
        }
        self.pids = pids;
        programs.sort_by(|a, b| b.1.total_cmp(&a.1));
        let top = programs.iter().filter(|p| p.1 >= 1.0).take(3).map(|p| (p.0.clone(), p.1)).collect();
        programs.sort_by_key(|p| std::cmp::Reverse(p.2));
        let disk = programs.iter().filter(|p| p.2 >= BUSY_DISK).take(2).map(|p| (p.0.clone(), p.2)).collect();
        let gpu = self.gpus.as_mut().and_then(|gpus| {
            gpus.refresh(true);
            (&*gpus).into_iter().filter_map(|g| g.usage().filter(|u| u.is_finite())).reduce(f32::max)
        });
        let total = self.sys.total_memory().max(1) as f32;
        Sample { at: now_secs(), cpu: self.sys.global_cpu_usage().clamp(0.0, 100.0), gpu, memory: self.sys.used_memory() as f32 * 100.0 / total, top, disk, started }
    }

    fn started(&self, pid: u32) -> Option<u64> {
        self.sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.start_time())
    }
}

/// The window in front as a game: its title and process, unless it is a browser or player.
fn game_in_front() -> Option<(String, u32)> {
    let window = super::pc::windows().into_iter().find(|w| w.foreground)?;
    (!NOT_GAMES.contains(&window.process.as_str()) && !window.title.trim().is_empty()).then(|| (window.title.trim().to_string(), window.app_pid))
}

/// Starts the background thread: once a second, but only works while a game is in front.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = tauri::Manager::state::<PlayState>(&app);
        let mut until: Option<Instant> = None;
        let mut sampler: Option<Sampler> = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            // Windows' "fullscreen app" also means videos and presentations: only a game counts.
            let front = crate::assistant::fullscreen_in_front().then(game_in_front).flatten();
            if front.is_some() {
                until = Some(Instant::now() + LINGER);
            }
            let active = until.is_some_and(|t| Instant::now() < t);
            if !active {
                sampler = None;
                crate::replay::follow(&app, false);
                continue;
            }
            if sampler.is_none() {
                sampler = Sampler::new();
            }
            let Some(sampler) = sampler.as_mut() else { continue };
            let sample = sampler.sample();
            {
                let mut inner = state.lock();
                if let Some((title, pid)) = front {
                    if inner.0.as_ref().is_none_or(|g| g.pid != pid) {
                        inner.0 = Some(Game { title, pid, started: sampler.started(pid).unwrap_or_else(now_secs), ended: None });
                    }
                }
                if let Some(game) = inner.0.as_mut().filter(|g| g.ended.is_none() && sampler.started(g.pid).is_none()) {
                    game.ended = Some(now_secs());
                }
                inner.1.push_back(sample);
                while inner.1.len() > HISTORY {
                    inner.1.pop_front();
                }
            }
            crate::replay::follow(&app, true);
        }
    });
}

/// "1 h 23 min".
pub fn duration_words(seconds: u64) -> String {
    let minutes = seconds / 60;
    match (minutes / 60, minutes % 60) {
        (0, 0) => "less than a minute".into(),
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// What the model reads for "Wie lange zock ich schon?".
pub fn game_time(game: Option<&Game>, now: u64) -> String {
    match game {
        None => "No game has been in front since NOVA started. NOVA notices games once they run in fullscreen while NOVA runs.".into(),
        Some(game) => match game.ended {
            None => format!("{} is running. It started {} ago.", game.title, duration_words(now.saturating_sub(game.started))),
            Some(ended) => format!(
                "{} isn't running anymore. It ran for {} and ended {} ago.",
                game.title,
                duration_words(ended.saturating_sub(game.started)),
                duration_words(now.saturating_sub(ended))
            ),
        },
    }
}

/// A game command NOVA carries out at once, without asking the AI: mid-game,
/// "Clip das" has to be quick, and both work without an AI key.
#[derive(Debug, PartialEq)]
pub enum Quick {
    Clip { seconds: u64, name: Option<String> },
    Send,
}

/// "Clip das", "Clip die letzten 20 Sekunden, nenn es Monsterkill", or "Schick
/// das an die Jungs" when "die Jungs" is the name the user gave their Discord channel.
pub fn quick(text: &str, discord_name: Option<&str>) -> Option<Quick> {
    let lower = text.to_lowercase();
    let all: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
    let words = match all.as_slice() {
        ["hey" | "hallo" | "okay" | "ok", "nova", rest @ ..] | ["nova", rest @ ..] => rest,
        rest => rest,
    };
    let first = *words.first()?;
    if ["clip", "clipp", "clippe", "clippen"].contains(&first) && words.len() <= 12 {
        let number = words.windows(2).find_map(|w| w[0].parse::<u64>().ok().filter(|_| ["sekunden", "seconds", "sek", "secs"].contains(&w[1])));
        let minute = words.contains(&"minute");
        let seconds = number.or(minute.then_some(60)).unwrap_or(crate::replay::DEFAULT_CLIP);
        let name = ["nenn es ", "nenne es ", "nenn ihn ", "name it ", "call it "].iter().find_map(|marker| {
            let at = lower.find(marker)? + marker.len();
            let name = text.get(at..)?.trim().trim_matches(|c: char| !c.is_alphanumeric()).to_string();
            (!name.is_empty()).then_some(name)
        });
        return Some(Quick::Clip { seconds, name });
    }
    let sends = ["schick", "schicke", "sende", "send", "teil", "teile", "poste", "post"].contains(&first) && words.len() <= 10;
    let target = discord_name.map(|name| name.trim().to_lowercase()).filter(|name| !name.is_empty());
    (sends && (lower.contains("discord") || target.is_some_and(|name| lower.contains(&name)))).then_some(Quick::Send)
}

pub fn current_game<R: Runtime>(app: &AppHandle<R>) -> Option<Game> {
    tauri::Manager::state::<PlayState>(app).lock().0.clone()
}

pub fn history<R: Runtime>(app: &AppHandle<R>) -> Vec<Sample> {
    tauri::Manager::state::<PlayState>(app).lock().1.iter().cloned().collect()
}

fn names(list: &[(String, f32)]) -> String {
    list.iter().map(|(name, cpu)| format!("{name} {cpu:.0} %")).collect::<Vec<_>>().join(", ")
}

/// What the model reads for "Was hat da eben geruckelt?": the trend in steps of
/// ten seconds, then every moment that stood out.
pub fn recent_load(samples: &[Sample], now: u64) -> String {
    if samples.is_empty() {
        return "NOVA has no record: it only keeps one while a game runs in fullscreen and for two minutes after. Use task_manager for the PC right now.".into();
    }
    let ago = |at: u64| format!("{} s ago", now.saturating_sub(at));
    let mut lines = vec![format!("The PC over the last {} seconds, oldest first, every 10 s (CPU, GPU, RAM in % of all):", samples.len())];
    for chunk in samples.chunks(10) {
        let peak = |f: &dyn Fn(&Sample) -> f32| chunk.iter().map(f).fold(0.0, f32::max);
        let gpu = chunk.iter().filter_map(|s| s.gpu).reduce(f32::max).map_or("?".to_string(), |g| format!("{g:.0}"));
        lines.push(format!("- {}: CPU up to {:.0}, GPU up to {gpu}, RAM {:.0}", ago(chunk[0].at), peak(&|s| s.cpu), peak(&|s| s.memory)));
    }
    let mut notes = Vec::new();
    let usual_cpu = { let mut cpu: Vec<f32> = samples.iter().map(|s| s.cpu).collect(); cpu.sort_by(f32::total_cmp); cpu[cpu.len() / 2] };
    for sample in samples {
        let mut said = Vec::new();
        if sample.cpu >= 90.0 || sample.cpu >= usual_cpu + 25.0 {
            said.push(format!("CPU {:.0} % ({})", sample.cpu, names(&sample.top)));
        }
        if sample.memory >= 92.0 {
            said.push(format!("RAM {:.0} % full", sample.memory));
        }
        if !sample.disk.is_empty() {
            said.push(format!("disk busy: {}", sample.disk.iter().map(|(n, b)| format!("{n} {} MB/s", b >> 20)).collect::<Vec<_>>().join(", ")));
        }
        if !sample.started.is_empty() {
            said.push(format!("started: {}", sample.started.join(", ")));
        }
        if !said.is_empty() {
            notes.push(format!("- {}: {}", ago(sample.at), said.join("; ")));
        }
    }
    lines.push(String::new());
    if notes.is_empty() {
        lines.push("Nothing stood out: no CPU spike, full memory, busy disk or newly started program.".into());
    } else {
        lines.push("Moments that stood out:".into());
        lines.extend(notes.into_iter().rev().take(15).rev());
    }
    lines.push("\nNOVA can't see the game's frame rate or network lag; this is what the PC did. A GPU at 95-100 % means the game asks more than the graphics card gives: lower settings help.".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at: u64, cpu: f32) -> Sample {
        Sample { at, cpu, gpu: Some(60.0), memory: 50.0, top: vec![("fortniteclient-win64-shipping".into(), cpu / 2.0)], disk: vec![], started: vec![] }
    }

    #[test]
    fn tells_how_long_the_game_runs() {
        assert_eq!(duration_words(30), "less than a minute");
        assert_eq!(duration_words(83 * 60 + 5), "1 h 23 min");
        let game = Game { title: "Fortnite".into(), pid: 1, started: 1000, ended: None };
        assert_eq!(game_time(Some(&game), 1000 + 7200), "Fortnite is running. It started 2 h ago.");
        let ended = Game { ended: Some(1000 + 3600), ..game };
        assert!(game_time(Some(&ended), 1000 + 3900).contains("ran for 1 h and ended 5 min ago"));
        assert!(game_time(None, 0).starts_with("No game"));
    }

    #[test]
    fn understands_game_commands_at_once() {
        let clip = |seconds, name: Option<&str>| Some(Quick::Clip { seconds, name: name.map(str::to_string) });
        assert_eq!(quick("Clip das!", None), clip(30, None));
        assert_eq!(quick("Hey Nova, clip das", None), clip(30, None));
        assert_eq!(quick("Clip die letzten 20 Sekunden", None), clip(20, None));
        assert_eq!(quick("Clip die letzte Minute", None), clip(60, None));
        assert_eq!(quick("Clip das, nenn es Monsterkill!", None), clip(30, Some("Monsterkill")));
        assert_eq!(quick("Schick das an die Jungs", Some("die Jungs")), Some(Quick::Send));
        assert_eq!(quick("Schick den Clip auf Discord", None), Some(Quick::Send));
        // Not the channel: the AI decides.
        assert_eq!(quick("Schick das an Mama", Some("die Jungs")), None);
        assert_eq!(quick("Wie lange zock ich schon?", None), None);
        assert_eq!(quick("Was ist ein Clip?", None), None);
    }

    #[test]
    fn names_what_stood_out() {
        let mut samples: Vec<Sample> = (0..30).map(|i| sample(100 + i, 40.0)).collect();
        samples[20] = Sample { cpu: 97.0, top: vec![("msmpeng".into(), 55.0)], started: vec!["tiworker".into()], disk: vec![("msmpeng".into(), 80 << 20)], ..sample(120, 97.0) };
        let text = recent_load(&samples, 130);
        assert!(text.contains("- 10 s ago: CPU 97 % (msmpeng 55 %); disk busy: msmpeng 80 MB/s; started: tiworker"), "{text}");
        assert_eq!(text.lines().filter(|line| line.contains("CPU up to")).count(), 3);
        assert!(recent_load(&samples[..5].iter().map(|s| sample(s.at, 40.0)).collect::<Vec<_>>(), 110).contains("Nothing stood out"));
        assert!(recent_load(&[], 0).contains("no record"));
    }
}
