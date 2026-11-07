//! NOVA acting by itself: routines (several steps on one word, or on a schedule),
//! watchers (it keeps an eye on something and says when it happens), and what played
//! lately. All of it runs from one background thread, only while NOVA runs. Saving
//! a routine or a watcher is what the user approves, with every step listed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::memory::EVENT_CHANGED;
use super::{games, pc, tidy, tools, youtube};
use crate::storage::{self, now_millis, Database};

const KEY: &str = "nova.automation";
const PLAYED_KEY: &str = "nova.played";
/// How often the thread looks.
const TICK: Duration = Duration::from_secs(15);
/// How often a channel is asked for new videos.
const CHANNEL_EVERY: Duration = Duration::from_secs(30 * 60);
/// Load has to stay this many ticks over the limit: a spike isn't worth a word.
const SUSTAINED_TICKS: u32 = 4;
const MOST_ROUTINES: usize = 50;
const MOST_WATCHERS: usize = 30;
const MOST_STEPS: usize = 20;
const MOST_PLAYED: usize = 50;
const LONGEST_WAIT: u64 = 120;
const LONGEST_NAME: usize = 60;
const LONGEST_SAY: usize = 200;
const LONGEST_PROMPT: usize = 2000;
/// A step on a schedule runs right at its time. A question to NOVA, such as a morning
/// briefing, still counts when the PC came on a little later.
const STEPS_LATE_MINUTES: u32 = 2;
const PROMPT_LATE_MINUTES: u32 = 120;

/// What a routine may do without asking each time. Nothing here deletes, reads
/// private things or types into other apps.
const ROUTINE_TOOLS: &[&str] = &["open_app", "open_website", "start_game", "media_control", "spotify_play", "youtube", "app_volume", "audio_output", "timer", "window_action", "end_process", "power", "wait"];

