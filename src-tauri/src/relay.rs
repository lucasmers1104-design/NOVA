//! NOVA-Relay: a Discord bot on the user's server (server/relay). Every NOVA writes and speaks
//! through it with its own key, so friends share one bot without sharing its token.
//! Address and key live in Windows' Credential Manager; the names the user gives channels
//! ("die Jungs") live in NOVA's database. Messages and announcements always need a confirm.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::credentials;
use crate::storage::{self, Database};

type CommandResult<T> = Result<T, String>;

const URL_TARGET: &str = "NOVA:relay-url";
const KEY_TARGET: &str = "NOVA:relay-key";
const ALIASES_KEY: &str = "nova.relay.aliases";
/// Discord's limit for one message.
pub const MAX_MESSAGE: usize = 2000;
/// About 30 seconds of speech, the relay's limit for one announcement.
pub const MAX_ANNOUNCEMENT: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Text,
    Voice,
}

/// A channel the user gave a name, e.g. "die Jungs" = #allgemein on "Zocken".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alias {
    pub name: String,
    pub channel_id: String,
    pub channel: String,
    pub server: String,
    pub kind: Kind,
}

/// Discord IDs are snowflakes: 17 to 20 digits.
fn valid_id(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// Only an https address without a login in it, and no path beyond "/".
pub fn valid_url(address: &str) -> bool {
    let Ok(parsed) = url::Url::parse(address.trim()) else { return false };
    parsed.scheme() == "https" && parsed.host_str().is_some_and(|h| !h.is_empty()) && parsed.username().is_empty() && parsed.password().is_none() && parsed.query().is_none()
}

/// The address without a trailing slash, so paths can be appended.
fn base_url(address: &str) -> String {
    address.trim().trim_end_matches('/').to_string()
}

/// Relay keys look like `nova_<8 hex>_<43 base64url>`.
pub fn plausible_key(key: &str) -> bool {
    let mut parts = key.trim().splitn(3, '_');
    let (Some("nova"), Some(id), Some(secret)) = (parts.next(), parts.next(), parts.next()) else { return false };
    id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()) && secret.len() == 43 && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn normalize(name: &str) -> String {
    name.trim().trim_start_matches('#').trim().to_lowercase()
}

/// Finds the channel the user means: by the name they gave it, then by the channel's own name.
/// With nothing asked for and only one channel of that kind, that one.
pub fn pick<'a>(aliases: &'a [Alias], wanted: &str, kind: Kind) -> Result<&'a Alias, String> {
    let of_kind: Vec<&Alias> = aliases.iter().filter(|a| a.kind == kind).collect();
    let what = if kind == Kind::Text { "text channel" } else { "voice channel" };
    if of_kind.is_empty() {
        return Err(format!("No Discord {what} is set up in NOVA yet. The user adds one under Settings → Spiele & Clips → NOVA-Relay."));
    }
    let wanted = normalize(wanted);
    if wanted.is_empty() {
        return match of_kind.as_slice() {
            [only] => Ok(only),
            _ => Err(format!("Which {what}? The user named these: {}.", names(&of_kind))),
        };
    }
    of_kind
        .iter()
        .find(|a| normalize(&a.name) == wanted)
        .or_else(|| of_kind.iter().find(|a| normalize(&a.channel) == wanted))
        .copied()
        .ok_or_else(|| format!("There's no {what} called “{wanted}”. The user named these: {}.", names(&of_kind)))
}

fn names(aliases: &[&Alias]) -> String {
    aliases.iter().map(|a| format!("“{}”", a.name)).collect::<Vec<_>>().join(", ")
}

/// Cleans what the settings page sends: names trimmed and unique, IDs valid.
fn clean_aliases(list: Vec<Alias>) -> Result<Vec<Alias>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for mut alias in list {
        alias.name = alias.name.trim().chars().take(40).collect();
        if alias.name.is_empty() {
            continue;
        }
        if !valid_id(&alias.channel_id) {
            return Err(format!("“{}” has no valid channel.", alias.name));
        }
        if !seen.insert((normalize(&alias.name), alias.kind)) {
            return Err(format!("The name “{}” is used twice.", alias.name));
        }
        alias.channel = alias.channel.trim().chars().take(100).collect();
        alias.server = alias.server.trim().chars().take(100).collect();
        out.push(alias);
    }
    Ok(out)
}

/// The relay's own error sentence, or a plain one by status.
fn explain(status: reqwest::StatusCode, body: &str) -> String {
    let said = serde_json::from_str::<Value>(body).ok().and_then(|v| v["error"].as_str().map(str::to_string));
    match (status.as_u16(), said) {
        (401, _) => "The relay doesn't know this key. Ask whoever runs it for a new one.".into(),
        (_, Some(message)) => message,
        (code, None) => format!("The relay answered {code}."),
    }
}

fn saved() -> Option<(String, String)> {
    let address = credentials::get(URL_TARGET).ok().flatten()?;
    let key = credentials::get(KEY_TARGET).ok().flatten()?;
    Some((base_url(&address), key))
}

