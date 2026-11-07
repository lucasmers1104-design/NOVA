//! The developer's sign-in for the private analytics plugin. The plugin never
//! sees a token: it asks here, and every answer still depends on the server
//! checking the session. Having the plugin file alone opens nothing.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::credentials;
use crate::storage::now_millis;
use crate::telemetry::base_url;

type CommandResult<T> = Result<T, String>;

/// Not a secret: the device flow has no client secret.
const GITHUB_CLIENT_ID: &str = "Ov23li1Lo1OsZgXZ7xNx";
const TOKEN_TARGET: &str = "NOVA:developer:github";
const MAX_REPLY: usize = 8 * 1024 * 1024;

struct Session {
    token: String,
    expires_at: i64,
    login: String,
}

struct DeviceCode {
    code: String,
    expires_at: i64,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    device: Option<DeviceCode>,
}

#[derive(Default)]
pub struct DeveloperState(Mutex<Inner>);

fn lock(state: &DeveloperState) -> std::sync::MutexGuard<'_, Inner> {
    state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The read paths a plugin may ask for. Anything else never leaves NOVA.
fn allowed_path(path: &str) -> bool {
    if matches!(path, "live" | "metrics" | "hourly" | "versions" | "settings") {
        return true;
    }
    path.strip_prefix("installations/").is_some_and(|id| crate::storage::is_identifier(id, 64))
}

fn allowed_query(key: &str) -> bool {
    matches!(key, "from" | "to" | "install" | "version" | "feature" | "hours")
}

async fn github_post(url: &str, form: String) -> CommandResult<Value> {
    let response = crate::http::client()
        .post(url)
        .timeout(Duration::from_secs(20))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(crate::http::describe)?;
    let bytes = crate::http::read_limited(response, 64 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| "GitHub sent an unexpected reply".to_string())
}

/// Trades the stored GitHub token for a short session. The server asks GitHub who it is.
async fn mint_session<R: Runtime>(app: &AppHandle<R>) -> CommandResult<bool> {
    let Some(github) = credentials::get(TOKEN_TARGET)? else { return Ok(false) };
    let response = crate::http::client()
        .post(format!("{}/v1/admin/session", base_url()))
        .timeout(Duration::from_secs(20))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({ "githubToken": github }).to_string())
        .send()
        .await
        .map_err(crate::http::describe)?;
    let status = response.status().as_u16();
    if status == 403 {
        // Expired or not the developer's account: sign in again.
        let _ = credentials::delete(TOKEN_TARGET);
        return Ok(false);
    }
    if !(200..300).contains(&status) {
        return Err(format!("The statistics service answered with HTTP {status}"));
    }
    let bytes = crate::http::read_limited(response, 4096).await?;
    let reply: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let (Some(token), Some(expires_at), Some(login)) = (reply["token"].as_str(), reply["expiresAt"].as_i64(), reply["login"].as_str()) else {
        return Err("The statistics service sent an unexpected reply".into());
    };
    lock(&app.state::<DeveloperState>()).session = Some(Session { token: token.to_string(), expires_at, login: login.to_string() });
    Ok(true)
}

async fn session_token<R: Runtime>(app: &AppHandle<R>) -> CommandResult<Option<String>> {
    let cached = {
        let state = app.state::<DeveloperState>();
        let inner = lock(&state);
        inner.session.as_ref().filter(|s| s.expires_at > now_millis() + 15_000).map(|s| s.token.clone())
    };
    if cached.is_some() {
        return Ok(cached);
    }
    if !mint_session(app).await? {
        return Ok(None);
    }
    Ok(lock(&app.state::<DeveloperState>()).session.as_ref().map(|s| s.token.clone()))
}

