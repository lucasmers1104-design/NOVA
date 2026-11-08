//! Tasks from the phone: the queue, running them through NOVA AI, approvals on the
//! phone, and notices the phone picks up later. Every task stays in `companion_jobs`
//! as the local log.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::{oneshot, Notify};

use super::protocol::{self, ErrorCode, NoticeKind, Outcome, PcMessage, PhoneMessage, Schedule, TaskEventBody, TaskState, Tier};
use super::queue::{self, Due};
use crate::agent::{AgentEvent, Phone};
use crate::storage::{self, Database};

/// SECURITY: how long an approval request waits for the fingerprint on the phone.
const APPROVAL_LIFETIME_MS: u64 = 120_000;
const KEEP_SCREENSHOTS: Duration = Duration::from_secs(7 * 24 * 3600);
const MOST_WAITING: u32 = 50;
const MOST_NOTICES: usize = 200;
const MOST_RESULT_CHARS: usize = 20_000;

struct Pending {
    request_id: String,
    device_id: String,
    task_id: String,
    title: String,
    detail: Option<String>,
    risk: protocol::Risk,
    expires_at: u64,
    answer: Option<oneshot::Sender<bool>>,
}

static APPROVALS: Mutex<Vec<Pending>> = Mutex::new(Vec::new());
/// One phone task at a time runs; the agent itself also runs only one request.
static RUNNING: AtomicBool = AtomicBool::new(false);

fn approvals() -> std::sync::MutexGuard<'static, Vec<Pending>> {
    APPROVALS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn base() -> (String, u64) {
    (protocol::new_id(), protocol::now())
}

fn error_to<R: Runtime>(app: &AppHandle<R>, device_id: &str, code: ErrorCode, message: &str, reply_to: Option<&str>) {
    let (id, ts) = base();
    super::send_to(app, device_id, PcMessage::Error { id, ts, code, message: message.into(), reply_to: reply_to.map(str::to_string) });
}

fn event_to<R: Runtime>(app: &AppHandle<R>, device_id: &str, task_id: &str, event: TaskEventBody) {
    let (id, ts) = base();
    super::send_to(app, device_id, PcMessage::TaskEvent { id, ts, task_id: task_id.into(), event });
}