// ---------------------------------------------------------------------------
// What is saved
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub tool: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Routine {
    pub id: String,
    pub name: String,
    pub steps: Vec<Step>,
    /// Asked of NOVA when it runs, e.g. a briefing.
    pub prompt: Option<String>,
    /// "HH:MM"; without one it only runs when asked.
    pub time: Option<String>,
    /// 0 is Sunday; empty means every day.
    pub days: Vec<u8>,
    pub last_run: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Condition {
    /// A game has finished downloading or updating.
    GameReady { game: String },
    /// A game needs an update, or has started one.
    GameUpdate { game: String },
    CpuAbove { percent: f32 },
    MemoryAbove { percent: f32 },
    TemperatureAbove { celsius: f32 },
    /// Free space on the Windows drive.
    DiskBelow { gigabytes: f64 },
    ProgramStarts { program: String },
    ProgramEnds { program: String },
    /// The browser's downloads in the Downloads folder are finished.
    DownloadsDone,
    NewVideo { channel_id: String, channel: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watcher {
    pub id: String,
    /// What NOVA says when it happens, in the user's language.
    pub say: String,
    pub condition: Condition,
    /// Keeps watching afterwards; otherwise it's done after once.
    #[serde(default)]
    pub repeat: bool,
    /// A routine to run when it happens.
    #[serde(default)]
    pub routine: Option<String>,
    /// It wasn't so last time, so it counts when it becomes so.
    #[serde(default)]
    pub armed: bool,
    /// The newest video seen, for `NewVideo`.
    #[serde(default)]
    pub seen: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Automation {
    pub routines: Vec<Routine>,
    pub watchers: Vec<Watcher>,
}

/// Only one at a time reads, changes and writes: the thread and the commands.
static SAVING: Mutex<()> = Mutex::new(());

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Automation {
    app.state::<Database>().with(|c| storage::kv_get(c, KEY)).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

fn change<R: Runtime, T>(app: &AppHandle<R>, work: impl FnOnce(&mut Automation) -> Result<T, String>) -> Result<T, String> {
    let _saving = SAVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = load(app);
    let mut automation = before.clone();
    let result = work(&mut automation)?;
    if automation == before {
        return Ok(result);
    }
    let raw = serde_json::to_string(&automation).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, KEY, &raw))?;
    let _ = app.emit(EVENT_CHANGED, ());
    Ok(result)
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/// What the model asked for, checked. Refuses what a routine may not do, before the user is asked.
pub fn checked_routine(name: &str, steps: &Value, prompt: Option<&str>, time: Option<&str>, days: &Value) -> Result<Routine, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > LONGEST_NAME {
        return Err(format!("A routine needs a name of at most {LONGEST_NAME} characters"));
    }
    let steps: Vec<Step> = match steps {
        Value::Null => Vec::new(),
        other => serde_json::from_value(other.clone()).map_err(|_| "Each step needs a tool and its input".to_string())?,
    };
    if steps.len() > MOST_STEPS {
        return Err(format!("A routine can have at most {MOST_STEPS} steps"));
    }
    for step in &steps {
        if !ROUTINE_TOOLS.contains(&step.tool.as_str()) {
            return Err(format!("“{}” can't be part of a routine, because it would run without asking. These can: {}.", step.tool, ROUTINE_TOOLS.join(", ")));
        }
        if step.tool == "end_process" && step.input["force"].as_bool() == Some(true) {
            return Err("A routine can't force programs to quit, because unsaved work would be lost.".into());
        }
    }
    let prompt = prompt.map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
    if prompt.as_ref().is_some_and(|p| p.chars().count() > LONGEST_PROMPT) {
        return Err(format!("A routine's prompt can have at most {LONGEST_PROMPT} characters"));
    }
    if steps.is_empty() && prompt.is_none() {
        return Err("A routine needs steps or a prompt".into());
    }
    if let Some(time) = time {
        if minutes_of(time).is_none() {
            return Err("The time must be HH:MM".into());
        }
    }
    let days: Vec<u8> = days.as_array().map(|list| list.iter().filter_map(|day| day.as_u64()).filter(|day| *day < 7).map(|day| day as u8).collect()).unwrap_or_default();
    Ok(Routine { id: storage::new_id("routine"), name: name.to_string(), steps, prompt, time: time.map(str::to_string), days, last_run: None })
}

/// One step in plain words, for the user's OK.
pub fn step_words(step: &Step) -> String {
    let input = step.input.as_object().map(|fields| fields.iter().map(|(key, value)| format!("{key}: {}", value.as_str().map_or_else(|| value.to_string(), str::to_string))).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    if input.is_empty() { step.tool.clone() } else { format!("{} ({input})", step.tool) }
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

pub fn schedule_words(routine: &Routine) -> Option<String> {
    let time = routine.time.as_ref()?;
    let days = if routine.days.is_empty() { "every day".to_string() } else { routine.days.iter().map(|day| DAY_NAMES[*day as usize % 7]).collect::<Vec<_>>().join(", ") };
    Some(format!("{days} at {time}"))
}

pub fn pick_routine(routines: &[Routine], wanted: &str) -> Result<Routine, String> {
    let lower = wanted.trim().to_lowercase();
    if let Some(routine) = routines.iter().find(|r| r.id == wanted || r.name.to_lowercase() == lower) {
        return Ok(routine.clone());
    }
    let similar: Vec<&Routine> = routines.iter().filter(|r| r.name.to_lowercase().contains(&lower)).collect();
    match similar.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("There is no routine called “{wanted}”. There are: {}.", if routines.is_empty() { "none yet".to_string() } else { routines.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ") })),
        many => Err(format!("That could be {}.", many.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

pub fn save_routine<R: Runtime>(app: &AppHandle<R>, routine: Routine) -> Result<(), String> {
    let today = Clock::now();
    change(app, |automation| {
        let mut routine = routine;
        // A time already gone today starts tomorrow, rather than right now.
        if routine.time.as_deref().and_then(minutes_of).is_some_and(|at| at <= today.minutes) {
            routine.last_run = Some(today.date.clone());
        }
        // Saving under the same name replaces it.
        if let Some(known) = automation.routines.iter_mut().find(|known| known.name.eq_ignore_ascii_case(&routine.name)) {
            *known = routine;
            return Ok(());
        }
        if automation.routines.len() >= MOST_ROUTINES {
            return Err(format!("NOVA keeps {MOST_ROUTINES} routines at most. Delete one first."));
        }
        automation.routines.push(routine);
        Ok(())
    })
}

pub fn delete_routine<R: Runtime>(app: &AppHandle<R>, wanted: &str) -> Result<String, String> {
    let routine = pick_routine(&load(app).routines, wanted)?;
    change(app, |automation| {
        automation.routines.retain(|known| known.id != routine.id);
        Ok(routine.name.clone())
    })
}

/// Runs the steps one after another; each step's own checks still apply, and one
/// that fails doesn't stop the others. Returns what happened, for each step.
pub fn run_steps<R: Runtime>(app: &AppHandle<R>, routine: &Routine) -> Vec<(String, Result<String, String>)> {
    let mut report = Vec::new();
    let waited = Instant::now();
    for step in &routine.steps {
        if step.tool == "wait" {
            let seconds = step.input["seconds"].as_u64().unwrap_or(1).min(LONGEST_WAIT);
            if waited.elapsed() < Duration::from_secs(LONGEST_WAIT) {
                std::thread::sleep(Duration::from_secs(seconds));
            }
            continue;
        }
        if !ROUTINE_TOOLS.contains(&step.tool.as_str()) {
            report.push((step.tool.clone(), Err("not allowed in a routine".to_string())));
            continue;
        }
        let outcome = tools::prepare(app, &step.tool, &step.input).and_then(|prepared| {
            let done = tools::execute(app, &prepared.action).map(|outcome| outcome.summary);
            let _ = app.state::<Database>().with(|c| storage::actions::log(c, &step.tool, &prepared.title, prepared.risk.as_str(), if done.is_ok() { "done" } else { "failed" }, &format!("Routine “{}”", routine.name)));
            crate::telemetry::track(app, crate::telemetry::Event::Tool { name: &step.tool, outcome: i64::from(done.is_ok()) });
            done
        });
        report.push((step.tool.clone(), outcome));
    }
    report
}

/// Runs a routine by itself: its steps here, and its prompt as a question to NOVA.
fn run_alone<R: Runtime>(app: &AppHandle<R>, routine: &Routine) {
    if routine.steps.iter().any(|step| step.tool == "power") {
        crate::assistant::notify(app, &format!("Routine “{}”", routine.name), "It may shut down or restart the PC. Save your work now. Ask NOVA to call it off, or run: shutdown /a");
    }
    let report = run_steps(app, routine);
    let failed: Vec<String> = report.iter().filter_map(|(tool, outcome)| outcome.as_ref().err().map(|why| format!("{tool}: {why}"))).collect();
    if !failed.is_empty() {
        crate::assistant::notify(app, &format!("Routine “{}”", routine.name), &failed.join("\n"));
    } else if !routine.steps.is_empty() {
        crate::assistant::notify(app, "NOVA", &format!("Routine “{}” is done", routine.name));
    }
    if let Some(prompt) = &routine.prompt {
        crate::assistant::wake(app, crate::wake::Source::Schedule, false, true, Some(format!("(Scheduled routine “{}”, the user isn't waiting for it) {prompt}", routine.name)));
    }
}

/// The ▶ on the Routines page.
#[tauri::command]
pub async fn automation_run<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let routine = pick_routine(&load(&app).routines, &id)?;
    tauri::async_runtime::spawn_blocking(move || run_alone(&app, &routine)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn automation_list<R: Runtime>(app: AppHandle<R>) -> Result<Automation, String> {
    Ok(load(&app))
}

#[tauri::command]
pub async fn automation_delete_routine<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    change(&app, |automation| {
        automation.routines.retain(|routine| routine.id != id);
        Ok(())
    })
}

#[tauri::command]
pub async fn automation_delete_watcher<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    change(&app, |automation| {
        automation.watchers.retain(|watcher| watcher.id != id);
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Clock {
    pub weekday: u8,
    pub date: String,
    pub minutes: u32,
}

impl Clock {
    /// From the same text the model gets: "Saturday, 2026-11-07 14:03".
    fn parse(text: &str) -> Option<Clock> {
        let (day, rest) = text.split_once(", ")?;
        let (date, time) = rest.split_once(' ')?;
        let weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].iter().position(|name| *name == day)? as u8;
        Some(Clock { weekday, date: date.to_string(), minutes: minutes_of(time)? })
    }

    fn now() -> Clock {
        Clock::parse(&super::local_time()).unwrap_or(Clock { weekday: 0, date: String::new(), minutes: 0 })
    }
}

fn minutes_of(time: &str) -> Option<u32> {
    let (hours, minutes) = time.split_once(':')?;
    let (hours, minutes) = (hours.parse::<u32>().ok()?, minutes.parse::<u32>().ok()?);
    (hours < 24 && minutes < 60 && time.len() == 5).then_some(hours * 60 + minutes)
}

/// Whether a routine's time has come today and it hasn't run yet.
fn is_due(routine: &Routine, now: &Clock) -> bool {
    let Some(at) = routine.time.as_deref().and_then(minutes_of) else { return false };
    let late = if routine.prompt.is_some() { PROMPT_LATE_MINUTES } else { STEPS_LATE_MINUTES };
    (routine.days.is_empty() || routine.days.contains(&now.weekday)) && routine.last_run.as_deref() != Some(&now.date) && now.minutes >= at && now.minutes - at <= late
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

/// Everything a check may need, read once per tick and only if a watcher asks for it.
#[derive(Default)]
struct Look {
    processes: Option<Option<Vec<String>>>,
    games: Option<Vec<games::Installed>>,
    overview: Option<Value>,
}

impl Look {
    /// `None` when Windows didn't say: nothing has ended just because the list came back empty.
    fn processes(&mut self) -> Option<&[String]> {
        self.processes.get_or_insert_with(|| pc::processes().ok().map(|list| list.into_iter().map(|(_, name)| name).collect())).as_deref()
    }

    fn game(&mut self, wanted: &str) -> Option<games::Installed> {
        games::pick_installed(self.games.get_or_insert_with(games::library), wanted).ok()
    }

    fn overview<R: Runtime>(&mut self, app: &AppHandle<R>) -> &Value {
        self.overview.get_or_insert_with(|| crate::system::overview(&app.state::<crate::system::SystemMonitor>()).unwrap_or_default())
    }
}

fn runs(processes: &[String], program: &str) -> bool {
    let wanted = pc::stem(program);
    processes.iter().any(|name| *name == wanted || name.contains(&wanted))
}

fn downloads_folder() -> Option<std::path::PathBuf> {
    crate::files::known_folders().into_iter().find(|folder| folder.id == "downloads").map(|folder| folder.path.into())
}

/// How many unfinished browser downloads there are.
pub fn partial_downloads() -> usize {
    let Some(entries) = downloads_folder().and_then(|folder| std::fs::read_dir(folder).ok()) else { return 0 };
    entries.flatten().filter(|entry| entry.path().extension().is_some_and(|e| tidy::PARTIAL.contains(&e.to_string_lossy().to_lowercase().as_str()))).count()
}

/// Whether the condition holds right now; `None` when that can't be told at the moment.
fn holds<R: Runtime>(app: &AppHandle<R>, condition: &Condition, look: &mut Look) -> Option<bool> {
    Some(match condition {
        Condition::GameReady { game } => look.game(game)?.ready,
        Condition::GameUpdate { game } => !look.game(game)?.ready,
        Condition::CpuAbove { percent } => look.overview(app)["now"]["cpuUsage"].as_f64()? as f32 >= *percent,
        Condition::MemoryAbove { percent } => {
            let now = &look.overview(app)["now"];
            (now["memoryUsed"].as_f64()? / now["memoryTotal"].as_f64()?) as f32 * 100.0 >= *percent
        }
        Condition::TemperatureAbove { celsius } => crate::system::hottest_sensor()? >= *celsius,
        Condition::DiskBelow { gigabytes } => (super::cleanup::free_space() as f64 / 1_073_741_824.0) < *gigabytes,
        Condition::ProgramStarts { program } => runs(look.processes()?, program),
        Condition::ProgramEnds { program } => !runs(look.processes()?, program),
        Condition::DownloadsDone => partial_downloads() == 0,
        // Asked apart from the others, see `tick`.
        Condition::NewVideo { .. } => false,
    })
}

/// The state machine of one watcher: it goes off when the condition becomes true.
fn step_watcher(watcher: &mut Watcher, holds_now: bool) -> bool {
    if !holds_now {
        watcher.armed = true;
        return false;
    }
    let fires = watcher.armed;
    watcher.armed = false;
    fires
}

/// What the model asked for, checked and with its starting state. Refuses what would never go off.
pub fn checked_watcher<R: Runtime>(app: &AppHandle<R>, what: &str, input: &Value) -> Result<Watcher, String> {
    let say = input["say"].as_str().map(str::trim).filter(|say| !say.is_empty()).ok_or("Say what NOVA should say when it happens")?;
    if say.chars().count() > LONGEST_SAY {
        return Err(format!("What NOVA says can have at most {LONGEST_SAY} characters"));
    }
    let text = |key: &str| input[key].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).ok_or_else(|| format!("Missing “{key}”"));
    let number = |key: &str| input[key].as_f64().ok_or_else(|| format!("Missing “{key}”"));
    let mut seen = None;
    let condition = match what {
        "game_ready" => Condition::GameReady { game: games::pick_installed(&games::library(), &text("target")?)?.name },
        "game_update" => Condition::GameUpdate { game: games::pick_installed(&games::library(), &text("target")?)?.name },
        "cpu_above" => Condition::CpuAbove { percent: number("value")?.clamp(1.0, 100.0) as f32 },
        "memory_above" => Condition::MemoryAbove { percent: number("value")?.clamp(1.0, 100.0) as f32 },
        "temperature_above" => {
            if crate::system::hottest_sensor().is_none() {
                return Err("This PC doesn't tell Windows programs how hot it is, so NOVA can't watch the temperature. Offer to watch the CPU load instead.".into());
            }
            Condition::TemperatureAbove { celsius: number("value")?.clamp(20.0, 120.0) as f32 }
        }
        "disk_below" => Condition::DiskBelow { gigabytes: number("value")?.max(0.1) },
        "program_starts" => Condition::ProgramStarts { program: text("target")? },
        "program_ends" => Condition::ProgramEnds { program: text("target")? },
        "downloads_done" => Condition::DownloadsDone,
        "new_video" => {
            let (channel_id, channel) = youtube::find_channel(&text("target")?)?;
            seen = youtube::channel_videos(&channel_id, &channel)?.first().map(|video| video.id.clone());
            Condition::NewVideo { channel_id, channel }
        }
        _ => return Err("Unknown thing to watch".into()),
    };
    let routine = match input["routine"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => Some(pick_routine(&load(app).routines, name)?.name),
        None => None,
    };
    let holds_now = holds(app, &condition, &mut Look::default()).unwrap_or(false);
    let done_already = holds_now && !input["repeat"].as_bool().unwrap_or(false);
    match &condition {
        Condition::GameReady { game } if done_already => return Err(format!("{game} is already fully installed: nothing is downloading.")),
        Condition::GameUpdate { game } if done_already => return Err(format!("{game} already needs an update or is getting one.")),
        Condition::ProgramEnds { program } if done_already => return Err(format!("{program} isn't running.")),
        Condition::ProgramStarts { program } if done_already => return Err(format!("{program} is already running.")),
        Condition::DownloadsDone if done_already => return Err("No browser download is running in the Downloads folder right now. NOVA can't see other launchers' downloads this way; for games use game_ready.".into()),
        _ => {}
    }
    Ok(Watcher { id: storage::new_id("watch"), say: say.to_string(), condition, repeat: input["repeat"].as_bool().unwrap_or(false), routine, armed: !holds_now, seen })
}

pub fn condition_words(condition: &Condition) -> String {
    match condition {
        Condition::GameReady { game } => format!("{game} finished downloading"),
        Condition::GameUpdate { game } => format!("{game} needs an update"),
        Condition::CpuAbove { percent } => format!("CPU load over {percent:.0} %"),
        Condition::MemoryAbove { percent } => format!("Memory over {percent:.0} %"),
        Condition::TemperatureAbove { celsius } => format!("Over {celsius:.0} °C"),
        Condition::DiskBelow { gigabytes } => format!("Less than {gigabytes:.0} GB free"),
        Condition::ProgramStarts { program } => format!("{program} starts"),
        Condition::ProgramEnds { program } => format!("{program} ends"),
        Condition::DownloadsDone => "Browser downloads finished".into(),
        Condition::NewVideo { channel, .. } => format!("New video from {channel}"),
    }
}

pub fn add_watcher<R: Runtime>(app: &AppHandle<R>, watcher: Watcher) -> Result<(), String> {
    change(app, |automation| {
        if automation.watchers.len() >= MOST_WATCHERS {
            return Err(format!("NOVA keeps an eye on {MOST_WATCHERS} things at most. Stop one first."));
        }
        automation.watchers.push(watcher);
        Ok(())
    })
}

/// Stops by id, or by part of what it says or watches; nothing given means all.
pub fn stop_watchers<R: Runtime>(app: &AppHandle<R>, wanted: Option<&str>) -> Result<usize, String> {
    change(app, |automation| {
        let before = automation.watchers.len();
        match wanted.map(|w| w.trim().to_lowercase()).filter(|w| !w.is_empty()) {
            None => automation.watchers.clear(),
            Some(lower) => automation.watchers.retain(|w| w.id != lower && !w.say.to_lowercase().contains(&lower) && !condition_words(&w.condition).to_lowercase().contains(&lower)),
        }
        Ok(before - automation.watchers.len())
    })
}

// ---------------------------------------------------------------------------
// What played
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Played {
    pub title: String,
    pub artist: String,
    pub source: String,
    pub at: i64,
}

/// What played lately, newest first. The first time, with what the Media page used to keep.
pub fn played<R: Runtime>(app: &AppHandle<R>) -> Vec<Played> {
    let db = app.state::<Database>();
    if let Some(list) = db.with(|c| storage::kv_get(c, PLAYED_KEY)).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()) {
        return list;
    }
    let old = db.with(|c| storage::kv_get(c, "nova.media")).ok().flatten().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    old.and_then(|document| serde_json::from_value(document["state"]["entries"].clone()).ok()).unwrap_or_default()
}

fn note_played<R: Runtime>(app: &AppHandle<R>) {
    let Ok(Some(state)) = crate::media::platform::state() else { return };
    if !state.is_playing() || state.title().is_empty() {
        return;
    }
    let mut list = played(app);
    if list.first().is_some_and(|last| last.title == state.title() && last.artist == state.artist()) {
        return;
    }
    list.insert(0, Played { title: state.title().to_string(), artist: state.artist().to_string(), source: state.source_app_id().to_string(), at: now_millis() });
    list.truncate(MOST_PLAYED);
    if let Ok(raw) = serde_json::to_string(&list) {
        let _ = app.state::<Database>().with(|c| storage::kv_set(c, PLAYED_KEY, &raw));
    }
}

#[tauri::command]
pub async fn media_played<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Played>, String> {
    Ok(played(&app))
}

#[tauri::command]
pub async fn media_played_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    app.state::<Database>().with(|c| storage::kv_set(c, PLAYED_KEY, "[]"))
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Memory {
    over_limit: HashMap<String, u32>,
    channels_asked: HashMap<String, Instant>,
}

fn sustained(watcher: &Watcher, holds_now: bool, memory: &mut Memory) -> bool {
    if !matches!(watcher.condition, Condition::CpuAbove { .. } | Condition::MemoryAbove { .. } | Condition::TemperatureAbove { .. }) {
        return holds_now;
    }
    let ticks = memory.over_limit.entry(watcher.id.clone()).or_insert(0);
    *ticks = if holds_now { *ticks + 1 } else { 0 };
    *ticks >= SUSTAINED_TICKS
}

/// New videos of the channels that are due to be asked: watcher id → (id, title).
fn new_videos(watchers: &[Watcher], memory: &mut Memory) -> HashMap<String, (String, String)> {
    let mut found = HashMap::new();
    for watcher in watchers {
        let Condition::NewVideo { channel_id, channel } = &watcher.condition else { continue };
        if memory.channels_asked.get(&watcher.id).is_some_and(|at| at.elapsed() < CHANNEL_EVERY) {
            continue;
        }
        memory.channels_asked.insert(watcher.id.clone(), Instant::now());
        if let Some(video) = youtube::channel_videos(channel_id, channel).ok().and_then(|videos| videos.into_iter().next()) {
            if watcher.seen.as_deref() != Some(&video.id) {
                found.insert(watcher.id.clone(), (video.id, video.title));
            }
        }
    }
    found
}

fn tick<R: Runtime>(app: &AppHandle<R>, memory: &mut Memory) {
    note_played(app);
    let snapshot = load(app);
    let now = Clock::now();
    let mut due: Vec<Routine> = Vec::new();
    // A question to NOVA waits for its turn, one at a time; steps don't need NOVA to be free.
    let mut free = !super::busy(app);
    for routine in snapshot.routines.iter().filter(|routine| is_due(routine, &now)) {
        if routine.prompt.is_some() && !std::mem::take(&mut free) {
            continue;
        }
        due.push(routine.clone());
    }
    // Asked with nothing locked: this can take seconds.
    let videos = new_videos(&snapshot.watchers, memory);
    let mut look = Look::default();
    let readings: HashMap<String, bool> = snapshot.watchers.iter().filter_map(|watcher| Some((watcher.id.clone(), holds(app, &watcher.condition, &mut look)?))).collect();
    let mut fired: Vec<(String, Option<String>)> = Vec::new();
    let changed = change(app, |automation| {
        for routine in automation.routines.iter_mut().filter(|routine| due.iter().any(|d| d.id == routine.id)) {
            routine.last_run = Some(now.date.clone());
        }
        automation.watchers.retain_mut(|watcher| {
            if let Some((id, title)) = videos.get(&watcher.id) {
                watcher.seen = Some(id.clone());
                fired.push((format!("{} {title}", watcher.say), watcher.routine.clone()));
                return watcher.repeat;
            }
            let Some(reading) = readings.get(&watcher.id) else { return true };
            let holds_now = sustained(watcher, *reading, memory);
            if step_watcher(watcher, holds_now) {
                fired.push((watcher.say.clone(), watcher.routine.clone()));
                return watcher.repeat;
            }
            true
        });
        Ok(())
    });
    if changed.is_err() {
        return;
    }
    let all = load(app).routines;
    for (say, routine) in fired {
        crate::assistant::announce(app, say);
        if let Some(routine) = routine.and_then(|name| all.iter().find(|known| known.name == name).cloned()) {
            due.push(routine);
        }
    }
    for routine in due {
        run_alone(app, &routine);
    }
}

/// Starts the background thread.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut memory = Memory::default();
        loop {
            std::thread::sleep(TICK);
            tick(&app, &mut memory);
        }
    });
}

/// For the model: everything saved, in lines.
pub fn listing<R: Runtime>(app: &AppHandle<R>) -> (Vec<String>, Vec<String>) {
    let automation = load(app);
    let routines = automation
        .routines
        .iter()
        .map(|routine| {
            let steps = routine.steps.iter().map(step_words).collect::<Vec<_>>().join("; ");
            let prompt = routine.prompt.as_ref().map_or_else(String::new, |prompt| format!(" Asks: {prompt}"));
            format!("{}: {steps}.{prompt}{}", routine.name, schedule_words(routine).map_or_else(String::new, |when| format!(" Runs {when}.")))
        })
        .collect();
    let watchers = automation.watchers.iter().map(|watcher| format!("{}: says “{}”{}", condition_words(&watcher.condition), watcher.say, if watcher.repeat { ", every time" } else { "" })).collect();
    (routines, watchers)
}

/// The card the panel draws for saved things.
pub fn facts_card(icon: &str, title: &str, lines: Vec<String>) -> Value {
    json!({ "kind": "facts", "icon": icon, "title": title, "lines": lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watcher(condition: Condition, armed: bool) -> Watcher {
        Watcher { id: "w".into(), say: "Fertig".into(), condition, repeat: false, routine: None, armed, seen: None }
    }

    #[test]
    fn goes_off_only_when_it_becomes_so() {
        let mut w = watcher(Condition::DownloadsDone, false);
        assert!(!step_watcher(&mut w, true), "already so when it was set");
        assert!(!step_watcher(&mut w, false));
        assert!(step_watcher(&mut w, true), "it became so");
        assert!(!step_watcher(&mut w, true), "once");
        assert!(!step_watcher(&mut w, false));
        assert!(step_watcher(&mut w, true), "again after it went away");
    }

    #[test]
    fn a_spike_of_load_isnt_worth_a_word() {
        let mut memory = Memory::default();
        let w = watcher(Condition::CpuAbove { percent: 90.0 }, true);
        for _ in 1..SUSTAINED_TICKS {
            assert!(!sustained(&w, true, &mut memory));
        }
        assert!(sustained(&w, true, &mut memory));
        assert!(!sustained(&w, false, &mut memory));
        assert!(!sustained(&w, true, &mut memory), "starts over");
        assert!(sustained(&watcher(Condition::DownloadsDone, true), true, &mut memory), "only load has to last");
    }

    #[test]
    fn routines_only_do_what_needs_no_asking() {
        let steps = json!([{ "tool": "open_app", "input": { "name": "Discord" } }, { "tool": "wait", "input": { "seconds": 5 } }]);
        let routine = checked_routine(" Gaming-Modus ", &steps, None, Some("08:00"), &json!([1, 2, 9])).unwrap();
        assert_eq!(routine.name, "Gaming-Modus");
        assert_eq!(routine.days, [1, 2]);
        assert_eq!(step_words(&routine.steps[0]), "open_app (name: Discord)");
        assert!(checked_routine("x", &json!([{ "tool": "delete_item", "input": {} }]), None, None, &Value::Null).unwrap_err().contains("delete_item"));
        assert!(checked_routine("x", &json!([{ "tool": "send_input" }]), None, None, &Value::Null).is_err());
        assert!(checked_routine("x", &json!([{ "tool": "end_process", "input": { "process": "a", "force": true } }]), None, None, &Value::Null).is_err());
        assert!(checked_routine("x", &Value::Null, None, None, &Value::Null).unwrap_err().contains("steps or a prompt"));
        assert!(checked_routine("x", &Value::Null, Some("Wetter"), Some("25:00"), &Value::Null).unwrap_err().contains("HH:MM"));
        assert!(checked_routine("", &Value::Null, Some("Wetter"), None, &Value::Null).is_err());
    }

    #[test]
    fn knows_when_a_routine_is_due() {
        let now = Clock::parse("Saturday, 2026-11-07 08:01").unwrap();
        assert_eq!(now, Clock { weekday: 6, date: "2026-11-07".into(), minutes: 481 });
        let steps = Routine { steps: vec![Step { tool: "wait".into(), input: Value::Null }], time: Some("08:00".into()), ..Routine::default() };
        assert!(is_due(&steps, &now));
        assert!(!is_due(&Routine { days: vec![1], ..steps.clone() }, &now), "wrong day");
        assert!(is_due(&Routine { days: vec![6], ..steps.clone() }, &now));
        assert!(!is_due(&Routine { last_run: Some("2026-11-07".into()), ..steps.clone() }, &now), "already ran today");
        assert!(!is_due(&Routine { time: Some("09:00".into()), ..steps.clone() }, &now), "not yet");
        assert!(!is_due(&Routine { time: None, ..steps.clone() }, &now));
        let later = Clock { minutes: 490, ..now.clone() };
        assert!(!is_due(&steps, &later), "a shutdown at 23:00 doesn't happen when the PC comes back on");
        let briefing = Routine { prompt: Some("Wetter".into()), time: Some("08:00".into()), ..Routine::default() };
        assert!(is_due(&briefing, &later), "a briefing does");
        assert!(is_due(&Routine { steps: steps.steps.clone(), ..briefing.clone() }, &later), "also when it opens something first");
        assert!(!is_due(&briefing, &Clock { minutes: 700, ..now }));
    }

    #[test]
    fn finds_routines_by_name() {
        let routine = |name: &str| Routine { id: name.into(), name: name.into(), ..Routine::default() };
        let all = [routine("Gaming-Modus"), routine("Morgenbriefing"), routine("Morgensport")];
        assert_eq!(pick_routine(&all, "gaming").unwrap().name, "Gaming-Modus");
        assert_eq!(pick_routine(&all, "Morgenbriefing").unwrap().name, "Morgenbriefing");
        assert!(pick_routine(&all, "morgen").unwrap_err().contains("could be"));
        assert!(pick_routine(&all, "nichts").unwrap_err().contains("Gaming-Modus"));
    }

    #[test]
    fn old_saved_data_still_loads() {
        let automation: Automation = serde_json::from_str(r#"{"routines":[{"id":"a","name":"x"}],"watchers":[{"id":"b","say":"s","condition":{"type":"downloadsDone"}}]}"#).unwrap();
        assert_eq!(automation.watchers[0].condition, Condition::DownloadsDone);
        assert!(!automation.watchers[0].armed);
        let roundtrip = serde_json::to_string(&Condition::NewVideo { channel_id: "UC".into(), channel: "x".into() }).unwrap();
        assert!(roundtrip.contains("newVideo") && roundtrip.contains("channelId"));
    }
}
