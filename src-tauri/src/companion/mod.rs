//! NOVA Companion: the phone as a channel for tasks to NOVA AI on this PC.
//! See docs/mobile/PLAN.md. The phone is a thin client; the AI, the keys and the
//! log stay here. Runs only while NOVA's signed "NOVA Companion" plugin is installed,
//! on and allowed (plugins.rs), and the user turned the connection on in its page.

pub mod crypto;
mod mdns;
pub mod policy;
pub mod protocol;
pub mod queue;
mod server;
pub mod tasks;
#[cfg(all(test, feature = "companion-e2e"))]
mod tests;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::storage::{self, Database};
use crypto::KeyPair;
use policy::AllowedApp;
use protocol::{PcMessage, Platform};

type CommandResult<T> = Result<T, String>;

const CONFIG_KEY: &str = "nova.companion";
/// SECURITY: the PC's long-term private key lives only in Windows Credential Manager.
#[cfg(not(test))]
const KEY_TARGET: &str = "NOVA:companion:key";
/// SECURITY: each phone's approval key (the HMAC key its biometric unlock releases).
#[cfg(not(test))]
const DEVICE_TARGET: &str = "NOVA:companion:device:";
// Tests never touch the real keys.
#[cfg(test)]
const KEY_TARGET: &str = "NOVA:companion-test:key";
#[cfg(test)]
const DEVICE_TARGET: &str = "NOVA:companion-test:device:";
const DEFAULT_PORT: u16 = 47621;
/// SECURITY: how long a pairing QR code works, and it works once.
const PAIRING_LIFETIME: Duration = Duration::from_secs(120);
const MOST_DEVICES: usize = 10;
const MOST_ALLOWED: usize = 100;
pub const EVENT_CHANGED: &str = "companion://changed";
pub const EVENT_PAIR_REQUEST: &str = "companion://pair-request";
const DEFAULT_SOURCE: &str = "lucasmers1104-design/NOVA";
/// The phone app, next to NOVA's own installers in releases/.
const APK_FILE: &str = "NOVA-Companion.apk";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    /// Keep the screenshots sent to the phone for 7 days.
    pub keep_screenshots: bool,
    pub allowlist: Vec<AllowedApp>,
    pub pc_id: String,
}

pub fn config<R: Runtime>(app: &AppHandle<R>) -> Config {
    let db = app.state::<Database>();
    let mut config: Config = db.with(|c| storage::kv_get(c, CONFIG_KEY)).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    if config.pc_id.is_empty() {
        config.pc_id = crypto::b64(&crypto::random::<9>());
        let _ = save_config(app, &config);
    }
    if config.port == 0 {
        config.port = DEFAULT_PORT;
    }
    config
}

fn save_config<R: Runtime>(app: &AppHandle<R>, config: &Config) -> CommandResult<()> {
    let raw = serde_json::to_string(config).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, CONFIG_KEY, &raw))
}

pub fn allowlist<R: Runtime>(app: &AppHandle<R>) -> Vec<AllowedApp> {
    config(app).allowlist
}

/// SECURITY: created once, then only read here; never sent anywhere but as its public half.
fn pc_key() -> CommandResult<KeyPair> {
    if let Some(secret) = crate::credentials::get(KEY_TARGET)?.as_deref().and_then(crypto::unb64_32) {
        return Ok(KeyPair::from_secret(secret));
    }
    let pair = KeyPair::generate();
    crate::credentials::set(KEY_TARGET, &crypto::b64(&pair.secret_bytes()))?;
    Ok(pair)
}

fn approval_key(device_id: &str) -> Option<[u8; 32]> {
    crate::credentials::get(&format!("{DEVICE_TARGET}{device_id}")).ok().flatten().as_deref().and_then(crypto::unb64_32)
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub paired_at: i64,
    pub last_seen: Option<i64>,
    pub connected: bool,
}