/// The PC's local date and time: ("2026-11-08", "18:30").
fn local_now() -> (String, String) {
    let text = crate::agent::local_time();
    let rest = text.split_once(", ").map_or(text.as_str(), |(_, rest)| rest);
    let (date, time) = rest.split_once(' ').unwrap_or(("", ""));
    (date.to_string(), time.to_string())
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Job {
    id: String,
    device_id: String,
    text: String,
    want_screenshot: bool,
}

fn set_state<R: Runtime>(app: &AppHandle<R>, id: &str, state: TaskState, result: Option<&str>) {
    let finished = matches!(state, TaskState::Done | TaskState::Failed | TaskState::Cancelled | TaskState::Missed).then(storage::now_millis);
    let result: Option<String> = result.map(|r| r.chars().take(4000).collect());
    let _ = app.state::<Database>().with(|c| {
        Ok(c.execute("UPDATE companion_jobs SET state = ?2, finished_at = COALESCE(?3, finished_at), result = COALESCE(?4, result) WHERE id = ?1", params![id, state.as_str(), finished, result])?)
    });
    super::changed(app);
}

fn job_state<R: Runtime>(app: &AppHandle<R>, device_id: &str, id: &str) -> Option<TaskState> {
    let state: Option<String> = app
        .state::<Database>()
        .with(|c| Ok(c.query_row("SELECT state FROM companion_jobs WHERE id = ?1 AND device_id = ?2", params![id, device_id], |row| row.get(0)).optional()?))
        .ok()
        .flatten();
    state.as_deref().and_then(TaskState::from_str)
}

pub fn active_count<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> u32 {
    app.state::<Database>()
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM companion_jobs WHERE device_id = ?1 AND state IN ('queued', 'scheduled', 'running')", [device_id], |row| row.get(0))?))
        .unwrap_or(0)
}

pub fn pending_approvals(device_id: &str) -> u32 {
    approvals().iter().filter(|p| p.device_id == device_id).count() as u32
}

/// Stores a notice for the phone and sends what is waiting if it is connected.
pub fn notify<R: Runtime>(app: &AppHandle<R>, device_id: &str, kind: NoticeKind, text: &str, task_id: Option<&str>) {
    let text: String = text.chars().take(2000).collect();
    let _ = app.state::<Database>().with(|c| {
        c.execute(
            "INSERT INTO companion_notices (id, device_id, kind, text, task_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![protocol::new_id(), device_id, kind.as_str(), text, task_id, storage::now_millis()],
        )?;
        // Keep the newest ones if a phone never comes back.
        c.execute(
            "DELETE FROM companion_notices WHERE device_id = ?1 AND id NOT IN (SELECT id FROM companion_notices WHERE device_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
            params![device_id, MOST_NOTICES as i64],
        )?;
        Ok(())
    });
    if super::connected(app, device_id) {
        send_notices(app, device_id);
    }
}

fn send_notices<R: Runtime>(app: &AppHandle<R>, device_id: &str) {
    let items = app
        .state::<Database>()
        .with(|c| {
            let mut statement = c.prepare("SELECT id, kind, text, task_id, created_at FROM companion_notices WHERE device_id = ?1 ORDER BY created_at")?;
            let rows = statement.query_map([device_id], |row| {
                let kind: String = row.get(1)?;
                Ok((row.get::<_, String>(0)?, kind, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(id, kind, text, task_id, ts)| {
            let kind = serde_json::from_value(Value::String(kind)).ok()?;
            Some(protocol::Notice { id, kind, text, task_id, ts: ts.max(0) as u64 })
        })
        .collect();
    let (id, ts) = base();
    super::send_to(app, device_id, PcMessage::Notices { id, ts, items });
}

fn send_tasks<R: Runtime>(app: &AppHandle<R>, device_id: &str) {
    let items = app
        .state::<Database>()
        .with(|c| {
            let mut statement = c.prepare(
                "SELECT id, text, state, CASE WHEN run_date IS NULL THEN NULL ELSE run_date || ' ' || run_time END, created_at
                 FROM companion_jobs WHERE device_id = ?1 ORDER BY created_at DESC LIMIT 50",
            )?;
            let rows = statement.query_map([device_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, i64>(4)?))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(task_id, text, state, run_at, created)| {
            Some(protocol::TaskSummary { task_id, text, state: TaskState::from_str(&state)?, run_at, created_at: created.max(0) as u64 })
        })
        .collect();
    let (id, ts) = base();
    super::send_to(app, device_id, PcMessage::Tasks { id, ts, items });
}

// ---------------------------------------------------------------------------
// Messages from the phone
// ---------------------------------------------------------------------------

/// Everything a connected, authenticated phone sends ends here.
pub fn handle<R: Runtime>(app: &AppHandle<R>, device_id: &str, message: PhoneMessage) {
    match message {
        PhoneMessage::StatusGet { .. } => {
            super::send_to(app, device_id, super::status(app, device_id));
        }
        PhoneMessage::NoticesGet { .. } => send_notices(app, device_id),
        PhoneMessage::NoticesAck { ids, .. } => {
            let _ = app.state::<Database>().with(|c| {
                for id in &ids {
                    c.execute("DELETE FROM companion_notices WHERE id = ?1 AND device_id = ?2", params![id, device_id])?;
                }
                Ok(())
            });
        }
        PhoneMessage::TasksList { .. } => send_tasks(app, device_id),
        PhoneMessage::TaskCreate { id, text, want_screenshot, schedule, .. } => create(app, device_id, id, text, want_screenshot, schedule),
        PhoneMessage::TaskCancel { id, task_id, .. } => cancel(app, device_id, &id, &task_id),
        PhoneMessage::ApprovalAnswer { id, request_id, approved, proof, .. } => answer(app, device_id, &id, &request_id, approved, proof.as_deref()),
    }
}

fn create<R: Runtime>(app: &AppHandle<R>, device_id: &str, id: String, text: String, want_screenshot: bool, schedule: Schedule) {
    // The phone sends a task again after a lost connection: answer with where it stands.
    if let Some(state) = job_state(app, device_id, &id) {
        event_to(app, device_id, &id, TaskEventBody::Accepted { state, run_at: None });
        return;
    }
    if active_count(app, device_id) >= MOST_WAITING {
        return error_to(app, device_id, ErrorCode::Busy, "Too many tasks are waiting", Some(&id));
    }
    let (kind, run_date, run_time, state) = match &schedule {
        Schedule::At { date, time } => {
            let (now_date, now_time) = local_now();
            if let Err(why) = queue::check_new(date, time, &now_date, &now_time) {
                return error_to(app, device_id, ErrorCode::Invalid, &why, Some(&id));
            }
            ("at", Some(date.clone()), Some(time.clone()), TaskState::Scheduled)
        }
        Schedule::WhenOnline => ("whenOnline", None, None, TaskState::Queued),
        Schedule::Now => ("now", None, None, TaskState::Queued),
    };
    let stored = app.state::<Database>().with(|c| {
        Ok(c.execute(
            "INSERT INTO companion_jobs (id, device_id, text, want_screenshot, schedule, run_date, run_time, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, device_id, text, want_screenshot, kind, run_date, run_time, state.as_str(), storage::now_millis()],
        )?)
    });
    if let Err(error) = stored {
        return error_to(app, device_id, ErrorCode::Invalid, &error, Some(&id));
    }
    let run_at = run_date.zip(run_time).map(|(d, t)| format!("{d} {t}"));
    event_to(app, device_id, &id, TaskEventBody::Accepted { state, run_at });
    super::changed(app);
    try_run_next(app);
}

fn cancel<R: Runtime>(app: &AppHandle<R>, device_id: &str, message_id: &str, task_id: &str) {
    match job_state(app, device_id, task_id) {
        Some(TaskState::Queued | TaskState::Scheduled) => {
            set_state(app, task_id, TaskState::Cancelled, None);
            event_to(app, device_id, task_id, TaskEventBody::Accepted { state: TaskState::Cancelled, run_at: None });
        }
        Some(TaskState::Running) => {
            crate::agent::cancel_phone(app, task_id);
        }
        Some(_) => {}
        None => error_to(app, device_id, ErrorCode::UnknownTask, "That task isn't known", Some(message_id)),
    }
}

/// SECURITY: an approval counts only from the device it was asked of, before it
/// expired, and with a proof made with that device's biometric-locked key.
fn answer<R: Runtime>(app: &AppHandle<R>, device_id: &str, message_id: &str, request_id: &str, approved: bool, proof: Option<&str>) {
    let mut list = approvals();
    let Some(pending) = list.iter_mut().find(|p| p.request_id == request_id && p.device_id == device_id) else {
        drop(list);
        return error_to(app, device_id, ErrorCode::UnknownRequest, "That approval is no longer waiting", Some(message_id));
    };
    if protocol::now() > pending.expires_at {
        drop(list);
        return error_to(app, device_id, ErrorCode::Expired, "That approval expired", Some(message_id));
    }
    if approved {
        let key = super::device_approval_key(device_id);
        let valid = key.is_some_and(|key| proof.is_some_and(|proof| super::crypto::verify_approval(&key, request_id, pending.expires_at, proof)));
        if !valid {
            drop(list);
            return error_to(app, device_id, ErrorCode::BadProof, "The approval couldn't be verified", Some(message_id));
        }
    }
    if let Some(sender) = pending.answer.take() {
        let _ = sender.send(approved);
    }
}

/// Asks the phone and waits for its answer, the expiry, or a cancel.
pub async fn request_approval<R: Runtime>(app: &AppHandle<R>, phone: &Phone, title: &str, detail: Option<&str>, risk: crate::agent::tools::Risk, cancel: Arc<Notify>) -> bool {
    let request_id = protocol::new_id();
    let expires_at = protocol::now() + APPROVAL_LIFETIME_MS;
    let risk = match risk {
        crate::agent::tools::Risk::Safe => protocol::Risk::Safe,
        crate::agent::tools::Risk::Confirm => protocol::Risk::Confirm,
        crate::agent::tools::Risk::High => protocol::Risk::High,
    };
    let (sender, receiver) = oneshot::channel();
    let pending = Pending {
        request_id: request_id.clone(),
        device_id: phone.device_id.clone(),
        task_id: phone.task_id.clone(),
        title: title.chars().take(500).collect(),
        detail: detail.map(|d| d.chars().take(2000).collect()),
        risk,
        expires_at,
        answer: Some(sender),
    };
    let request = request_message(&pending);
    approvals().push(pending);
    super::send_to(app, &phone.device_id, request);
    // Decided 2026-11-08: the PC shows when a phone is about to change something.
    crate::assistant::notify(app, "NOVA Companion", &format!("Phone request from {}: {title}", phone.device_name));
    super::changed(app);

    let outcome = tokio::select! {
        answer = receiver => if answer.unwrap_or(false) { Outcome::Approved } else { Outcome::Declined },
        _ = tokio::time::sleep(Duration::from_millis(APPROVAL_LIFETIME_MS)) => Outcome::Expired,
        _ = cancel.notified() => Outcome::Cancelled,
    };
    approvals().retain(|p| p.request_id != request_id);
    let (id, ts) = base();
    super::send_to(app, &phone.device_id, PcMessage::ApprovalClosed { id, ts, request_id, outcome });
    super::changed(app);
    outcome == Outcome::Approved
}

fn request_message(pending: &Pending) -> PcMessage {
    let (id, ts) = base();
    PcMessage::ApprovalRequest {
        id,
        ts,
        request_id: pending.request_id.clone(),
        task_id: pending.task_id.clone(),
        title: pending.title.clone(),
        detail: pending.detail.clone(),
        risk: pending.risk,
        expires_at: pending.expires_at,
    }
}

/// A phone (re)connected: what it may have missed.
pub fn on_connect<R: Runtime>(app: &AppHandle<R>, device_id: &str) {
    let open: Vec<PcMessage> = approvals().iter().filter(|p| p.device_id == device_id).map(request_message).collect();
    for message in open {
        super::send_to(app, device_id, message);
    }
}

/// The device was revoked: its approvals end and its running task stops.
pub fn cancel_device<R: Runtime>(app: &AppHandle<R>, device_id: &str) {
    for pending in approvals().iter_mut().filter(|p| p.device_id == device_id) {
        if let Some(sender) = pending.answer.take() {
            let _ = sender.send(false);
        }
    }
    if let Some(phone) = crate::agent::phone(app).filter(|p| p.device_id == device_id) {
        crate::agent::cancel_phone(app, &phone.task_id);
    }
}

// ---------------------------------------------------------------------------
// Running tasks
// ---------------------------------------------------------------------------

fn next_queued<R: Runtime>(app: &AppHandle<R>) -> Option<Job> {
    app.state::<Database>()
        .with(|c| {
            Ok(c.query_row(
                "SELECT j.id, j.device_id, j.text, j.want_screenshot FROM companion_jobs j JOIN companion_devices d ON d.id = j.device_id
                 WHERE j.state = 'queued' ORDER BY j.created_at LIMIT 1",
                [],
                |row| Ok(Job { id: row.get(0)?, device_id: row.get(1)?, text: row.get(2)?, want_screenshot: row.get(3)? }),
            )
            .optional()?)
        })
        .ok()
        .flatten()
}

fn device_name<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> String {
    super::device_for_session(app, device_id).map(|(_, name)| name).unwrap_or_else(|| "Phone".into())
}

/// Starts the next waiting task if NOVA is free.
pub fn try_run_next<R: Runtime>(app: &AppHandle<R>) {
    if crate::agent::busy(app) || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(job) = next_queued(app) else {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };
    set_state(app, &job.id, TaskState::Running, None);
    event_to(app, &job.device_id, &job.id, TaskEventBody::Accepted { state: TaskState::Running, run_at: None });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let requeued = run_job(&app, job).await;
        RUNNING.store(false, Ordering::SeqCst);
        if !requeued {
            try_run_next(&app);
        }
    });
}

/// What the agent's events become on the phone. Collects the reply text and the error.
fn forward(value: &Value, reply: &Mutex<String>, failure: &Mutex<Option<String>>) -> Option<TaskEventBody> {
    let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();
    match value["type"].as_str()? {
        "status" => Some(TaskEventBody::Status { state: text("state"), detail: value["detail"].as_str().map(|d| d.chars().take(500).collect()) }),
        "text" => {
            let delta = text("text");
            let mut all = reply.lock().unwrap_or_else(|p| p.into_inner());
            if all.chars().count() < MOST_RESULT_CHARS {
                all.push_str(&delta);
            }
            Some(TaskEventBody::Text { text: delta })
        }
        "toolStarted" => Some(TaskEventBody::ToolStarted {
            tool_id: text("id"),
            title: text("title").chars().take(500).collect(),
            tier: if value["risk"] == "safe" { Tier::Free } else { Tier::Approve },
        }),
        "toolFinished" => Some(TaskEventBody::ToolFinished { tool_id: text("id"), ok: value["ok"].as_bool().unwrap_or(false), summary: text("summary").chars().take(2000).collect() }),
        "failed" => {
            *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(text("error"));
            None
        }
        _ => None,
    }
}

/// Runs one task. `true` when NOVA was busy after all and the task waits again.
async fn run_job<R: Runtime>(app: &AppHandle<R>, job: Job) -> bool {
    let reply = Arc::new(Mutex::new(String::new()));
    let failure = Arc::new(Mutex::new(None::<String>));
    let channel = {
        let (app, device, task, reply, failure) = (app.clone(), job.device_id.clone(), job.id.clone(), reply.clone(), failure.clone());
        Channel::<AgentEvent>::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Some(event) = serde_json::from_str::<Value>(&json).ok().and_then(|value| forward(&value, &reply, &failure)) {
                    event_to(&app, &device, &task, event);
                }
            }
            Ok(())
        })
    };
    let phone = Phone { device_id: job.device_id.clone(), device_name: device_name(app, &job.device_id), task_id: job.id.clone(), check: false };
    let result = crate::agent::run_phone(app, phone, job.text.clone(), &channel).await;
    if result.as_ref().is_err_and(|e| e == crate::agent::BUSY) {
        set_state(app, &job.id, TaskState::Queued, None);
        event_to(app, &job.device_id, &job.id, TaskEventBody::Accepted { state: TaskState::Queued, run_at: None });
        return true;
    }
    let text = reply.lock().unwrap_or_else(|p| p.into_inner()).trim().to_string();
    let (state, error) = match result {
        Ok(()) => (TaskState::Done, None),
        Err(e) if e == "Stopped" => (TaskState::Cancelled, None),
        Err(e) => (TaskState::Failed, Some(failure.lock().unwrap_or_else(|p| p.into_inner()).clone().unwrap_or(e))),
    };
    // The phone accepts at most 2000 characters here (parse.ts).
    let error: Option<String> = error.map(|e| e.chars().take(2000).collect());
    let screenshot = if job.want_screenshot && state == TaskState::Done { screenshot(app).await } else { None };
    set_state(app, &job.id, state, Some(error.as_deref().unwrap_or(&text)));
    let (id, ts) = base();
    let result = PcMessage::TaskResult { id, ts, task_id: job.id.clone(), ok: state == TaskState::Done, text: text.clone(), screenshot, error: error.clone() };
    let delivered = super::send_to(app, &job.device_id, result);
    if !delivered {
        let (kind, summary) = match state {
            TaskState::Done => (NoticeKind::TaskDone, if text.is_empty() { "Done".to_string() } else { text.clone() }),
            _ => (NoticeKind::TaskFailed, error.unwrap_or_else(|| "Stopped".into())),
        };
        notify(app, &job.device_id, kind, &summary, Some(&job.id));
    }
    false
}

/// Whether the model's reply to a check says it happened. Only a clear yes counts.
pub fn check_says_yes(reply: &str) -> bool {
    let first = reply.trim_start().split(|c: char| !c.is_alphabetic()).next().unwrap_or_default().to_uppercase();
    first == "YES" || first == "JA"
}

/// An AI check for a phone ("sag Bescheid, wenn …"): one look at the screen, a yes or no.
pub fn start_check<R: Runtime>(app: &AppHandle<R>, watcher_id: String, question: String, device_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let reply = Arc::new(Mutex::new(String::new()));
        let channel = {
            let reply = reply.clone();
            Channel::<AgentEvent>::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    if let Ok(value) = serde_json::from_str::<Value>(&json) {
                        if value["type"] == "text" {
                            reply.lock().unwrap_or_else(|p| p.into_inner()).push_str(value["text"].as_str().unwrap_or_default());
                        }
                    }
                }
                Ok(())
            })
        };
        let phone = Phone { device_id: device_id.clone(), device_name: device_name(&app, &device_id), task_id: format!("check-{watcher_id}"), check: true };
        let prompt = format!(
            "(A background check the user asked for from their phone; they aren't waiting for a reply.) Look at the screen with look_at_screen, then answer with YES or NO as the very first word and one short sentence why. The question: {question}"
        );
        match crate::agent::run_phone(&app, phone, prompt, &channel).await {
            // NOVA was busy after all: the next tick asks again.
            Err(e) if e == crate::agent::BUSY => {}
            Ok(()) => {
                let said = reply.lock().unwrap_or_else(|p| p.into_inner()).clone();
                crate::agent::auto::finish_check(&app, &watcher_id, check_says_yes(&said));
            }
            // A failed check counts as one; the limit still ends it.
            Err(_) => crate::agent::auto::finish_check(&app, &watcher_id, false),
        }
    });
}