fn connection() -> Result<(String, String), String> {
    saved().ok_or_else(|| "NOVA-Relay isn't set up yet. The user adds its address and key under Settings → Spiele & Clips.".into())
}

/// Whether an address and a key are saved.
pub fn configured() -> bool {
    saved().is_some()
}

pub fn aliases<R: Runtime>(app: &AppHandle<R>) -> Vec<Alias> {
    app.state::<Database>()
        .with(|c| storage::kv_get(c, ALIASES_KEY))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

async fn finish(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(crate::http::describe)?;
    if !status.is_success() {
        return Err(explain(status, &body));
    }
    serde_json::from_str(&body).map_err(|_| "The relay sent an answer NOVA doesn't understand.".to_string())
}

async fn get(path: &str) -> Result<Value, String> {
    request(reqwest::Method::GET, path).await
}

/// A request without a body.
async fn request(method: reqwest::Method, path: &str) -> Result<Value, String> {
    let (base, key) = connection()?;
    let mut call = crate::http::client()
        .request(method.clone(), format!("{base}{path}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .timeout(Duration::from_secs(15));
    if method == reqwest::Method::POST {
        call = call.header(reqwest::header::CONTENT_TYPE, "application/json").body("{}");
    }
    finish(call.send().await.map_err(crate::http::describe)?).await
}

/// Posts `content` in a text channel. Returns where it went, e.g. "allgemein (Zocken)".
pub async fn send(channel_id: &str, content: &str) -> Result<String, String> {
    let (base, key) = connection()?;
    let response = crate::http::client()
        .post(format!("{base}/v1/messages"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({ "channelId": channel_id, "content": content }).to_string())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(crate::http::describe)?;
    Ok(finish(response).await?["channel"].as_str().unwrap_or("Discord").to_string())
}

/// Plays a WAV announcement in a call: `channel_id`, or the busiest call. Returns where it played.
pub async fn announce(channel_id: Option<&str>, wav: Vec<u8>) -> Result<String, String> {
    let (base, key) = connection()?;
    let query = channel_id.map(|id| format!("?channelId={id}")).unwrap_or_default();
    let response = crate::http::client()
        .post(format!("{base}/v1/voice/announce{query}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::CONTENT_TYPE, "audio/wav")
        .body(wav)
        // Joining, speaking up to 30 seconds and leaving.
        .timeout(Duration::from_secs(75))
        .send()
        .await
        .map_err(crate::http::describe)?;
    Ok(finish(response).await?["channel"].as_str().unwrap_or("the call").to_string())
}

/// The calls with people in them, from the relay's channel list: "Lobby (Zocken)".
pub fn busy_calls(channels: &Value) -> Vec<String> {
    let mut calls = Vec::new();
    for server in channels["servers"].as_array().into_iter().flatten() {
        for voice in server["voice"].as_array().into_iter().flatten() {
            if voice["people"].as_u64().unwrap_or(0) > 0 {
                calls.push(format!("{} ({})", voice["name"].as_str().unwrap_or("?"), server["name"].as_str().unwrap_or("?")));
            }
        }
    }
    calls
}

/// Before speaking into "the busiest call": with several calls going, the user has to say which.
pub async fn one_busy_call() -> Result<(), String> {
    let calls = busy_calls(&get("/v1/channels").await?);
    if calls.len() > 1 {
        return Err(format!(
            "Several Discord calls have people in them: {}. Nothing was said. Ask the user which one; it has to be one they named under Discord in NOVA.",
            calls.join(", ")
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    configured: bool,
    address: Option<String>,
    aliases: Vec<Alias>,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> RelayStatus {
    RelayStatus { configured: configured(), address: credentials::get(URL_TARGET).ok().flatten(), aliases: aliases(app) }
}

#[tauri::command]
pub async fn relay_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<RelayStatus> {
    Ok(status(&app))
}

/// Saves the relay's address and the user's key, or forgets both when the address is empty.
#[tauri::command]
pub async fn relay_set<R: Runtime>(app: AppHandle<R>, address: String, key: String) -> CommandResult<RelayStatus> {
    let address = address.trim();
    let key = key.trim();
    if address.is_empty() {
        credentials::delete(URL_TARGET)?;
        credentials::delete(KEY_TARGET)?;
        return Ok(status(&app));
    }
    if !valid_url(address) {
        return Err("That isn't an https address, e.g. https://nova.example.com.".into());
    }
    if !plausible_key(key) {
        return Err("That doesn't look like a relay key. It starts with nova_ and is about 60 characters long.".into());
    }
    credentials::set(URL_TARGET, &base_url(address))?;
    credentials::set(KEY_TARGET, key)?;
    Ok(status(&app))
}

/// Asks the relay who this key belongs to: `{ name, shownAs, linked, avatar }`.
#[tauri::command]
pub async fn relay_check() -> CommandResult<Value> {
    get("/v1/me").await
}

/// The servers and channels this key may use, live from the relay.
#[tauri::command]
pub async fn relay_channels() -> CommandResult<Value> {
    get("/v1/channels").await
}

/// A short code that links this key to the user's Discord account: they type `/nova code:<code>`
/// in Discord, and messages then carry their profile picture. `{ code, expiresIn }`.
#[tauri::command]
pub async fn relay_link() -> CommandResult<Value> {
    request(reqwest::Method::POST, "/v1/me/link").await
}

/// Messages go back to the default picture.
#[tauri::command]
pub async fn relay_unlink() -> CommandResult<Value> {
    request(reqwest::Method::DELETE, "/v1/me/link").await
}

/// Saves the names the user gave channels.
#[tauri::command]
pub async fn relay_aliases_set<R: Runtime>(app: AppHandle<R>, aliases: Vec<Alias>) -> CommandResult<RelayStatus> {
    let clean = clean_aliases(aliases)?;
    let text = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, ALIASES_KEY, &text))?;
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias(name: &str, channel: &str, kind: Kind) -> Alias {
        Alias { name: name.into(), channel_id: "123456789012345678".into(), channel: channel.into(), server: "Zocken".into(), kind }
    }

    #[test]
    fn only_https_addresses_without_logins() {
        assert!(valid_url("https://nova.example.com"));
        assert!(valid_url(" https://abc.203.0.113.7.sslip.io/ "));
        assert!(!valid_url("http://nova.example.com"));
        assert!(!valid_url("https://user:pw@nova.example.com"));
        assert!(!valid_url("https://nova.example.com/?x=1"));
        assert!(!valid_url("nova.example.com"));
        assert_eq!(base_url("https://nova.example.com/"), "https://nova.example.com");
    }

    #[test]
    fn keys_have_the_relay_shape() {
        let key = format!("nova_0123abcd_{}", "a".repeat(43));
        assert!(plausible_key(&key));
        assert!(!plausible_key(&format!("nova_0123abcz_{}", "a".repeat(43))));
        assert!(!plausible_key(&format!("nova_0123abcd_{}", "a".repeat(42))));
        assert!(!plausible_key("sk-123"));
    }

    #[test]
    fn channels_are_found_by_name_then_channel_name() {
        let list = vec![alias("die Jungs", "allgemein", Kind::Text), alias("Mama", "familie", Kind::Text), alias("Zocken", "Lobby", Kind::Voice)];
        assert_eq!(pick(&list, "Die Jungs", Kind::Text).unwrap().name, "die Jungs");
        assert_eq!(pick(&list, "#familie", Kind::Text).unwrap().name, "Mama");
        assert_eq!(pick(&list, "", Kind::Voice).unwrap().name, "Zocken");
        assert!(pick(&list, "", Kind::Text).unwrap_err().contains("“die Jungs”, “Mama”"));
        assert!(pick(&list, "Oma", Kind::Text).unwrap_err().contains("no text channel called “oma”"));
        // A voice channel isn't a text channel.
        assert!(pick(&list, "Zocken", Kind::Text).is_err());
        assert!(pick(&[], "x", Kind::Voice).unwrap_err().contains("No Discord voice channel"));
    }

    #[test]
    fn names_are_cleaned_and_unique() {
        let clean = clean_aliases(vec![alias("  die Jungs ", "allgemein", Kind::Text), alias("", "x", Kind::Text)]).unwrap();
        assert_eq!(clean.len(), 1);
        assert_eq!(clean[0].name, "die Jungs");
        assert!(clean_aliases(vec![alias("A", "x", Kind::Text), alias("a", "y", Kind::Text)]).unwrap_err().contains("twice"));
        // The same name for a text and a voice channel is fine.
        assert!(clean_aliases(vec![alias("Jungs", "x", Kind::Text), alias("Jungs", "y", Kind::Voice)]).is_ok());
        let mut bad = alias("B", "x", Kind::Text);
        bad.channel_id = "12".into();
        assert!(clean_aliases(vec![bad]).is_err());
    }

    #[test]
    fn busy_calls_are_listed_with_their_server() {
        let channels = json!({ "servers": [
            { "name": "Zocken", "voice": [{ "name": "Lobby", "people": 2 }, { "name": "AFK", "people": 0 }] },
            { "name": "Test", "voice": [{ "name": "Talk", "people": 1 }] },
        ] });
        assert_eq!(busy_calls(&channels), vec!["Lobby (Zocken)", "Talk (Test)"]);
        assert!(busy_calls(&json!({ "servers": [] })).is_empty());
        assert!(busy_calls(&json!({})).is_empty());
    }

    #[test]
    fn errors_use_the_relays_sentence() {
        assert_eq!(explain(reqwest::StatusCode::FORBIDDEN, r#"{"error":"The bot needs “Speak” in #Lobby."}"#), "The bot needs “Speak” in #Lobby.");
        assert!(explain(reqwest::StatusCode::UNAUTHORIZED, "{}").contains("doesn't know this key"));
        assert_eq!(explain(reqwest::StatusCode::BAD_GATEWAY, "<html>"), "The relay answered 502.");
    }
}
