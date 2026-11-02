//! Self-updates. Releases are signed NSIS installers published next to a
//! `latest.json` manifest. The update source is configurable — a GitHub
//! "owner/repo" (raw files on the main branch) or a full HTTPS URL — and every
//! download is verified against the public key built into the app before it is
//! installed. On Windows the installer closes NOVA, updates it in place and
//! starts it again.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

type CommandResult<T> = Result<T, String>;

/// The update found by the last check, waiting for the user (or the countdown) to install it.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum InstallEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Installing,
}

fn is_github_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && !value.starts_with('.')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Resolves the configured source to the manifest URL.
///
/// - `owner/repo` → `https://raw.githubusercontent.com/owner/repo/main/releases/latest.json`
/// - `https://…` → used as is
/// - `http://localhost…` / `http://127.0.0.1…` → allowed for local testing only
pub fn manifest_url(source: &str) -> CommandResult<Url> {
    let source = source.trim().trim_end_matches('/');
    if source.contains("://") {
        let url = Url::parse(source).map_err(|_| "That isn't a valid update address".to_string())?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
        return match url.scheme() {
            "https" => Ok(url),
            "http" if local => Ok(url),
            _ => Err("Update addresses must use https".into()),
        };
    }
    let source = source.strip_prefix("github.com/").unwrap_or(source);
    let mut parts = source.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(repo), None) if is_github_name(owner) && is_github_name(repo) => {
            Url::parse(&format!("https://raw.githubusercontent.com/{owner}/{repo}/main/releases/latest.json")).map_err(|e| e.to_string())
        }
        _ => Err("Enter your GitHub repository as owner/name, for example lucawarmers/nova".into()),
    }
}

fn describe(error: tauri_plugin_updater::Error) -> String {
    let message = error.to_string();
    if message.contains("404") || message.contains("Not Found") {
        "No release was found at the update source yet".into()
    } else if message.to_lowercase().contains("signature") {
        "The update's signature is invalid, so it was not installed".into()
    } else {
        message
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: tauri::State<'_, PendingUpdate>, source: String) -> CommandResult<Option<UpdateInfo>> {
    let endpoint = manifest_url(&source)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(describe)?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(describe)?;
    let update = updater.check().await.map_err(describe)?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    });
    *pending.0.lock().map_err(|_| "update state lock poisoned")? = update;
    Ok(info)
}

/// Downloads, verifies and installs the pending update. On Windows the process
/// exits while the installer runs, and the installer starts NOVA again.
#[tauri::command]
pub async fn update_install(pending: tauri::State<'_, PendingUpdate>, on_event: Channel<InstallEvent>) -> CommandResult<()> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "update state lock poisoned")?
        .take()
        .ok_or("Check for updates first")?;
    let progress = on_event.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.send(InstallEvent::Progress { downloaded, total });
            },
            || {
                let _ = on_event.send(InstallEvent::Installing);
            },
        )
        .await
        .map_err(describe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_github_sources() {
        assert_eq!(
            manifest_url("lucawarmers/nova").unwrap().as_str(),
            "https://raw.githubusercontent.com/lucawarmers/nova/main/releases/latest.json"
        );
        assert_eq!(
            manifest_url(" github.com/luca-w/NOVA.app/ ").unwrap().as_str(),
            "https://raw.githubusercontent.com/luca-w/NOVA.app/main/releases/latest.json"
        );
    }

    #[test]
    fn accepts_https_and_local_http_only() {
        assert!(manifest_url("https://updates.example.com/latest.json").is_ok());
        assert!(manifest_url("http://127.0.0.1:8765/latest.json").is_ok());
        assert!(manifest_url("http://localhost:8765/latest.json").is_ok());
        assert!(manifest_url("http://evil.example/latest.json").is_err());
        assert!(manifest_url("file:///C:/latest.json").is_err());
    }

    #[test]
    fn rejects_malformed_repositories() {
        for bad in ["", "nova", "a/b/c", "../x/y", "owner/re po", "owner/.hidden"] {
            assert!(manifest_url(bad).is_err(), "accepted {bad:?}");
        }
    }
}