fn shots_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("companion").join("shots"))
}

/// The whole first screen, for the phone. Kept on disk only if the user turned that on.
async fn screenshot<R: Runtime>(app: &AppHandle<R>) -> Option<protocol::Screenshot> {
    let handle = app.clone();
    let shot = tauri::async_runtime::spawn_blocking(move || crate::capture::capture(&handle, &crate::capture::Target::Screen { index: 0 })).await.ok()?.ok()?;
    if super::config(app).keep_screenshots {
        use base64::Engine;
        if let (Some(dir), Ok(png)) = (shots_dir(app), base64::engine::general_purpose::STANDARD.decode(&shot.png_base64)) {
            let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(format!("{}.png", storage::now_millis())), png));
        }
    }
    Some(protocol::Screenshot { mime: "image/png".into(), width: shot.width, height: shot.height, data: shot.png_base64 })
}

/// Deletes kept screenshots older than `older_than`, or all of them.
pub fn delete_screenshots<R: Runtime>(app: &AppHandle<R>, older_than: Option<Duration>) {
    let Some(dir) = shots_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let old = older_than.is_none_or(|age| entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e > age));
        if old && entry.path().extension().is_some_and(|e| e == "png") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/// At startup: a task that was running when NOVA closed didn't finish.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.state::<Database>().with(|c| Ok(c.execute("UPDATE companion_jobs SET state = 'failed', result = 'NOVA was closed while this ran' WHERE state = 'running'", [])?));
    delete_screenshots(app, Some(KEEP_SCREENSHOTS));
}

