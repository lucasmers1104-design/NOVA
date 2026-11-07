//! Optional usage statistics. Nothing here touches the network until the user
//! clicked "Akzeptieren", except for deleting data after a withdrawal. Events
//! are a closed list: names of NOVA's own pages, widgets and tools, numbers and
//! versions, never what someone said, typed, opened or looked at.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Notify;

use crate::credentials;
use crate::storage::{self, is_identifier, new_id, now_millis, Database};

const BASE_URL: &str = "https://nova-telemetry.m-warmers.workers.dev";
/// Raise this when what is collected changes materially: everyone is asked again.
pub const CONSENT_SCOPE: u32 = 1;
const CONSENT_KEY: &str = "nova.telemetry";
const TOKEN_TARGET: &str = "NOVA:telemetry:token";
/// Tokens of withdrawn installations whose data still has to be deleted.
const DELETE_TARGET: &str = "NOVA:telemetry:delete";

const TICK: Duration = Duration::from_secs(30);
const TICK_MS: u64 = 30_000;
const ACTIVE_HEARTBEAT_MS: i64 = 60_000;
const BACKGROUND_HEARTBEAT_MS: i64 = 300_000;
const UPLOAD_EVERY_MS: i64 = 300_000;
const UPLOAD_AT_ROWS: i64 = 50;
const BATCH: i64 = 200;
const MAX_BUFFER: usize = 500;
const MAX_ROWS: i64 = 5_000;
const KEEP_MS: i64 = 7 * 86_400_000;
const RECENT_TURN_MS: i64 = 120_000;
const PAUSE_MS: i64 = 6 * 3_600_000;

/// NOVA's own pages, the only values a page event may carry.
const ROUTES: &[&str] = &["home", "system", "apps", "ai", "productivity", "routines", "media", "files", "live", "studio", "plugins", "settings"];

pub fn base_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("NOVA_TELEMETRY_URL") {
        return url;
    }
    BASE_URL.to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Consent {
    accepted: bool,
    scope: u32,
    decided_at: i64,
    version: String,
    install_id: Option<String>,
    display_name: Option<String>,
}

/// No decision yet, or one made for less than NOVA would collect now.
fn needs_decision(consent: Option<&Consent>) -> bool {
    consent.is_none_or(|c| c.scope < CONSENT_SCOPE)
}

fn allows_sending(consent: Option<&Consent>) -> bool {
    consent.is_some_and(|c| c.accepted && c.scope >= CONSENT_SCOPE)
}

fn load_consent(db: &Database) -> Option<Consent> {
    let raw = db.with(|c| storage::kv_get(c, CONSENT_KEY)).ok()??;
    serde_json::from_str(&raw).ok()
}

fn save_consent(db: &Database, consent: &Consent) -> Result<(), String> {
    let value = serde_json::to_string(consent).map_err(|e| e.to_string())?;
    db.with(|c| storage::kv_set(c, CONSENT_KEY, &value))
}

/// Everything that can be reported. There is deliberately no variant with free text.
#[derive(Debug, Clone, Copy)]
pub enum Event<'a> {
    AppStart,
    Usage { active_ms: u64, run_ms: u64 },
    Page { route: &'a str, ms: u64 },
    Assistant(&'static str),
    Tool { name: &'a str, outcome: i64 },
    WidgetAdd(&'a str),
    Update { target: &'a str, ok: bool },
    Plugin(&'static str),
}

impl Event<'_> {
    fn fields(&self) -> (&'static str, Option<&str>, i64, i64) {
        match *self {
            Self::AppStart => ("app_start", None, 0, 0),
            Self::Usage { active_ms, run_ms } => ("usage", None, active_ms as i64, run_ms as i64),
            Self::Page { route, ms } => ("page", Some(route), ms as i64, 0),
            Self::Assistant(mode) => ("assistant", Some(mode), 1, 0),
            Self::Tool { name, outcome } => ("tool", Some(name), outcome, 0),
            Self::WidgetAdd(id) => ("widget_add", Some(id), 1, 0),
            Self::Update { target, ok } => ("update", Some(target), i64::from(ok), 0),
            Self::Plugin(action) => ("plugin", Some(action), 1, 0),
        }
    }

    /// Names outside the expected shape are dropped here, before anything is queued.
    fn is_clean(&self) -> bool {
        match self.fields().1 {
            Some(name) => !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'+')),
            None => true,
        }
    }
}

/// What the page may report; everything else about usage is measured here in Rust.
fn event_from_page<'a>(kind: &str, name: &'a str, value: f64) -> Option<Event<'a>> {
    let ms = if value.is_finite() && value > 0.0 { value.min(86_400_000.0) as u64 } else { 0 };
    match kind {
        "page" if ROUTES.contains(&name) => Some(Event::Page { route: name, ms }),
        "widget_add" if is_identifier(name, 40) => Some(Event::WidgetAdd(name)),
        "update" if name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')) && !name.is_empty() => Some(Event::Update { target: name, ok: value > 0.0 }),
        _ => None,
    }
}