fn devices<R: Runtime>(app: &AppHandle<R>) -> Vec<Device> {
    let connected: Vec<String> = lock(&state(app).conns).iter().map(|c| c.device_id.clone()).collect();
    app.state::<Database>()
        .with(|c| {
            let mut statement = c.prepare("SELECT id, name, platform, paired_at, last_seen FROM companion_devices ORDER BY paired_at")?;
            let rows = statement.query_map([], |row| {
                Ok(Device { id: row.get(0)?, name: row.get(1)?, platform: row.get(2)?, paired_at: row.get(3)?, last_seen: row.get(4)?, connected: false })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap_or_default()
        .into_iter()
        .map(|d| Device { connected: connected.contains(&d.id), ..d })
        .collect()
}

/// The device's public key and name, if it is paired.
fn device<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<([u8; 32], String)> {
    let (key, name): (String, String) = app
        .state::<Database>()
        .with(|c| Ok(c.query_row("SELECT public_key, name FROM companion_devices WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?)))?))
        .ok()?;
    Some((crypto::unb64_32(&key)?, name))
}

fn touch_device<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.state::<Database>().with(|c| Ok(c.execute("UPDATE companion_devices SET last_seen = ?2 WHERE id = ?1", params![id, storage::now_millis()])?));
}

/// SECURITY: called only after the user clicked "Pair" on this PC.
fn add_device<R: Runtime>(app: &AppHandle<R>, details: &protocol::PairDetails) -> CommandResult<String> {
    if devices(app).len() >= MOST_DEVICES {
        return Err(format!("Up to {MOST_DEVICES} phones can be paired"));
    }
    let id = crypto::b64(&crypto::random::<12>());
    crate::credentials::set(&format!("{DEVICE_TARGET}{id}"), &details.approval_key)?;
    app.state::<Database>().with(|c| {
        Ok(c.execute(
            "INSERT INTO companion_devices (id, name, platform, public_key, paired_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, details.device_name, details.platform.as_str(), details.device_pub, storage::now_millis()],
        )?)
    })?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// State: the server, pairing and open connections
// ---------------------------------------------------------------------------

pub struct Conn {
    id: u64,
    pub device_id: String,
    tx: mpsc::Sender<PcMessage>,
    /// Set on revoke: the connection says so and closes.
    revoked: Arc<AtomicBool>,
}

struct Pairing {
    secret: [u8; 32],
    expires: Instant,
    used: bool,
}

pub struct PairAsk {
    pub device_name: String,
    pub platform: Platform,
    answer: mpsc::Sender<bool>,
}

#[derive(Default)]
pub struct CompanionState {
    server: Mutex<Option<server::Server>>,
    pairing: Mutex<Option<Pairing>>,
    pair_ask: Mutex<Option<PairAsk>>,
    conns: Mutex<Vec<Conn>>,
    next_conn: AtomicU64,
    /// Why the server isn't running although it is on.
    error: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &CompanionState {
    app.state::<CompanionState>().inner()
}

fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT_CHANGED, ());
}

/// Sends to every open connection of a device; `false` if none is open.
pub fn send_to<R: Runtime>(app: &AppHandle<R>, device_id: &str, message: PcMessage) -> bool {
    let conns = lock(&state(app).conns);
    let mut sent = false;
    for conn in conns.iter().filter(|c| c.device_id == device_id) {
        sent |= conn.tx.send(message.clone()).is_ok();
    }
    sent
}

pub fn connected<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> bool {
    lock(&state(app).conns).iter().any(|c| c.device_id == device_id)
}

fn add_conn<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> (u64, mpsc::Receiver<PcMessage>, Arc<AtomicBool>) {
    let (tx, rx) = mpsc::channel();
    let revoked = Arc::new(AtomicBool::new(false));
    let id = state(app).next_conn.fetch_add(1, Ordering::SeqCst);
    lock(&state(app).conns).push(Conn { id, device_id: device_id.to_string(), tx, revoked: revoked.clone() });
    touch_device(app, device_id);
    changed(app);
    (id, rx, revoked)
}

fn remove_conn<R: Runtime>(app: &AppHandle<R>, id: u64) {
    lock(&state(app).conns).retain(|c| c.id != id);
    changed(app);
}

/// Starts or stops the server to match the settings. Called at startup and on changes.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    let config = config(app);
    let mut server = lock(&state(app).server);
    if !config.enabled || !crate::plugins::companion_unlocked(app) {
        *server = None;
        *lock(&state(app).error) = None;
        return;
    }
    if server.is_some() {
        return;
    }
    let started = pc_key().and_then(|key| server::Server::start(app.clone(), key, &config));
    match started {
        Ok(running) => {
            if running.port != config.port {
                let _ = save_config(app, &Config { port: running.port, ..config });
            }
            *server = Some(running);
            *lock(&state(app).error) = None;
        }
        Err(error) => {
            eprintln!("[NOVA] companion: {error}");
            *lock(&state(app).error) = Some(error);
        }
    }
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    apply(app);
    tasks::start(app);
}

/// Private IPv4 addresses of this PC, best first: what the QR code offers the phone.
/// Adapters a phone in the home network can't reach: virtual machines, WSL, containers, VPNs.
fn virtual_adapter(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["vmware", "virtualbox", "vethernet", "hyper-v", "wsl", "docker", "loopback", "tailscale", "zerotier", "wireguard", "openvpn", "tap-", "npcap"].iter().any(|word| name.contains(word))
}

fn lan_addresses() -> Vec<std::net::Ipv4Addr> {
    let Ok(networks) = sysinfo::Networks::new_with_refreshed_list() else { return Vec::new() };
    let mut found: Vec<std::net::Ipv4Addr> = networks
        .iter()
        .filter(|(name, _)| !virtual_adapter(&name.to_string_lossy()))
        .flat_map(|(_, data)| data.ip_networks().iter().map(|n| n.addr))
        .filter_map(|addr| match addr {
            std::net::IpAddr::V4(v4) if v4.is_private() => Some(v4),
            _ => None,
        })
        .collect();
    found.sort_by_key(|ip| match ip.octets() {
        [192, 168, ..] => 0,
        [10, ..] => 1,
        _ => 2,
    });
    found.dedup();
    found.truncate(4);
    found
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/// The connection thread asks: is this secret the live pairing code? Marks it used.
/// SECURITY: single use; an expired or used code never pairs.
pub(crate) fn take_pairing<R: Runtime>(app: &AppHandle<R>, mut try_secret: impl FnMut(&[u8; 32]) -> bool) -> Result<[u8; 32], protocol::RejectReason> {
    let mut pairing = lock(&state(app).pairing);
    let Some(current) = pairing.as_mut() else { return Err(protocol::RejectReason::Expired) };
    if current.expires < Instant::now() {
        return Err(protocol::RejectReason::Expired);
    }
    if current.used {
        return Err(protocol::RejectReason::Used);
    }
    if !try_secret(&current.secret) {
        return Err(protocol::RejectReason::Invalid);
    }
    current.used = true;
    Ok(current.secret)
}

/// Asks the user on this PC, waits for the click. `false` on decline or after two minutes.
pub(crate) fn ask_user<R: Runtime>(app: &AppHandle<R>, details: &protocol::PairDetails) -> bool {
    let (answer, decision) = mpsc::channel();
    {
        let mut ask = lock(&state(app).pair_ask);
        if ask.is_some() {
            return false;
        }
        *ask = Some(PairAsk { device_name: details.device_name.clone(), platform: details.platform, answer });
    }
    let _ = app.emit(EVENT_PAIR_REQUEST, serde_json::json!({ "deviceName": details.device_name, "platform": details.platform }));
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let approved = decision.recv_timeout(PAIRING_LIFETIME).unwrap_or(false);
    *lock(&state(app).pair_ask) = None;
    *lock(&state(app).pairing) = None;
    approved
}

pub(crate) fn finish_pairing<R: Runtime>(app: &AppHandle<R>, details: &protocol::PairDetails) -> CommandResult<String> {
    let id = add_device(app, details)?;
    changed(app);
    Ok(id)
}

// ---------------------------------------------------------------------------
// Status for the phone
// ---------------------------------------------------------------------------

pub fn pc_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into()).chars().take(60).collect()
}

fn media() -> Option<protocol::Media> {
    #[cfg(windows)]
    {
        let state = crate::media::platform::state().ok().flatten()?;
        let value = serde_json::to_value(state).ok()?;
        let title = value["title"].as_str().unwrap_or_default().chars().take(200).collect::<String>();
        if title.is_empty() {
            return None;
        }
        Some(protocol::Media { title, artist: value["artist"].as_str().unwrap_or_default().chars().take(200).collect(), playing: value["status"] == "playing" })
    }
    #[cfg(not(windows))]
    None
}

pub fn status<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> PcMessage {
    PcMessage::Status {
        id: protocol::new_id(),
        ts: protocol::now(),
        pc_name: pc_name(),
        busy: crate::agent::busy(app),
        ai_ready: crate::agent::ai_ready(app),
        in_game: crate::assistant::in_game(app),
        media: media(),
        pending_approvals: tasks::pending_approvals(device_id),
        active_tasks: tasks::active_count(app, device_id),
    }
}

// ---------------------------------------------------------------------------
// What the NOVA Companion plugin's page can do (plugin_call → plugin_call below)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    enabled: bool,
    listening: bool,
    port: u16,
    addresses: Vec<String>,
    error: Option<String>,
    keep_screenshots: bool,
    allowlist: Vec<AllowedApp>,
    devices: Vec<Device>,
    /// A phone that scanned the code and waits for "Pair".
    pair_request: Option<serde_json::Value>,
}

fn status_view<R: Runtime>(app: &AppHandle<R>) -> CompanionStatus {
    let config = config(app);
    let listening = lock(&state(app).server).is_some();
    let pair_request = lock(&state(app).pair_ask).as_ref().map(|ask| serde_json::json!({ "deviceName": ask.device_name, "platform": ask.platform }));
    CompanionStatus {
        enabled: config.enabled,
        listening,
        port: config.port,
        addresses: if listening { lan_addresses().iter().map(|ip| ip.to_string()).collect() } else { Vec::new() },
        error: lock(&state(app).error).clone(),
        keep_screenshots: config.keep_screenshots,
        allowlist: config.allowlist,
        devices: devices(app),
        pair_request,
    }
}

async fn companion_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<CompanionStatus> {
    tauri::async_runtime::spawn_blocking(move || status_view(&app)).await.map_err(|e| e.to_string())
}

async fn companion_configure<R: Runtime>(app: AppHandle<R>, enabled: Option<bool>, keep_screenshots: Option<bool>) -> CommandResult<CompanionStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut config = config(&app);
        if let Some(enabled) = enabled {
            config.enabled = enabled;
        }
        if let Some(keep) = keep_screenshots {
            config.keep_screenshots = keep;
            if !keep {
                tasks::delete_screenshots(&app, None);
            }
        }
        save_config(&app, &config)?;
        apply(&app);
        changed(&app);
        Ok(status_view(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    kind: policy::AllowedKind,
    id: String,
    name: String,
}

/// What can go on the allowlist: the app catalog and the installed Epic and Steam games.
async fn companion_allow_candidates<R: Runtime>(app: AppHandle<R>) -> CommandResult<Vec<Candidate>> {
    tauri::async_runtime::spawn_blocking(move || {
        let (apps, _) = app.state::<crate::apps::AppCatalog>().scanned(false)?;
        let mut list: Vec<Candidate> = apps.iter().map(|a| Candidate { kind: policy::AllowedKind::App, id: a.id.clone(), name: a.name.clone() }).collect();
        list.extend(crate::agent::games::library().into_iter().map(|g| Candidate { kind: policy::AllowedKind::Game, id: g.link, name: g.name }));
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// SECURITY: only ids that exist in the catalog or game library get on the list.
async fn companion_set_allowlist<R: Runtime>(app: AppHandle<R>, allowlist: Vec<AllowedApp>) -> CommandResult<CompanionStatus> {
    let known = companion_allow_candidates(app.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut checked: Vec<AllowedApp> = Vec::new();
        for entry in allowlist.into_iter().take(MOST_ALLOWED) {
            let Some(found) = known.iter().find(|c| c.kind == entry.kind && c.id == entry.id) else { continue };
            if !checked.iter().any(|c| c.kind == entry.kind && c.id == entry.id) {
                checked.push(AllowedApp { kind: found.kind, id: found.id.clone(), name: found.name.clone() });
            }
        }
        let mut config = config(&app);
        config.allowlist = checked;
        save_config(&app, &config)?;
        changed(&app);
        Ok(status_view(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// The QR code as an SVG document.
    svg: String,
    expires_at: u64,
}

fn qr_svg(text: &str) -> CommandResult<String> {
    let qr = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium).map_err(|_| "The pairing code is too long".to_string())?;
    let border = 4;
    let size = qr.size() + border * 2;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
            }
        }
    }
    Ok(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="{path}" fill="#000"/></svg>"##
    ))
}

/// SECURITY: a fresh one-time secret each time; it is only ever shown on this PC's screen.
async fn companion_pair_start<R: Runtime>(app: AppHandle<R>) -> CommandResult<PairingView> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = config(&app);
        if lock(&state(&app).server).is_none() {
            return Err("Turn on the phone connection first".to_string());
        }
        let hosts: Vec<String> = lan_addresses().iter().map(|ip| format!("{ip}:{}", config.port)).collect();
        if hosts.is_empty() {
            return Err("This PC isn't connected to a local network".to_string());
        }
        let secret = crypto::random::<32>();
        let expires_at = protocol::now() + PAIRING_LIFETIME.as_millis() as u64;
        *lock(&state(&app).pairing) = Some(Pairing { secret, expires: Instant::now() + PAIRING_LIFETIME, used: false });
        let code = format!(
            "nova-companion:1?pc={}&pk={}&s={}&h={}&exp={expires_at}",
            config.pc_id,
            crypto::b64(&pc_key()?.public),
            crypto::b64(&secret),
            hosts.join(",")
        );
        Ok(PairingView { svg: qr_svg(&code)?, expires_at })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn companion_pair_cancel<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    *lock(&state(&app).pairing) = None;
    if let Some(ask) = lock(&state(&app).pair_ask).take() {
        let _ = ask.answer.send(false);
    }
    Ok(())
}

/// The user's answer to "Pair this phone?", from NOVA's own dialog (PairDialog.tsx).
/// SECURITY: deliberately not a plugin method: the plugin can't let a phone in by itself.
#[tauri::command]
pub async fn companion_pair_decide<R: Runtime>(app: AppHandle<R>, approved: bool) -> CommandResult<()> {
    let ask = lock(&state(&app).pair_ask).take().ok_or("No phone is waiting to pair")?;
    let _ = ask.answer.send(approved);
    Ok(())
}

/// SECURITY: forgets the device's keys, closes its connections at once and drops its tasks.
pub(crate) async fn companion_revoke<R: Runtime>(app: AppHandle<R>, device_id: String) -> CommandResult<CompanionStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Database>().with(|c| {
            c.execute("DELETE FROM companion_devices WHERE id = ?1", [&device_id])?;
            c.execute("UPDATE companion_jobs SET state = 'cancelled' WHERE device_id = ?1 AND state IN ('queued', 'scheduled')", [&device_id])?;
            c.execute("DELETE FROM companion_notices WHERE device_id = ?1", [&device_id])?;
            Ok(())
        })?;
        let _ = crate::credentials::delete(&format!("{DEVICE_TARGET}{device_id}"));
        tasks::cancel_device(&app, &device_id);
        for conn in lock(&state(&app).conns).iter().filter(|c| c.device_id == device_id) {
            conn.revoked.store(true, Ordering::SeqCst);
        }
        changed(&app);
        Ok(status_view(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    id: String,
    device: String,
    text: String,
    state: String,
    run_at: Option<String>,
    created_at: i64,
    finished_at: Option<i64>,
    result: Option<String>,
}

/// The local log of tasks from phones. Approvals and tool calls are in NOVA AI's action history.
async fn companion_log<R: Runtime>(app: AppHandle<R>) -> CommandResult<Vec<LogEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Database>().with(|c| {
            let mut statement = c.prepare(
                "SELECT j.id, COALESCE(d.name, 'Removed phone'), j.text, j.state, j.run_date || ' ' || j.run_time, j.created_at, j.finished_at, j.result
                 FROM companion_jobs j LEFT JOIN companion_devices d ON d.id = j.device_id ORDER BY j.created_at DESC LIMIT 200",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(LogEntry {
                    id: row.get(0)?,
                    device: row.get(1)?,
                    text: row.get(2)?,
                    state: row.get(3)?,
                    run_at: row.get(4)?,
                    created_at: row.get(5)?,
                    finished_at: row.get(6)?,
                    result: row.get(7)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn companion_clear_log<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    app.state::<Database>().with(|c| Ok(c.execute("DELETE FROM companion_jobs WHERE state NOT IN ('queued', 'scheduled', 'running')", [])?))?;
    changed(&app);
    Ok(())
}

/// Where the phone app is offered: next to the releases of NOVA's update source.
fn app_download<R: Runtime>(app: &AppHandle<R>) -> CommandResult<serde_json::Value> {
    let settings = app.state::<Database>().with(|c| storage::kv_get(c, "nova.settings")).ok().flatten();
    let source = settings
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value["state"]["updateSource"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
        .unwrap_or_else(|| DEFAULT_SOURCE.into());
    let url = crate::updates::manifest_url(&source)?.join(APK_FILE).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "url": url.as_str(), "svg": qr_svg(url.as_str())? }))
}

/// Everything the NOVA Companion plugin's page asks for. plugins.rs checked that the
/// plugin is signed by NOVA and has the companion permission.
pub async fn plugin_call<R: Runtime>(app: &AppHandle<R>, method: &str, params: &serde_json::Value) -> CommandResult<serde_json::Value> {
    fn json(value: impl Serialize) -> CommandResult<serde_json::Value> {
        serde_json::to_value(value).map_err(|e| e.to_string())
    }
    let app = app.clone();
    match method {
        "companion.status" => json(companion_status(app).await?),
        "companion.configure" => json(companion_configure(app, params["enabled"].as_bool(), params["keepScreenshots"].as_bool()).await?),
        "companion.candidates" => json(companion_allow_candidates(app).await?),
        "companion.setAllowlist" => {
            let list: Vec<AllowedApp> = serde_json::from_value(params["allowlist"].clone()).map_err(|_| "The list isn't valid".to_string())?;
            json(companion_set_allowlist(app, list).await?)
        }
        "companion.pairStart" => json(companion_pair_start(app).await?),
        "companion.pairCancel" => json(companion_pair_cancel(app).await?),
        "companion.revoke" => {
            let device = params["deviceId"].as_str().filter(|id| protocol::is_key32(id) || (1..=64).contains(&id.len())).ok_or("Unknown phone")?;
            json(companion_revoke(app, device.to_string()).await?)
        }
        "companion.log" => json(companion_log(app).await?),
        "companion.clearLog" => json(companion_clear_log(app).await?),
        "companion.app" => app_download(&app),
        _ => Err("Unknown method".into()),
    }
}

pub(crate) fn device_for_session<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> Option<([u8; 32], String)> {
    device(app, device_id)
}

pub(crate) fn device_approval_key(device_id: &str) -> Option<[u8; 32]> {
    approval_key(device_id)
}

pub(crate) fn conn_handles<R: Runtime>(app: &AppHandle<R>, device_id: &str) -> (u64, mpsc::Receiver<PcMessage>, Arc<AtomicBool>) {
    add_conn(app, device_id)
}

pub(crate) fn drop_conn<R: Runtime>(app: &AppHandle<R>, id: u64) {
    remove_conn(app, id)
}

pub(crate) fn mdns_address() -> Option<std::net::Ipv4Addr> {
    lan_addresses().into_iter().next()
}

#[cfg(test)]
mod adapter_tests {
    #[test]
    fn virtual_adapters_stay_out_of_the_pairing_code() {
        for name in ["VMware Network Adapter VMnet8", "vEthernet (Default Switch)", "vEthernet (WSL)", "Tailscale", "Loopback Pseudo-Interface 1"] {
            assert!(super::virtual_adapter(name), "{name}");
        }
        for name in ["Ethernet 2", "WLAN", "Wi-Fi", "Ethernet"] {
            assert!(!super::virtual_adapter(name), "{name}");
        }
    }
}