/// Every 15 seconds from NOVA's automation thread: due tasks wait their turn, missed ones are reported.
pub fn tick<R: Runtime>(app: &AppHandle<R>) {
    let (now_date, now_time) = local_now();
    let scheduled: Vec<(String, String, String, String, String)> = app
        .state::<Database>()
        .with(|c| {
            let mut statement = c.prepare("SELECT id, device_id, text, run_date, run_time FROM companion_jobs WHERE state = 'scheduled'")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap_or_default();
    for (id, device_id, text, date, time) in scheduled {
        match queue::due(&date, &time, &now_date, &now_time) {
            Due::Wait => {}
            Due::Run => set_state(app, &id, TaskState::Queued, None),
            Due::Missed => {
                set_state(app, &id, TaskState::Missed, Some("The PC was off at that time"));
                let short: String = text.chars().take(80).collect();
                notify(app, &device_id, NoticeKind::TaskMissed, &format!("Missed at {time}: {short}"), Some(&id));
            }
        }
    }
    if std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(false, |d| d.as_secs() % 3600 < 15) {
        delete_screenshots(app, Some(KEEP_SCREENSHOTS));
    }
    try_run_next(app);
}

#[cfg(all(test, feature = "companion-e2e"))]
pub fn test_push_approval(request_id: &str, device_id: &str, expires_at: u64, answer: oneshot::Sender<bool>) {
    approvals().push(Pending {
        request_id: request_id.into(),
        device_id: device_id.into(),
        task_id: "t".into(),
        title: "Test".into(),
        detail: None,
        risk: protocol::Risk::Confirm,
        expires_at,
        answer: Some(answer),
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::{check_says_yes, forward};
    use crate::companion::protocol::{TaskEventBody, Tier};

    #[test]
    fn agent_events_reach_the_phone_without_costs() {
        let (reply, failure) = (Mutex::new(String::new()), Mutex::new(None));
        let step = forward(&json!({ "type": "toolStarted", "id": "t1", "name": "end_process", "title": "End Steam", "risk": "high" }), &reply, &failure);
        assert_eq!(step, Some(TaskEventBody::ToolStarted { tool_id: "t1".into(), title: "End Steam".into(), tier: Tier::Approve }));
        forward(&json!({ "type": "text", "text": "Noch " }), &reply, &failure);
        forward(&json!({ "type": "text", "text": "12 Minuten." }), &reply, &failure);
        assert_eq!(*reply.lock().unwrap(), "Noch 12 Minuten.");
        assert_eq!(forward(&json!({ "type": "usage", "inputTokens": 5, "costUsd": 0.1 }), &reply, &failure), None);
        assert_eq!(forward(&json!({ "type": "failed", "error": "No key" }), &reply, &failure), None);
        assert_eq!(failure.lock().unwrap().as_deref(), Some("No key"));
    }

    #[test]
    fn only_a_clear_yes_ends_a_check() {
        assert!(check_says_yes("YES, the bar is full."));
        assert!(check_says_yes("Ja – der Download ist fertig."));
        assert!(check_says_yes("  yes"));
        assert!(!check_says_yes("NO, still 40 %."));
        assert!(!check_says_yes("Nein."));
        assert!(!check_says_yes("Yesterday it was done"));
        assert!(!check_says_yes("I can't see the window"));
        assert!(!check_says_yes(""));
    }
}