fn event_body(id: &str, event: Event<'_>, session: &str, at: i64) -> String {
    let (kind, name, value, value2) = event.fields();
    json!({ "id": id, "session": session, "at": at, "type": kind, "name": name, "value": value, "value2": value2, "version": env!("CARGO_PKG_VERSION") }).to_string()
}

/// Waits grow from a minute to an hour; the jitter keeps PCs that went offline together apart.
fn backoff_ms(failures: u32, now: i64) -> i64 {
    let base = 60_000i64.saturating_mul(1i64 << failures.min(6)).min(3_600_000);
    base + now.rem_euclid(30_000)
}

fn clean_name(name: Option<String>) -> Option<String> {
    let name: String = name?.chars().filter(|c| !c.is_control()).take(40).collect();
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

struct Inner {
    session_id: String,
    session_started: i64,
    buffer: Vec<(String, i64, String)>,
    /// The queue row holding the usage since the last upload; rewritten with every tick,
    /// so a short session or a crash loses at most one tick.
    usage_id: String,
    active_ms: u64,
    run_ms: u64,
    active: bool,
    last_turn: i64,
    last_heartbeat: i64,
    last_upload: i64,
    last_delete_try: i64,
    retry_at: i64,
    failures: u32,
    paused_until: i64,
    last_sent: Option<i64>,
    last_error: Option<String>,
    consent: Option<Consent>,
    queue: Option<Connection>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            session_id: new_id("s"),
            session_started: now_millis(),
            buffer: Vec::new(),
            usage_id: new_id("e"),
            active_ms: 0,
            run_ms: 0,
            active: false,
            last_turn: 0,
            last_heartbeat: 0,
            last_upload: 0,
            last_delete_try: 0,
            retry_at: 0,
            failures: 0,
            paused_until: 0,
            last_sent: None,
            last_error: None,
            consent: None,
            queue: None,
        }
    }
}

impl Inner {
    fn push(&mut self, event: Event<'_>) {
        if !event.is_clean() {
            return;
        }
        let at = now_millis();
        let id = new_id("e");
        let body = event_body(&id, event, &self.session_id, at);
        if self.buffer.len() >= MAX_BUFFER {
            self.buffer.remove(0);
        }
        self.buffer.push((id, at, body));
    }

    fn failed(&mut self, error: String) {
        self.failures = self.failures.saturating_add(1);
        let now = now_millis();
        self.retry_at = now + backoff_ms(self.failures, now);
        self.last_error = Some(error);
    }

    fn succeeded(&mut self) {
        self.failures = 0;
        self.retry_at = 0;
        self.last_error = None;
    }
}

#[derive(Default)]
pub struct TelemetryState {
    sending: AtomicBool,
    inner: Mutex<Inner>,
    wake: Notify,
}

fn lock(state: &TelemetryState) -> std::sync::MutexGuard<'_, Inner> {
    state.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn open_queue(conn: &Connection) -> Result<(), rusqlite::Error> {
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    conn.execute_batch("CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, sent_at INTEGER); CREATE INDEX IF NOT EXISTS idx_queue_sent ON queue(sent_at, at);")
}