async fn admin_request<R: Runtime>(app: &AppHandle<R>, method: reqwest::Method, path: &str, query: &[(String, String)], body: Option<String>) -> CommandResult<Value> {
    let Some(token) = session_token(app).await? else { return Err("sign-in-required".into()) };
    let base = format!("{}/v1/admin/{path}", base_url());
    let url = Url::parse_with_params(&base, query.iter().map(|(k, v)| (k.as_str(), v.as_str()))).map_err(|e| e.to_string())?;
    let mut request = crate::http::client().request(method, url).timeout(Duration::from_secs(30)).header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    if let Some(body) = body {
        request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body);
    }
    let response = request.send().await.map_err(crate::http::describe)?;
    let status = response.status().as_u16();
    if status == 401 {
        lock(&app.state::<DeveloperState>()).session = None;
        return Err("sign-in-required".into());
    }
    let bytes = crate::http::read_limited(response, MAX_REPLY).await?;
    if !(200..300).contains(&status) {
        return Err(format!("The statistics service answered with HTTP {status}"));
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

pub async fn call<R: Runtime>(app: &AppHandle<R>, method: &str, params: &Value) -> CommandResult<Value> {
    match method {
        "analytics.status" => {
            let signed_in = session_token(app).await.unwrap_or(None).is_some();
            let login = lock(&app.state::<DeveloperState>()).session.as_ref().map(|s| s.login.clone());
            Ok(json!({ "signedIn": signed_in, "login": login }))
        }
        "analytics.signIn" => {
            let reply = github_post("https://github.com/login/device/code", format!("client_id={GITHUB_CLIENT_ID}&scope=")).await?;
            let (Some(code), Some(user_code), Some(uri)) = (reply["device_code"].as_str(), reply["user_code"].as_str(), reply["verification_uri"].as_str()) else {
                return Err(reply["error_description"].as_str().unwrap_or("GitHub didn't start the sign-in").to_string());
            };
            let expires_in = reply["expires_in"].as_i64().unwrap_or(900);
            lock(&app.state::<DeveloperState>()).device = Some(DeviceCode { code: code.to_string(), expires_at: now_millis() + expires_in * 1000 });
            if uri.starts_with("https://github.com/") {
                let target = uri.to_string();
                let _ = tauri::async_runtime::spawn_blocking(move || crate::shell::open_url(&target)).await;
            }
            Ok(json!({ "userCode": user_code, "verificationUri": uri, "interval": reply["interval"].as_i64().unwrap_or(5) }))
        }
        "analytics.signInPoll" => {
            let code = {
                let state = app.state::<DeveloperState>();
                let inner = lock(&state);
                inner.device.as_ref().filter(|d| d.expires_at > now_millis()).map(|d| d.code.clone())
            };
            let Some(code) = code else { return Ok(json!({ "state": "expired" })) };
            let reply = github_post(
                "https://github.com/login/oauth/access_token",
                format!("client_id={GITHUB_CLIENT_ID}&device_code={code}&grant_type=urn:ietf:params:oauth:grant-type:device_code"),
            )
            .await?;
            if let Some(token) = reply["access_token"].as_str() {
                credentials::set(TOKEN_TARGET, token)?;
                lock(&app.state::<DeveloperState>()).device = None;
                if !mint_session(app).await? {
                    return Ok(json!({ "state": "denied" }));
                }
                return Ok(json!({ "state": "done" }));
            }
            Ok(json!({ "state": match reply["error"].as_str() {
                Some("authorization_pending" | "slow_down") => "pending",
                Some("expired_token") => "expired",
                _ => "denied",
            } }))
        }
        "analytics.signOut" => {
            let _ = credentials::delete(TOKEN_TARGET);
            lock(&app.state::<DeveloperState>()).session = None;
            Ok(Value::Null)
        }
        "analytics.get" => {
            let path = params["path"].as_str().ok_or("path is missing")?;
            if !allowed_path(path) {
                return Err("That isn't something the dashboard can read".into());
            }
            let mut query = Vec::new();
            if let Some(values) = params["query"].as_object() {
                for (key, value) in values {
                    if !allowed_query(key) {
                        return Err(format!("Unknown filter {key}"));
                    }
                    match value {
                        Value::String(text) => query.push((key.clone(), text.clone())),
                        Value::Number(number) => query.push((key.clone(), number.to_string())),
                        _ => {}
                    }
                }
            }
            admin_request(app, reqwest::Method::GET, path, &query, None).await
        }
        "analytics.putSettings" => {
            let settings = params["settings"].as_object().ok_or("settings are missing")?;
            admin_request(app, reqwest::Method::PUT, "settings", &[], Some(Value::Object(settings.clone()).to_string())).await
        }
        "analytics.deleteInstallation" => {
            let id = params["id"].as_str().ok_or("id is missing")?;
            if !crate::storage::is_identifier(id, 64) {
                return Err("Unknown installation".into());
            }
            admin_request(app, reqwest::Method::DELETE, &format!("installations/{id}"), &[], None).await
        }
        _ => Err("Unknown method".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_reads_leave_nova() {
        for good in ["live", "metrics", "hourly", "versions", "settings", "installations/abc-123"] {
            assert!(allowed_path(good), "{good}");
        }
        for bad in ["session", "../session", "installations/../session", "installations/a/b", "live?x=1", ""] {
            assert!(!allowed_path(bad), "{bad}");
        }
        assert!(allowed_query("from"));
        assert!(!allowed_query("token"));
    }
}
