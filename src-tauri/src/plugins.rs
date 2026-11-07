//! Plugins: signed `.novaplugin` packages of web files that run in sandboxed
//! iframes. They can't reach NOVA's commands, the file system or the network;
//! everything goes through `plugin_call`, which checks the granted permissions
//! here in Rust. There is no native plugin code. See docs/PLUGIN_API.md.

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::storage::{now_millis, Database};
use crate::telemetry::{self, Event};

type CommandResult<T> = Result<T, String>;

pub const SCHEME: &str = "novaplugin";
const ORIGIN: &str = "http://novaplugin.localhost";
const API_VERSION: u32 = 1;
/// Keys whose packages NOVA accepts. Room for a second one when the key has to change.
const TRUSTED_KEYS: &[&str] = &["dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDZGRTA3N0RFNTNBREQxMkUKUldRdTBhMVQzbmZnYjFLU3QybFZBMCtMd1FqVnNyNFRhMjg4YXFDMjZTNnM5cTBQYkRrcklIQW8K"];

const MAX_PACKAGE: u64 = 30 * 1024 * 1024;
const MAX_FILES: usize = 2_000;
const MAX_FILE: u64 = 20 * 1024 * 1024;
const MAX_TOTAL: u64 = 60 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_PARAMS: usize = 512 * 1024;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_REQUEST_BODY: usize = 256 * 1024;
const CRASHES_UNTIL_OFF: i64 = 3;
const EXTENSIONS: &[&str] = &["html", "js", "mjs", "css", "json", "map", "txt", "svg", "png", "jpg", "jpeg", "webp", "gif", "ico", "woff", "woff2"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Public,
    Private,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Permission {
    #[serde(rename = "storage", rename_all = "camelCase")]
    Storage { quota_kb: u32 },
    #[serde(rename = "network")]
    Network { hosts: Vec<String> },
    #[serde(rename = "system.metrics")]
    SystemMetrics,
    #[serde(rename = "developer.analytics")]
    DeveloperAnalytics,
}

impl Permission {
    fn key(&self) -> &'static str {
        match self {
            Self::Storage { .. } => "storage",
            Self::Network { .. } => "network",
            Self::SystemMetrics => "system.metrics",
            Self::DeveloperAnalytics => "developer.analytics",
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Storage { quota_kb } => format!("Keep its own data on this PC (up to {quota_kb} KB)"),
            Self::Network { hosts } => format!("Connect to {}", hosts.join(", ")),
            Self::SystemMetrics => "Read CPU, memory and graphics card usage".into(),
            Self::DeveloperAnalytics => "Read NOVA's usage statistics (developer sign-in required)".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageContribution {
    id: String,
    title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetContribution {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    w: u8,
    h: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContribution {
    id: String,
    name: String,
    accent: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Contributes {
    pages: Vec<PageContribution>,
    widgets: Vec<WidgetContribution>,
    themes: Vec<ThemeContribution>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    id: String,
    name: String,
    version: String,
    description: String,
    #[serde(default)]
    author: String,
    api_version: u32,
    min_nova_version: String,
    #[serde(default)]
    max_nova_version: Option<String>,
    #[serde(default)]
    channel: Channel,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    permissions: Vec<Permission>,
    #[serde(default)]
    contributes: Contributes,
}

fn parse_version(value: &str) -> Option<[u64; 3]> {
    let core = value.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let version = [parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?];
    parts.next().is_none().then_some(version)
}

fn is_plugin_id(id: &str) -> bool {
    let mut parts = id.split('.');
    id.len() <= 60 && id.contains('.') && parts.all(|part| !part.is_empty() && !part.starts_with('-') && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
}

fn is_part_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn short_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_manifest(manifest: &Manifest) -> Result<(), String> {
    if !is_plugin_id(&manifest.id) {
        return Err("The plugin's id isn't valid".into());
    }
    if !short_text(&manifest.name, 40) || !short_text(&manifest.description, 200) || manifest.author.chars().count() > 60 || manifest.author.chars().any(char::is_control) {
        return Err("The plugin's name, description or author isn't valid".into());
    }
    if parse_version(&manifest.version).is_none() || parse_version(&manifest.min_nova_version).is_none() || manifest.max_nova_version.as_deref().is_some_and(|v| parse_version(v).is_none()) {
        return Err("The plugin has an invalid version".into());
    }
    if manifest.api_version != API_VERSION {
        return Err(format!("This plugin needs plugin API {}, NOVA has {API_VERSION}", manifest.api_version));
    }
    let mut seen = HashSet::new();
    for permission in &manifest.permissions {
        if !seen.insert(permission.key()) {
            return Err(format!("The plugin lists the permission {} twice", permission.key()));
        }
        match permission {
            Permission::Storage { quota_kb } if *quota_kb == 0 || *quota_kb > 10_240 => return Err("The plugin asks for an invalid amount of storage".into()),
            Permission::Network { hosts } => {
                if hosts.is_empty() || hosts.len() > 16 {
                    return Err("The plugin must list between 1 and 16 network hosts".into());
                }
                for host in hosts {
                    let plain = host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'));
                    if !plain || crate::agent::web::check_url(&format!("https://{host}/")).is_err() {
                        return Err(format!("The plugin can't connect to “{host}”"));
                    }
                }
            }
            Permission::DeveloperAnalytics if manifest.channel != Channel::Private => return Err("Only private plugins can read usage statistics".into()),
            _ => {}
        }
    }
    let c = &manifest.contributes;
    let needs_entry = !c.pages.is_empty() || !c.widgets.is_empty();
    match &manifest.entry {
        Some(entry) if !entry.ends_with(".html") => return Err("The plugin's entry must be an HTML file".into()),
        None if needs_entry => return Err("A plugin with pages or widgets needs an entry file".into()),
        _ => {}
    }
    if c.pages.len() > 8 || c.widgets.len() > 16 || c.themes.len() > 32 {
        return Err("The plugin adds too many pages, widgets or themes".into());
    }
    let ids_ok = c.pages.iter().all(|p| is_part_id(&p.id) && short_text(&p.title, 32))
        && c.widgets.iter().all(|w| is_part_id(&w.id) && short_text(&w.name, 40) && w.description.chars().count() <= 200 && (1..=12).contains(&w.w) && (1..=8).contains(&w.h))
        && c.themes.iter().all(|t| is_part_id(&t.id) && short_text(&t.name, 32) && is_hex_color(&t.accent));
    if !ids_ok {
        return Err("The plugin's pages, widgets or themes aren't valid".into());
    }
    Ok(())
}

/// Why this NOVA can't run the plugin, if so.
fn incompatibility(manifest: &Manifest, nova: &str) -> Option<String> {
    let current = parse_version(nova)?;
    if parse_version(&manifest.min_nova_version).is_some_and(|min| current < min) {
        return Some(format!("Needs NOVA {} or newer", manifest.min_nova_version));
    }
    if manifest.max_nova_version.as_deref().and_then(parse_version).is_some_and(|max| current > max) {
        return Some(format!("Works up to NOVA {}", manifest.max_nova_version.as_deref().unwrap_or_default()));
    }
    None
}

/// Rejects anything but plain relative paths of expected file types.
fn check_name(name: &str) -> Result<(), String> {
    let refuse = || Err(format!("The package holds a file it shouldn't: {name}"));
    if name == "manifest.json" || name == "signature" {
        return Ok(());
    }
    let Some(rest) = name.strip_prefix("payload/") else { return refuse() };
    if rest.is_empty() || !safe_path(rest) {
        return refuse();
    }
    let extension = rest.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return refuse();
    }
    Ok(())
}

fn safe_path(path: &str) -> bool {
    path.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@' | b'~')))
}

fn verify_signature(data: &[u8], signature: &str, key: &str) -> bool {
    let decode = |text: &str| base64::engine::general_purpose::STANDARD.decode(text.trim()).ok().and_then(|bytes| String::from_utf8(bytes).ok());
    let (Some(key), Some(signature)) = (decode(key), decode(signature)) else { return false };
    let (Ok(key), Ok(signature)) = (PublicKey::decode(&key), Signature::decode(&signature)) else { return false };
    key.verify(data, &signature, true).is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Signer {
    Nova,
    Unsigned,
}

#[derive(Debug)]
pub struct Package {
    manifest: Manifest,
    signer: Signer,
    files: Vec<(String, Vec<u8>)>,
}

/// Opens and checks a package without unpacking anything to disk. A package that
/// fails here leaves no trace.
fn read_package(bytes: &[u8], trusted: &[&str], allow_unsigned: bool) -> Result<Package, String> {
    let corrupt = |e: zip::result::ZipError| format!("The file isn't a valid plugin package: {e}");
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(corrupt)?;
    if archive.len() > MAX_FILES {
        return Err("The package holds too many files".into());
    }
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut lowercase = HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(corrupt)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(corrupt)?.to_string();
        if entry.is_symlink() {
            return Err(format!("The package holds a link it shouldn't: {name}"));
        }
        check_name(&name)?;
        if !lowercase.insert(name.to_lowercase()) {
            return Err(format!("The package holds {name} twice"));
        }
        // The sizes in a ZIP's header can lie, so what counts is what actually comes out.
        let limit = if name == "manifest.json" || name == "signature" { MAX_MANIFEST } else { MAX_FILE };
        let mut data = Vec::new();
        let mut reader = (&mut entry).take(limit + 1);
        reader.read_to_end(&mut data).map_err(|e| format!("The package is damaged: {e}"))?;
        total += data.len() as u64;
        if data.len() as u64 > limit || total > MAX_TOTAL {
            return Err("The package is too large when unpacked".into());
        }
        files.insert(name, data);
    }

    let signature = files.remove("signature");
    let listing: String = files.iter().map(|(name, data)| format!("{:x}  {name}\n", Sha256::digest(data))).collect();
    let signed = signature.as_deref().and_then(|s| std::str::from_utf8(s).ok()).is_some_and(|s| trusted.iter().any(|key| verify_signature(listing.as_bytes(), s, key)));
    let signer = match (signed, signature.is_some(), allow_unsigned) {
        (true, _, _) => Signer::Nova,
        (false, false, true) => Signer::Unsigned,
        (false, false, false) => return Err("This plugin isn't signed, so NOVA won't install it".into()),
        (false, true, _) => return Err("This plugin's signature is invalid or from an unknown publisher, so NOVA won't install it".into()),
    };

    let manifest_bytes = files.remove("manifest.json").ok_or("The package has no manifest")?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|e| format!("The plugin's manifest isn't valid: {e}"))?;
    check_manifest(&manifest)?;
    if manifest.channel == Channel::Private && signer != Signer::Nova {
        return Err("A private plugin has to be signed".into());
    }
    if let Some(entry) = &manifest.entry {
        if !safe_path(entry) || !files.contains_key(&format!("payload/{entry}")) {
            return Err("The plugin's entry file is missing".into());
        }
    }
    let files = files.into_iter().filter_map(|(name, data)| name.strip_prefix("payload/").map(|rest| (rest.to_string(), data))).collect();
    Ok(Package { manifest, signer, files })
}

/// A dashboard widget's id. Layouts only store short plain identifiers.
fn widget_key(plugin_id: &str, widget_id: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(plugin_id.as_bytes()));
    format!("p_{}_{widget_id}", &hash[..8])
}

#[derive(Default)]
pub struct PluginState {
    pending: Mutex<Option<Package>>,
}

#[derive(Debug, Clone)]
struct Row {
    manifest: Manifest,
    signer: Signer,
    enabled: bool,
    granted: Vec<String>,
    last_error: Option<String>,
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let manifest: String = row.get(0)?;
    let signer: String = row.get(1)?;
    let granted: String = row.get(3)?;
    let manifest = serde_json::from_str(&manifest).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))?;
    Ok(Row {
        manifest,
        signer: if signer == "nova" { Signer::Nova } else { Signer::Unsigned },
        enabled: row.get::<_, i64>(2)? != 0,
        granted: serde_json::from_str(&granted).unwrap_or_default(),
        last_error: row.get(4)?,
    })
}

const ROW_COLUMNS: &str = "manifest, signer, enabled, granted, last_error";

fn load_row(db: &Database, id: &str) -> CommandResult<Option<Row>> {
    db.with(|c| Ok(c.query_row(&format!("SELECT {ROW_COLUMNS} FROM plugins WHERE id = ?1"), [id], read_row).optional()?))
}

fn load_rows(db: &Database) -> CommandResult<Vec<Row>> {
    db.with(|c| {
        let mut statement = c.prepare(&format!("SELECT {ROW_COLUMNS} FROM plugins ORDER BY id"))?;
        let rows = statement.query_map([], read_row)?.filter_map(Result::ok).collect();
        Ok(rows)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    key: String,
    label: String,
    granted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetInfo {
    key: String,
    id: String,
    name: String,
    description: String,
    w: u8,
    h: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    channel: Channel,
    signed: bool,
    enabled: bool,
    problem: Option<String>,
    last_error: Option<String>,
    entry_url: Option<String>,
    permissions: Vec<PermissionInfo>,
    pages: Vec<PageContribution>,
    widgets: Vec<WidgetInfo>,
    themes: Vec<ThemeContribution>,
}

fn plugin_info(row: &Row) -> PluginInfo {
    let m = &row.manifest;
    PluginInfo {
        id: m.id.clone(),
        name: m.name.clone(),
        version: m.version.clone(),
        description: m.description.clone(),
        author: m.author.clone(),
        channel: m.channel,
        signed: row.signer == Signer::Nova,
        enabled: row.enabled,
        problem: incompatibility(m, env!("CARGO_PKG_VERSION")),
        last_error: row.last_error.clone(),
        entry_url: m.entry.as_ref().map(|entry| format!("{ORIGIN}/{}/{}/{entry}", m.id, m.version)),
        permissions: m.permissions.iter().map(|p| PermissionInfo { key: p.key().into(), label: p.label(), granted: row.granted.iter().any(|g| g == p.key()) }).collect(),
        pages: m.contributes.pages.clone(),
        widgets: m.contributes.widgets.iter().map(|w| WidgetInfo { key: widget_key(&m.id, &w.id), id: w.id.clone(), name: w.name.clone(), description: w.description.clone(), w: w.w, h: w.h }).collect(),
        themes: m.contributes.themes.clone(),
    }
}

fn plugins_dir<R: Runtime>(app: &AppHandle<R>) -> CommandResult<PathBuf> {
    app.path().app_data_dir().map(|dir| dir.join("plugins")).map_err(|e| format!("No data folder: {e}"))
}

#[tauri::command]
pub async fn plugins_list<R: Runtime>(app: AppHandle<R>) -> CommandResult<Vec<PluginInfo>> {
    Ok(load_rows(&app.state::<Database>())?.iter().map(plugin_info).collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstall {
    name: String,
    version: String,
    description: String,
    author: String,
    channel: Channel,
    signed: bool,
    replaces: Option<String>,
    permissions: Vec<String>,
    added_permissions: Vec<String>,
}

fn added_permissions(new: &Manifest, old: Option<&Manifest>) -> Vec<String> {
    new.permissions.iter().filter(|p| old.is_none_or(|old| !old.permissions.iter().any(|q| q == *p))).map(Permission::label).collect()
}

/// Lets the user pick a package and checks it. Nothing is installed until they confirm
/// what it asks for.
#[tauri::command]
pub async fn plugins_pick<R: Runtime>(app: AppHandle<R>, pending: tauri::State<'_, PluginState>) -> CommandResult<Option<PendingInstall>> {
    let picked = app.dialog().file().set_title("Choose a NOVA plugin").add_filter("NOVA plugin", &["novaplugin"]).blocking_pick_file();
    let Some(path) = picked.map(|p| p.into_path()).transpose().map_err(|e| e.to_string())? else { return Ok(None) };
    let package = tauri::async_runtime::spawn_blocking(move || {
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_PACKAGE {
            return Err("The package is too large".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read the file: {e}"))?;
        read_package(&bytes, TRUSTED_KEYS, cfg!(debug_assertions))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(problem) = incompatibility(&package.manifest, env!("CARGO_PKG_VERSION")) {
        return Err(problem);
    }
    let existing = load_row(&app.state::<Database>(), &package.manifest.id)?;
    let m = &package.manifest;
    let summary = PendingInstall {
        name: m.name.clone(),
        version: m.version.clone(),
        description: m.description.clone(),
        author: m.author.clone(),
        channel: m.channel,
        signed: package.signer == Signer::Nova,
        replaces: existing.as_ref().map(|row| row.manifest.version.clone()),
        permissions: m.permissions.iter().map(Permission::label).collect(),
        added_permissions: added_permissions(m, existing.as_ref().map(|row| &row.manifest)),
    };
    *pending.pending.lock().map_err(|_| "plugin state lock poisoned")? = Some(package);
    Ok(Some(summary))
}

#[tauri::command]
pub async fn plugins_install_cancel(pending: tauri::State<'_, PluginState>) -> CommandResult<()> {
    *pending.pending.lock().map_err(|_| "plugin state lock poisoned")? = None;
    Ok(())
}

/// Unpacks next to the live version and swaps it in, so a failure changes nothing.
fn unpack(base: &Path, package: &Package) -> CommandResult<()> {
    let plugin_dir = base.join(&package.manifest.id);
    let temp = plugin_dir.join(".installing");
    let _ = std::fs::remove_dir_all(&temp);
    let write = || -> std::io::Result<()> {
        for (name, data) in &package.files {
            let target = temp.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(target, data)?;
        }
        std::fs::create_dir_all(&temp)?;
        let target = plugin_dir.join(&package.manifest.version);
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&temp, target)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_dir_all(&temp);
        format!("Couldn't install the plugin: {e}")
    })
}

/// What stays granted after an update: a permission the user turned off stays off,
/// and one they just saw in the dialog is on.
fn granted_after(new: &Manifest, old: Option<&Row>) -> Vec<String> {
    new.permissions
        .iter()
        .filter(|p| {
            let Some(old) = old else { return true };
            let was_same = old.manifest.permissions.iter().any(|q| q == *p);
            !was_same || old.granted.iter().any(|g| g == p.key())
        })
        .map(|p| p.key().to_string())
        .collect()
}

#[tauri::command]
pub async fn plugins_install_confirm<R: Runtime>(app: AppHandle<R>, pending: tauri::State<'_, PluginState>) -> CommandResult<PluginInfo> {
    let package = pending.pending.lock().map_err(|_| "plugin state lock poisoned")?.take().ok_or("Choose a plugin first")?;
    install(&app, package).await
}

/// Debug builds only: installs the packages named in NOVA_DEV_PLUGINS without the file
/// dialog, for the end-to-end checks in scripts/e2e. Release builds have no such path.
#[cfg(debug_assertions)]
pub fn install_dev_plugins<R: Runtime>(app: &AppHandle<R>) {
    let Ok(paths) = std::env::var("NOVA_DEV_PLUGINS") else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for path in paths.split(';').filter(|p| !p.is_empty()) {
            let result = match std::fs::read(path).map_err(|e| e.to_string()).and_then(|bytes| read_package(&bytes, TRUSTED_KEYS, true)) {
                Ok(package) => install(&app, package).await.map(|_| ()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                eprintln!("[NOVA] dev plugin {path}: {error}");
            }
        }
    });
}

async fn install<R: Runtime>(app: &AppHandle<R>, package: Package) -> CommandResult<PluginInfo> {
    let base = plugins_dir(app)?;
    let package = {
        let base = base.clone();
        tauri::async_runtime::spawn_blocking(move || unpack(&base, &package).map(|()| package)).await.map_err(|e| e.to_string())??
    };
    let db = app.state::<Database>();
    let previous = load_row(&db, &package.manifest.id)?;
    let granted = serde_json::to_string(&granted_after(&package.manifest, previous.as_ref())).map_err(|e| e.to_string())?;
    let manifest = serde_json::to_string(&package.manifest).map_err(|e| e.to_string())?;
    let signer = if package.signer == Signer::Nova { "nova" } else { "unsigned" };
    db.with(|c| {
        c.execute(
            "INSERT INTO plugins (id, version, manifest, signer, enabled, granted, crashes, last_error, installed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, 0, NULL, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, manifest = excluded.manifest, signer = excluded.signer, enabled = 1, granted = excluded.granted, crashes = 0, last_error = NULL, updated_at = excluded.updated_at",
            params![package.manifest.id, package.manifest.version, manifest, signer, granted, now_millis()],
        )?;
        Ok(())
    })?;
    if let Ok(entries) = std::fs::read_dir(base.join(&package.manifest.id)) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy() != package.manifest.version {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    telemetry::track(app, Event::Plugin("installed"));
    let row = load_row(&db, &package.manifest.id)?.ok_or("The plugin vanished")?;
    Ok(plugin_info(&row))
}

#[tauri::command]
pub async fn plugins_uninstall<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<()> {
    if !is_plugin_id(&id) {
        return Err("Unknown plugin".into());
    }
    app.state::<Database>().with(|c| {
        c.execute("DELETE FROM plugins WHERE id = ?1", [&id])?;
        Ok(())
    })?;
    let dir = plugins_dir(&app)?.join(&id);
    let _ = tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
    telemetry::track(&app, Event::Plugin("uninstalled"));
    Ok(())
}

#[tauri::command]
pub async fn plugins_set_enabled<R: Runtime>(app: AppHandle<R>, id: String, enabled: bool) -> CommandResult<()> {
    app.state::<Database>().with(|c| {
        c.execute("UPDATE plugins SET enabled = ?1, crashes = CASE WHEN ?1 = 1 THEN 0 ELSE crashes END, last_error = CASE WHEN ?1 = 1 THEN NULL ELSE last_error END WHERE id = ?2", params![i64::from(enabled), id])?;
        Ok(())
    })?;
    telemetry::track(&app, Event::Plugin(if enabled { "enabled" } else { "disabled" }));
    Ok(())
}

#[tauri::command]
pub async fn plugins_set_permission<R: Runtime>(app: AppHandle<R>, id: String, permission: String, granted: bool) -> CommandResult<()> {
    let db = app.state::<Database>();
    let row = load_row(&db, &id)?.ok_or("Unknown plugin")?;
    if !row.manifest.permissions.iter().any(|p| p.key() == permission) {
        return Err("The plugin doesn't ask for that".into());
    }
    let mut list = row.granted;
    list.retain(|g| *g != permission);
    if granted {
        list.push(permission);
    }
    let value = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    db.with(|c| {
        c.execute("UPDATE plugins SET granted = ?1 WHERE id = ?2", params![value, id])?;
        Ok(())
    })
}

/// A frame stopped answering. After a few times the plugin is turned off. True if it is now off.
#[tauri::command]
pub async fn plugin_report_crash<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<bool> {
    telemetry::track(&app, Event::Plugin("crashed"));
    app.state::<Database>().with(|c| {
        let crashes: i64 = c.query_row("UPDATE plugins SET crashes = crashes + 1 WHERE id = ?1 RETURNING crashes", [&id], |r| r.get(0))?;
        let off = crashes >= CRASHES_UNTIL_OFF;
        if off {
            c.execute("UPDATE plugins SET enabled = 0, last_error = 'Turned off because it stopped responding several times' WHERE id = ?1", [&id])?;
        }
        Ok(off)
    })
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "text/plain; charset=utf-8",
    }
}

/// No connections, no frames, no forms; the sandbox holds even if a page is opened directly.
fn plugin_csp() -> String {
    format!("default-src 'none'; script-src {ORIGIN}; style-src {ORIGIN} 'unsafe-inline'; img-src {ORIGIN} data: blob:; font-src {ORIGIN} data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
}

fn answer(status: StatusCode, kind: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CONTENT_SECURITY_POLICY, plugin_csp())
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::CACHE_CONTROL, "no-store")
        // A sandboxed page has no origin; its own scripts still have to load.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body);
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}

fn split_request_path(path: &str) -> Option<(&str, &str, &str)> {
    let mut parts = path.trim_start_matches('/').splitn(3, '/');
    let (id, version, file) = (parts.next()?, parts.next()?, parts.next()?);
    (is_plugin_id(id) && parse_version(version).is_some() && safe_path(file) && !path.contains('%')).then_some((id, version, file))
}

/// Serves an enabled plugin's own files; nothing outside its folder can be named.
pub fn serve<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let missing = || answer(StatusCode::NOT_FOUND, "text/plain", b"not found".to_vec());
    let Some((id, version, file)) = split_request_path(request.uri().path()) else { return missing() };
    let Ok(Some(row)) = load_row(&app.state::<Database>(), id) else { return missing() };
    if !row.enabled || row.manifest.version != version || incompatibility(&row.manifest, env!("CARGO_PKG_VERSION")).is_some() {
        return missing();
    }
    let Ok(base) = plugins_dir(app) else { return missing() };
    let path = base.join(id).join(version).join(file.replace('/', std::path::MAIN_SEPARATOR_STR));
    match std::fs::read(path) {
        Ok(bytes) => answer(StatusCode::OK, content_type(file), bytes),
        Err(_) => missing(),
    }
}

/// The one permission a broker method needs.
fn permission_of(method: &str) -> Option<&'static str> {
    match method.split_once('.')?.0 {
        "storage" => Some("storage"),
        "network" => Some("network"),
        "system" => Some("system.metrics"),
        "analytics" => Some("developer.analytics"),
        _ => None,
    }
}

fn text_param<'a>(params: &'a Value, name: &str) -> CommandResult<&'a str> {
    params[name].as_str().ok_or_else(|| format!("{name} is missing"))
}

fn storage_call(db: &Database, id: &str, quota_kb: u32, method: &str, params: &Value) -> CommandResult<Value> {
    let key = || -> CommandResult<&str> {
        let key = text_param(params, "key")?;
        if key.is_empty() || key.len() > 128 {
            return Err("Storage keys are 1 to 128 characters".into());
        }
        Ok(key)
    };
    match method {
        "storage.get" => db.with(|c| Ok(c.query_row("SELECT value FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2", params![id, key().map_err(crate::storage::StorageError::Invalid)?], |r| r.get::<_, String>(0)).optional()?)).map(|value| json!(value)),
        "storage.set" => {
            let key = key()?;
            let value = text_param(params, "value")?;
            db.with(|c| {
                let used: i64 = c.query_row("SELECT coalesce(sum(length(key) + length(value)), 0) FROM plugin_storage WHERE plugin_id = ?1 AND key != ?2", params![id, key], |r| r.get(0))?;
                if used + (key.len() + value.len()) as i64 > i64::from(quota_kb) * 1024 {
                    return Err(crate::storage::StorageError::Invalid("The plugin's storage is full".into()));
                }
                c.execute("INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value", params![id, key, value])?;
                Ok(Value::Null)
            })
        }
        "storage.delete" => {
            let key = key()?;
            db.with(|c| {
                c.execute("DELETE FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2", params![id, key])?;
                Ok(Value::Null)
            })
        }
        _ => Err("Unknown storage method".into()),
    }
}

async fn network_fetch(hosts: &[String], params: &Value) -> CommandResult<Value> {
    let url = crate::agent::web::check_url(text_param(params, "url")?)?;
    let host = url.host_str().unwrap_or_default().to_string();
    if url.scheme() != "https" || !hosts.contains(&host) {
        return Err(format!("This plugin isn't allowed to connect to {host}"));
    }
    let method = match params["method"].as_str().unwrap_or("GET") {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported request method".into()),
    };
    let checked = url.clone();
    let addresses = tauri::async_runtime::spawn_blocking(move || crate::agent::web::public_addresses(&checked)).await.map_err(|e| e.to_string())?.ok_or("Plugins can only reach public addresses")?;
    // No redirects: each hop would have to be on the plugin's list again.
    let mut request = crate::http::checked_client(&host, &addresses)?.request(method, url).timeout(Duration::from_secs(20));
    if let Some(headers) = params["headers"].as_object() {
        for (name, value) in headers {
            let name = name.to_ascii_lowercase();
            if matches!(name.as_str(), "accept" | "content-type" | "authorization") {
                if let Some(value) = value.as_str() {
                    request = request.header(name, value);
                }
            }
        }
    }
    if let Some(body) = params["body"].as_str() {
        if body.len() > MAX_REQUEST_BODY {
            return Err("The request is too large".into());
        }
        request = request.body(body.to_string());
    }
    let response = request.send().await.map_err(crate::http::describe)?;
    let status = response.status().as_u16();
    let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|c| c.to_str().ok()).unwrap_or("").to_string();
    let bytes = crate::http::read_limited(response, MAX_RESPONSE).await?;
    Ok(json!({ "status": status, "contentType": kind, "body": crate::http::decode_text(&bytes) }))
}

/// Everything a plugin can do goes through here, and everything here is checked here:
/// the page in front of it only forwards.
#[tauri::command]
pub async fn plugin_call<R: Runtime>(app: AppHandle<R>, plugin_id: String, method: String, params: Value) -> CommandResult<Value> {
    if params.to_string().len() > MAX_PARAMS {
        return Err("The request is too large".into());
    }
    let db = app.state::<Database>();
    let row = load_row(&db, &plugin_id)?.ok_or("Unknown plugin")?;
    if !row.enabled {
        return Err("This plugin is turned off".into());
    }
    let needed = permission_of(&method).ok_or("Unknown method")?;
    if !row.granted.iter().any(|g| g == needed) {
        return Err(format!("This plugin doesn't have the {needed} permission"));
    }
    let Some(permission) = row.manifest.permissions.iter().find(|p| p.key() == needed) else { return Err("Unknown method".into()) };
    match permission {
        Permission::Storage { quota_kb } => storage_call(&db, &plugin_id, *quota_kb, &method, &params),
        Permission::Network { hosts } if method == "network.fetch" => network_fetch(hosts, &params).await,
        Permission::SystemMetrics if method == "system.snapshot" => {
            let snapshot = app.state::<crate::system::SystemMonitor>().snapshot()?;
            serde_json::to_value(snapshot).map_err(|e| e.to_string())
        }
        Permission::DeveloperAnalytics if row.signer == Signer::Nova && row.manifest.channel == Channel::Private => crate::developer::call(&app, &method, &params).await,
        _ => Err("Unknown method".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI5Nzg4NEQ3MzI4QzNEODUKUldTRlBZd3kxNFI0S1Q5MFl2aFNHakVNaXdPajlPemhxNFNCZlJtS1o3dTNtOW9GUFZGb2lHSFUK";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTRlBZd3kxNFI0S2N0aG0vTUE2T200QS9PbDRBdU80RzhuYmx2Q1ErTkI1bGZ0TFBkSEpFcExzYTV0bXAxL0FPSTVaYm13SjdGcHJYbkRzcU5nS2dJRVBTZkJLa253bFE0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0MDUzNjY3CWZpbGU6Zml4dHVyZS50eHQKa3R4NTZvMEZ6YXVIUXJSQ0VHS1l0Y3hwNmZoTUNvYklvMUU3bHFGc0MxMVkzdUQ1T1dpM1UyZ3ZMSU5qZHNqRTcwVy9MQ1pSZUU1anowOGZNbUFIQVE9PQo=";

    fn manifest() -> Value {
        json!({
            "id": "dev.example.hello", "name": "Hello", "version": "1.0.0", "description": "A test", "apiVersion": 1, "minNovaVersion": "1.0.0", "entry": "index.html",
            "permissions": [{ "type": "storage", "quotaKb": 16 }],
            "contributes": { "pages": [{ "id": "main", "title": "Hello" }], "widgets": [{ "id": "w", "name": "W", "w": 4, "h": 2 }] }
        })
    }

    fn package(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn unsigned(manifest: &Value, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let text = manifest.to_string();
        let mut files: Vec<(&str, &[u8])> = vec![("manifest.json", text.as_bytes()), ("payload/index.html", b"<!doctype html>")];
        files.extend_from_slice(extra);
        package(&files)
    }

    #[test]
    fn verifies_real_signatures_and_refuses_changes() {
        assert!(verify_signature(b"nova plugin test", TEST_SIGNATURE, TEST_KEY));
        assert!(!verify_signature(b"nova plugin tesT", TEST_SIGNATURE, TEST_KEY));
        assert!(!verify_signature(b"nova plugin test", TEST_SIGNATURE, TRUSTED_KEYS[0]));
        assert!(!verify_signature(b"nova plugin test", "not base64 !!", TEST_KEY));
    }

    #[test]
    fn opens_a_good_package() {
        let package = read_package(&unsigned(&manifest(), &[("payload/assets/app.js", b"1")]), TRUSTED_KEYS, true).unwrap();
        assert_eq!(package.manifest.id, "dev.example.hello");
        assert_eq!(package.signer, Signer::Unsigned);
        assert_eq!(package.files.len(), 2);
    }

    #[test]
    fn release_builds_refuse_unsigned_and_foreign_packages() {
        let bytes = unsigned(&manifest(), &[]);
        assert!(read_package(&bytes, TRUSTED_KEYS, false).unwrap_err().contains("isn't signed"));
        let text = manifest().to_string();
        let foreign = package(&[("manifest.json", text.as_bytes()), ("payload/index.html", b"<!doctype html>"), ("signature", TEST_SIGNATURE.as_bytes())]);
        assert!(read_package(&foreign, TRUSTED_KEYS, true).unwrap_err().contains("signature"));
    }

    #[test]
    fn refuses_paths_that_leave_the_package() {
        for bad in ["../evil.js", "payload/../../evil.js", "payload/..\\evil.js", "/payload/a.js", "C:/evil.js", "payload/a/../b.js", "evil.js", "payload/", "payload/a b.js"] {
            assert!(check_name(bad).is_err(), "accepted {bad}");
        }
        assert!(check_name("payload/assets/index-Ab1_x.js").is_ok());
    }

    #[test]
    fn refuses_executables_and_links() {
        assert!(check_name("payload/run.exe").is_err());
        assert!(check_name("payload/lib.dll").is_err());
        assert!(check_name("payload/a.wasm").is_err());
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_symlink("payload/link.js", "C:/Windows/win.ini", SimpleFileOptions::default()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(read_package(&bytes, TRUSTED_KEYS, true).unwrap_err().contains("link"));
    }

    #[test]
    fn refuses_a_zip_bomb() {
        let big = vec![0u8; (MAX_FILE + 1) as usize];
        let bytes = unsigned(&manifest(), &[("payload/big.js", &big)]);
        assert!(bytes.len() < 1024 * 1024, "the test needs a file that packs small");
        assert!(read_package(&bytes, TRUSTED_KEYS, true).unwrap_err().contains("too large"));
    }

    #[test]
    fn refuses_damaged_files_and_manifests() {
        assert!(read_package(b"not a zip", TRUSTED_KEYS, true).is_err());
        let mut m = manifest();
        m["permissions"] = json!([{ "type": "files.read" }]);
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).is_err(), "an unknown permission must not be ignored");
        let mut m = manifest();
        m["entry"] = json!("missing.html");
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).unwrap_err().contains("entry"));
        let mut m = manifest();
        m["id"] = json!("../evil");
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).is_err());
        let mut m = manifest();
        m["apiVersion"] = json!(99);
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).unwrap_err().contains("API"));
    }

    #[test]
    fn statistics_are_only_for_signed_private_plugins() {
        let mut m = manifest();
        m["permissions"] = json!([{ "type": "developer.analytics" }]);
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).unwrap_err().contains("private"));
        m["channel"] = json!("private");
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).unwrap_err().contains("signed"));
    }

    #[test]
    fn checks_network_hosts() {
        let mut m = manifest();
        for bad in ["localhost", "127.0.0.1", "192.168.1.1", "*.example.com", "intranet", "EXAMPLE.COM", "a b.com"] {
            m["permissions"] = json!([{ "type": "network", "hosts": [bad] }]);
            assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).is_err(), "accepted {bad}");
        }
        m["permissions"] = json!([{ "type": "network", "hosts": ["api.example.com"] }]);
        assert!(read_package(&unsigned(&m, &[]), TRUSTED_KEYS, true).is_ok());
    }

    #[test]
    fn checks_nova_versions() {
        let mut m: Manifest = serde_json::from_value(manifest()).unwrap();
        assert_eq!(incompatibility(&m, "1.10.1"), None);
        m.min_nova_version = "2.0.0".into();
        assert!(incompatibility(&m, "1.10.1").unwrap().contains("2.0.0"));
        m.min_nova_version = "1.0.0".into();
        m.max_nova_version = Some("1.9.9".into());
        assert!(incompatibility(&m, "1.10.1").is_some(), "1.10 is newer than 1.9");
    }

    #[test]
    fn serving_names_only_files_inside_the_plugin() {
        assert_eq!(split_request_path("/dev.example.hello/1.0.0/assets/app.js"), Some(("dev.example.hello", "1.0.0", "assets/app.js")));
        for bad in ["/dev.example.hello/1.0.0/../secret", "/dev.example.hello/1.0.0/a%2f..%2fb", "/../x/1.0.0/a.js", "/dev.example.hello/x/a.js", "/dev.example.hello/1.0.0/", "/dev.example.hello/1.0.0/a\\b.js"] {
            assert_eq!(split_request_path(bad), None, "accepted {bad}");
        }
    }

    #[test]
    fn the_sandbox_has_no_network_and_no_top_access() {
        let csp = plugin_csp();
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("unsafe-eval"));
    }

    #[test]
    fn methods_need_their_permission() {
        assert_eq!(permission_of("storage.get"), Some("storage"));
        assert_eq!(permission_of("network.fetch"), Some("network"));
        assert_eq!(permission_of("system.snapshot"), Some("system.metrics"));
        assert_eq!(permission_of("analytics.get"), Some("developer.analytics"));
        for unknown in ["files.read", "shell.run", "settings", "ai.key"] {
            assert_eq!(permission_of(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn storage_keeps_plugins_apart_and_within_their_quota() {
        let db = Database::in_memory_for_tests();
        for id in ["a.one", "b.two"] {
            db.with(|c| {
                c.execute("INSERT INTO plugins (id, version, manifest, signer, enabled, granted, crashes, installed_at, updated_at) VALUES (?1, '1.0.0', '{}', 'nova', 1, '[]', 0, 0, 0)", [id])?;
                Ok(())
            })
            .unwrap();
        }
        storage_call(&db, "a.one", 1, "storage.set", &json!({ "key": "k", "value": "secret" })).unwrap();
        assert_eq!(storage_call(&db, "a.one", 1, "storage.get", &json!({ "key": "k" })).unwrap(), json!("secret"));
        assert_eq!(storage_call(&db, "b.two", 1, "storage.get", &json!({ "key": "k" })).unwrap(), Value::Null);
        assert!(storage_call(&db, "a.one", 1, "storage.set", &json!({ "key": "big", "value": "x".repeat(2000) })).unwrap_err().contains("full"));
    }

    #[test]
    fn updates_keep_refusals_and_show_what_is_new() {
        let old: Manifest = serde_json::from_value(manifest()).unwrap();
        let mut value = manifest();
        value["permissions"] = json!([{ "type": "storage", "quotaKb": 16 }, { "type": "system.metrics" }]);
        let new: Manifest = serde_json::from_value(value).unwrap();
        let row = Row { manifest: old.clone(), signer: Signer::Nova, enabled: true, granted: vec![], last_error: None };
        assert_eq!(granted_after(&new, Some(&row)), ["system.metrics"], "storage was turned off and stays off");
        assert_eq!(added_permissions(&new, Some(&old)).len(), 1);
        assert_eq!(granted_after(&new, None), ["storage", "system.metrics"]);
    }

    #[test]
    fn widget_keys_fit_what_layouts_store() {
        let key = widget_key("dev.example.a-very-long-plugin-name.with-parts", "a-widget-with-a-long-id-x");
        assert!(crate::storage::is_identifier(&key, 40), "{key}");
    }
}