/// Writes buffered events to disk and forgets what is older than the limits.
fn store_rows(conn: &mut Connection, rows: &[(String, i64, String)], now: i64) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction()?;
    {
        let mut insert = tx.prepare_cached("INSERT OR IGNORE INTO queue (id, at, body) VALUES (?1, ?2, ?3)")?;
        for (id, at, body) in rows {
            insert.execute(params![id, at, body])?;
        }
    }
    tx.execute("DELETE FROM queue WHERE at < ?1", [now - KEEP_MS])?;
    tx.execute("DELETE FROM queue WHERE id NOT IN (SELECT id FROM queue ORDER BY at DESC LIMIT ?1)", [MAX_ROWS])?;
    tx.commit()
}

/// The running total since the last upload: one row that keeps growing, not one per tick.
fn store_usage(conn: &Connection, id: &str, at: i64, body: &str) -> Result<(), rusqlite::Error> {
    conn.execute("INSERT INTO queue (id, at, body) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET at = excluded.at, body = excluded.body", params![id, at, body]).map(|_| ())
}

fn flush<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<TelemetryState>();
    let mut inner = lock(&state);
    if inner.queue.is_none() {
        let opened = app.path().app_local_data_dir().map_err(|e| e.to_string()).and_then(|dir| {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let conn = Connection::open(dir.join("telemetry.db")).map_err(|e| e.to_string())?;
            open_queue(&conn).map_err(|e| e.to_string())?;
            Ok::<_, String>(conn)
        });
        match opened {
            Ok(conn) => inner.queue = Some(conn),
            Err(error) => {
                inner.last_error = Some(error);
                return;
            }
        }
    }
    let rows = std::mem::take(&mut inner.buffer);
    let now = now_millis();
    let usage = (inner.run_ms > 0).then(|| event_body(&inner.usage_id, Event::Usage { active_ms: inner.active_ms, run_ms: inner.run_ms }, &inner.session_id, now));
    let usage_id = inner.usage_id.clone();
    if let Some(conn) = inner.queue.as_mut() {
        let stored = store_rows(conn, &rows, now).and_then(|()| match &usage {
            Some(body) => store_usage(conn, &usage_id, now, body),
            None => Ok(()),
        });
        if let Err(error) = stored {
            inner.last_error = Some(error.to_string());
        }
    }
}

/// Runs a reported event if the user agreed, and otherwise does nothing at all.
pub fn track<R: Runtime>(app: &AppHandle<R>, event: Event<'_>) {
    let state = app.state::<TelemetryState>();
    if state.sending.load(Ordering::Relaxed) {
        lock(&state).push(event);
    }
}

/// NOVA AI was used: counts as active even if its windows didn't hold the focus.
pub fn note_activity<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<TelemetryState>();
    if state.sending.load(Ordering::Relaxed) {
        lock(&state).last_turn = now_millis();
    }
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let consent = load_consent(&app.state::<Database>());
    let state = app.state::<TelemetryState>();
    let sending = allows_sending(consent.as_ref());
    {
        let mut inner = lock(&state);
        inner.consent = consent;
        if sending {
            inner.push(Event::AppStart);
        }
    }
    state.sending.store(sending, Ordering::SeqCst);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let ticked = {
                let state = app.state::<TelemetryState>();
                tokio::select! {
                    () = tokio::time::sleep(TICK) => true,
                    () = state.wake.notified() => false,
                }
            };
            step(&app, ticked).await;
        }
    });
}

async fn step<R: Runtime>(app: &AppHandle<R>, ticked: bool) {
    delete_withdrawn(app).await;
    let state = app.state::<TelemetryState>();
    if !state.sending.load(Ordering::SeqCst) {
        return;
    }
    let now = now_millis();
    if ticked {
        let focused = ["main", crate::assistant::PANEL_LABEL].iter().any(|label| app.get_webview_window(label).and_then(|w| w.is_focused().ok()).unwrap_or(false));
        let mut inner = lock(&state);
        inner.active = focused || now - inner.last_turn < RECENT_TURN_MS;
        inner.run_ms += TICK_MS;
        if inner.active {
            inner.active_ms += TICK_MS;
        }
    }
    {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || flush(&app)).await;
    }
    let due = {
        let inner = lock(&state);
        now >= inner.retry_at && now >= inner.paused_until
    };
    if !due {
        return;
    }

    let token = match credentials::get(TOKEN_TARGET).ok().flatten() {
        Some(token) => token,
        None => {
            register(app).await;
            return;
        }
    };

    let (beat_due, name, active, session_id, started) = {
        let inner = lock(&state);
        let every = if inner.active { ACTIVE_HEARTBEAT_MS } else { BACKGROUND_HEARTBEAT_MS };
        (now - inner.last_heartbeat >= every, inner.consent.as_ref().and_then(|c| c.display_name.clone()), inner.active, inner.session_id.clone(), inner.session_started)
    };
    if beat_due {
        let body = json!({ "sessionId": session_id, "sessionStartedAt": started, "state": if active { "active" } else { "background" }, "version": env!("CARGO_PKG_VERSION"), "displayName": name });
        match post(&token, "/v1/heartbeat", body.to_string().into_bytes()).await {
            Ok(reply) => {
                let mut inner = lock(&state);
                inner.last_heartbeat = now;
                apply_reply(&mut inner, &reply);
                inner.succeeded();
            }
            Err(failure) => {
                handle_failure(app, failure);
                return;
            }
        }
    }

    if !state.sending.load(Ordering::SeqCst) {
        return;
    }
    upload(app, &token, now).await;
}

fn apply_reply(inner: &mut Inner, reply: &Value) {
    if reply["ingest"] == json!(false) {
        inner.paused_until = now_millis() + PAUSE_MS;
    }
}

enum Failure {
    Rejected,
    Other(String),
}

fn handle_failure<R: Runtime>(app: &AppHandle<R>, failure: Failure) {
    let state = app.state::<TelemetryState>();
    match failure {
        // The server no longer knows this installation: start over with a new id.
        Failure::Rejected => {
            let _ = credentials::delete(TOKEN_TARGET);
            lock(&state).failed("The statistics service no longer knew this installation".into());
        }
        Failure::Other(error) => lock(&state).failed(error),
    }
}

async fn post(token: &str, path: &str, body: Vec<u8>) -> Result<Value, Failure> {
    let compressed = {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&body).and_then(|()| encoder.finish()).map_err(|e| Failure::Other(e.to_string()))?
    };
    let response = crate::http::client()
        .post(format!("{}{path}", base_url()))
        .timeout(Duration::from_secs(20))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(compressed)
        .send()
        .await
        .map_err(|e| Failure::Other(crate::http::describe(e)))?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(Failure::Rejected);
    }
    if !status.is_success() {
        return Err(Failure::Other(format!("The statistics service answered with HTTP {}", status.as_u16())));
    }
    let bytes = crate::http::read_limited(response, 64 * 1024).await.map_err(Failure::Other)?;
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn register<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<TelemetryState>();
    let body = json!({ "appVersion": env!("CARGO_PKG_VERSION"), "consentScope": CONSENT_SCOPE }).to_string();
    let response = crate::http::client()
        .post(format!("{}/v1/installations", base_url()))
        .timeout(Duration::from_secs(20))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => return lock(&state).failed(crate::http::describe(error)),
    };
    let status = response.status();
    if !status.is_success() {
        return lock(&state).failed(format!("The statistics service answered with HTTP {}", status.as_u16()));
    }
    let bytes = match crate::http::read_limited(response, 4096).await {
        Ok(bytes) => bytes,
        Err(error) => return lock(&state).failed(error),
    };
    let reply: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let (Some(id), Some(token)) = (reply["installId"].as_str(), reply["token"].as_str()) else {
        return lock(&state).failed("The statistics service sent an unexpected reply".into());
    };
    // Withdrawn while this was on its way: the new registration goes straight to the delete list.
    if !state.sending.load(Ordering::SeqCst) {
        queue_for_deletion(token);
        return;
    }
    if let Err(error) = credentials::set(TOKEN_TARGET, token) {
        return lock(&state).failed(error);
    }
    let consent = {
        let mut inner = lock(&state);
        inner.succeeded();
        if let Some(consent) = inner.consent.as_mut() {
            consent.install_id = Some(id.to_string());
        }
        inner.consent.clone()
    };
    if let Some(consent) = consent {
        let _ = save_consent(&app.state::<Database>(), &consent);
    }
    state.wake.notify_one();
}

async fn upload<R: Runtime>(app: &AppHandle<R>, token: &str, now: i64) {
    let state = app.state::<TelemetryState>();
    {
        let mut inner = lock(&state);
        let waiting = inner.queue.as_ref().and_then(|c| c.query_row("SELECT count(*) FROM queue WHERE sent_at IS NULL", [], |r| r.get::<_, i64>(0)).ok()).unwrap_or(0);
        if now - inner.last_upload < UPLOAD_EVERY_MS && waiting < UPLOAD_AT_ROWS {
            return;
        }
        inner.last_upload = now;
        // The usage row goes out with this batch; what comes now starts a new one.
        inner.usage_id = new_id("e");
        inner.active_ms = 0;
        inner.run_ms = 0;
    }

    let batch: Vec<(String, String)> = {
        let inner = lock(&state);
        let Some(conn) = inner.queue.as_ref() else { return };
        let rows = conn.prepare_cached("SELECT id, body FROM queue WHERE sent_at IS NULL ORDER BY at LIMIT ?1").and_then(|mut statement| {
            statement.query_map([BATCH], |row| Ok((row.get(0)?, row.get(1)?))).and_then(Iterator::collect)
        });
        rows.unwrap_or_default()
    };
    if batch.is_empty() {
        return;
    }
    let events: Vec<Value> = batch.iter().filter_map(|(_, body)| serde_json::from_str(body).ok()).collect();
    let body = json!({ "events": events }).to_string().into_bytes();
    match post(token, "/v1/events", body).await {
        Ok(reply) => {
            let mut inner = lock(&state);
            apply_reply(&mut inner, &reply);
            if reply["ingest"] == json!(false) {
                return;
            }
            let sent_at = now_millis();
            if let Some(conn) = inner.queue.as_ref() {
                for (id, _) in &batch {
                    let _ = conn.execute("UPDATE queue SET sent_at = ?1 WHERE id = ?2", params![sent_at, id]);
                }
            }
            inner.last_sent = Some(sent_at);
            inner.succeeded();
        }
        Err(failure) => handle_failure(app, failure),
    }
}

fn queue_for_deletion(token: &str) {
    let mut waiting = credentials::get(DELETE_TARGET).ok().flatten().unwrap_or_default();
    if !waiting.is_empty() {
        waiting.push(',');
    }
    waiting.push_str(token);
    let _ = credentials::set(DELETE_TARGET, &waiting);
}

/// Deleting after a withdrawal is the one request that needs no consent; it is what
/// was asked for. It keeps trying until the server confirmed it.
async fn delete_withdrawn<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<TelemetryState>();
    let now = now_millis();
    {
        let mut inner = lock(&state);
        if now - inner.last_delete_try < UPLOAD_EVERY_MS {
            return;
        }
        inner.last_delete_try = now;
    }
    let Some(waiting) = credentials::get(DELETE_TARGET).ok().flatten() else { return };
    let mut left = Vec::new();
    for token in waiting.split(',').filter(|t| !t.is_empty()) {
        let done = crate::http::client()
            .delete(format!("{}/v1/installations/me", base_url()))
            .timeout(Duration::from_secs(20))
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success());
        if !done {
            left.push(token);
        }
    }
    if left.is_empty() {
        let _ = credentials::delete(DELETE_TARGET);
    } else {
        let _ = credentials::set(DELETE_TARGET, &left.join(","));
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStatus {
    needs_decision: bool,
    accepted: bool,
    decided_at: Option<i64>,
    install_id: Option<String>,
    display_name: Option<String>,
    last_sent: Option<i64>,
    last_error: Option<String>,
    waiting: i64,
    privacy_url: String,
    host: String,
}

fn status_of<R: Runtime>(app: &AppHandle<R>) -> TelemetryStatus {
    let state = app.state::<TelemetryState>();
    let inner = lock(&state);
    let consent = inner.consent.as_ref();
    let base = base_url();
    let waiting = inner.queue.as_ref().and_then(|c| c.query_row("SELECT count(*) FROM queue WHERE sent_at IS NULL", [], |r| r.get::<_, i64>(0)).ok()).unwrap_or(0) + inner.buffer.len() as i64;
    TelemetryStatus {
        needs_decision: needs_decision(consent),
        accepted: allows_sending(consent),
        decided_at: consent.map(|c| c.decided_at),
        install_id: consent.and_then(|c| c.install_id.clone()),
        display_name: consent.and_then(|c| c.display_name.clone()),
        last_sent: inner.last_sent,
        last_error: inner.last_error.clone(),
        waiting,
        privacy_url: format!("{base}/privacy"),
        host: base.trim_start_matches("https://").trim_start_matches("http://").to_string(),
    }
}

#[tauri::command]
pub async fn telemetry_status<R: Runtime>(app: AppHandle<R>) -> Result<TelemetryStatus, String> {
    Ok(status_of(&app))
}

/// The click in the popup or in Settings. The decision is saved before anything else
/// happens: if it can't be saved, nothing is sent.
#[tauri::command]
pub async fn telemetry_decide<R: Runtime>(app: AppHandle<R>, accepted: bool) -> Result<TelemetryStatus, String> {
    let state = app.state::<TelemetryState>();
    let previous = lock(&state).consent.clone();
    let consent = Consent {
        accepted,
        scope: CONSENT_SCOPE,
        decided_at: now_millis(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        install_id: if accepted { previous.as_ref().and_then(|c| c.install_id.clone()) } else { None },
        display_name: if accepted { previous.as_ref().and_then(|c| c.display_name.clone()) } else { None },
    };
    save_consent(&app.state::<Database>(), &consent)?;

    state.sending.store(accepted, Ordering::SeqCst);
    {
        let mut inner = lock(&state);
        inner.consent = Some(consent);
        inner.succeeded();
        inner.last_delete_try = 0;
        if accepted {
            inner.session_id = new_id("s");
            inner.session_started = now_millis();
            inner.last_heartbeat = 0;
            inner.push(Event::AppStart);
        } else {
            inner.buffer.clear();
            inner.active_ms = 0;
            inner.run_ms = 0;
            inner.last_sent = None;
            if let Some(conn) = inner.queue.as_ref() {
                let _ = conn.execute("DELETE FROM queue", []);
            }
        }
    }
    if !accepted {
        if let Some(token) = credentials::get(TOKEN_TARGET).ok().flatten() {
            queue_for_deletion(&token);
            let _ = credentials::delete(TOKEN_TARGET);
        }
    }
    state.wake.notify_one();
    Ok(status_of(&app))
}

#[tauri::command]
pub async fn telemetry_track<R: Runtime>(app: AppHandle<R>, kind: String, name: String, value: f64) -> Result<(), String> {
    if let Some(event) = event_from_page(&kind, &name, value) {
        track(&app, event);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentEvent {
    at: i64,
    sent_at: Option<i64>,
    body: Value,
}

/// What this PC queued and sent in the last seven days, for the view in Settings.
#[tauri::command]
pub async fn telemetry_recent<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SentEvent>, String> {
    let worker = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if worker.state::<TelemetryState>().sending.load(Ordering::SeqCst) {
            flush(&worker);
        }
    })
    .await;
    let state = app.state::<TelemetryState>();
    let inner = lock(&state);
    let Some(conn) = inner.queue.as_ref() else { return Ok(Vec::new()) };
    let mut statement = conn.prepare_cached("SELECT at, sent_at, body FROM queue ORDER BY at DESC LIMIT 200").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| {
        let body: String = row.get(2)?;
        Ok(SentEvent { at: row.get(0)?, sent_at: row.get(1)?, body: serde_json::from_str(&body).unwrap_or(Value::Null) })
    });
    rows.and_then(Iterator::collect).map_err(|e| e.to_string())
}

/// A name for the dashboard; none unless someone enters one.
#[tauri::command]
pub async fn telemetry_set_name<R: Runtime>(app: AppHandle<R>, name: Option<String>) -> Result<TelemetryStatus, String> {
    let state = app.state::<TelemetryState>();
    let consent = {
        let mut inner = lock(&state);
        inner.last_heartbeat = 0;
        let Some(consent) = inner.consent.as_mut() else { return Err("Decide about the statistics first".into()) };
        consent.display_name = clean_name(name);
        consent.clone()
    };
    save_consent(&app.state::<Database>(), &consent)?;
    state.wake.notify_one();
    Ok(status_of(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consent(accepted: bool, scope: u32) -> Consent {
        Consent { accepted, scope, ..Consent::default() }
    }

    #[test]
    fn asks_once_and_again_only_when_the_scope_grows() {
        assert!(needs_decision(None));
        assert!(!needs_decision(Some(&consent(true, CONSENT_SCOPE))));
        assert!(!needs_decision(Some(&consent(false, CONSENT_SCOPE))));
        assert!(needs_decision(Some(&consent(true, CONSENT_SCOPE - 1))));
        assert!(needs_decision(Some(&consent(false, CONSENT_SCOPE - 1))));
    }

    #[test]
    fn sends_only_after_acceptance_of_the_current_scope() {
        assert!(!allows_sending(None));
        assert!(!allows_sending(Some(&consent(false, CONSENT_SCOPE))));
        assert!(!allows_sending(Some(&consent(true, CONSENT_SCOPE - 1))));
        assert!(allows_sending(Some(&consent(true, CONSENT_SCOPE))));
    }

    #[test]
    fn the_page_can_only_report_known_shapes() {
        assert!(event_from_page("page", "media", 1000.0).is_some());
        assert!(event_from_page("page", "C:\\Users\\Luca\\secret.txt", 1.0).is_none());
        assert!(event_from_page("page", "not-a-page", 1.0).is_none());
        assert!(event_from_page("widget_add", "cpu", 1.0).is_some());
        assert!(event_from_page("widget_add", "hello world", 1.0).is_none());
        assert!(event_from_page("update", "1.10.1", 1.0).is_some());
        assert!(event_from_page("update", "free text", 1.0).is_none());
        assert!(event_from_page("usage", "x", 1.0).is_none());
        assert!(event_from_page("keystrokes", "x", 1.0).is_none());
    }

    #[test]
    fn a_tool_name_with_anything_odd_is_dropped_before_it_is_queued() {
        let mut inner = Inner::default();
        inner.push(Event::Tool { name: "open_app", outcome: 1 });
        inner.push(Event::Tool { name: "C:\\secret folder", outcome: 1 });
        inner.push(Event::Tool { name: "", outcome: 1 });
        assert_eq!(inner.buffer.len(), 1);
    }

    #[test]
    fn a_queued_event_holds_only_the_agreed_fields() {
        let mut inner = Inner::default();
        inner.push(Event::Page { route: "media", ms: 1200 });
        let body: Value = serde_json::from_str(&inner.buffer[0].2).unwrap();
        let mut keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["at", "id", "name", "session", "type", "value", "value2", "version"]);
        assert_eq!(body["name"], "media");
        assert_eq!(body["value"], 1200);
    }

    #[test]
    fn the_buffer_stays_bounded() {
        let mut inner = Inner::default();
        for _ in 0..(MAX_BUFFER + 25) {
            inner.push(Event::AppStart);
        }
        assert_eq!(inner.buffer.len(), MAX_BUFFER);
    }

    #[test]
    fn waits_grow_to_an_hour() {
        assert!((60_000..90_000).contains(&backoff_ms(0, 7)));
        assert!(backoff_ms(2, 0) >= 240_000);
        assert!(backoff_ms(30, 29_999) <= 3_630_000);
    }

    #[test]
    fn the_queue_forgets_old_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        open_queue(&conn).unwrap();
        let now = now_millis();
        store_rows(&mut conn, &[("old".into(), now - KEEP_MS - 1, "{}".into()), ("new".into(), now, "{}".into())], now).unwrap();
        let ids: Vec<String> = conn.prepare("SELECT id FROM queue").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(ids, ["new"]);
    }

    #[test]
    fn usage_is_one_growing_row_that_survives_a_restart() {
        let conn = Connection::open_in_memory().unwrap();
        open_queue(&conn).unwrap();
        store_usage(&conn, "u1", 1, r#"{"value":30000}"#).unwrap();
        store_usage(&conn, "u1", 2, r#"{"value":60000}"#).unwrap();
        let rows: Vec<String> = conn.prepare("SELECT body FROM queue").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(rows, [r#"{"value":60000}"#]);
    }

    #[test]
    fn names_stay_short_and_plain() {
        assert_eq!(clean_name(Some("  Luca\u{0} ".into())).as_deref(), Some("Luca"));
        assert_eq!(clean_name(Some("   ".into())), None);
        assert_eq!(clean_name(None), None);
        assert_eq!(clean_name(Some("x".repeat(99))).unwrap().len(), 40);
    }
}
