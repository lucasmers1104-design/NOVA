//! NOVA writes in Discord for the user, in one channel they pick. Two ways in:
//! - A channel webhook ("Discord-Chat"). Everyone with NOVA can share the same one: each
//!   message shows the sender's name, "Luca · via Nova". A webhook can only write in its
//!   own channel, so a leaked address does little harm and is replaced in a click.
//! - An own bot token, for this PC only. It writes under the bot's name.
//! The webhook wins when both are set. Plain REST calls over NOVA's HTTP client, no new crate.
//! Everything lives in Windows' Credential Manager, like the clip webhook.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::credentials;

type CommandResult<T> = Result<T, String>;

const API: &str = "https://discord.com/api/v10";
const CHAT_TARGET: &str = "NOVA:discord-chat-webhook";
const TOKEN_TARGET: &str = "NOVA:discord-bot-token";
const CHANNEL_TARGET: &str = "NOVA:discord-bot-channel";
const LABEL_TARGET: &str = "NOVA:discord-bot-label";
/// Discord's limit for one message.
pub const MAX_CONTENT: usize = 2000;
/// Discord's limit for a webhook's display name.
const MAX_USERNAME: usize = 80;

/// Discord IDs are snowflakes: 17 to 20 digits.
pub fn valid_id(id: &str) -> bool {
    (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// Bot tokens are long and contain no spaces; anything else is a copy-paste mistake.
fn plausible_token(token: &str) -> bool {
    token.len() >= 50 && !token.contains(char::is_whitespace)
}

/// Trims the text and cuts it to Discord's limit.
pub fn clean_content(message: &str) -> String {
    message.trim().chars().take(MAX_CONTENT).collect()
}

/// The name a webhook message shows: "Luca · via Nova", or "NOVA" without a name.
/// Discord refuses webhook names containing "discord" or "clyde", so those words go.
fn sender_name(user: Option<&str>) -> String {
    let user = user.map(allowed_name).filter(|u| !u.is_empty());
    user.map_or_else(|| "NOVA".to_string(), |u| format!("{u} · via Nova").chars().take(MAX_USERNAME).collect())
}

/// The user's name without words Discord refuses, at most 40 characters.
fn allowed_name(name: &str) -> String {
    // ASCII-only lowercasing keeps byte positions the same as in `cleaned`.
    let mut cleaned = name.to_string();
    for banned in ["discord", "clyde"] {
        while let Some(at) = cleaned.to_ascii_lowercase().find(banned) {
            cleaned.replace_range(at..at + banned.len(), "");
        }
    }
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect()
}

/// The request body. `parse: []` means the text can't ping anyone, so "@everyone" stays plain text
/// even when it comes from a model that was tricked into writing it.
fn message_body(content: &str, username: Option<&str>) -> String {
    let mut body = json!({ "content": content, "allowed_mentions": { "parse": [] } });
    if let Some(username) = username {
        body["username"] = json!(username);
    }
    body.to_string()
}

/// What the user should fix, in plain words. Discord's own error text is never shown.
fn explain(status: reqwest::StatusCode, webhook: bool) -> String {
    match (status.as_u16(), webhook) {
        (401 | 404, true) => "Discord doesn't know this webhook any more. Copy a new address from the channel's settings.".into(),
        (401, false) => "Discord rejected the bot token. Check it in the Developer Portal.".into(),
        (403, _) => "NOVA can't write in that channel. Give the bot's role “Send Messages” there.".into(),
        (404, false) => "Discord can't find that channel. Is the bot on the server, and is the channel ID right?".into(),
        (429, _) => "Discord is limiting messages right now. Try again in a minute.".into(),
        (code, _) => format!("Discord answered {code}."),
    }
}

fn saved(target: &str) -> Option<String> {
    credentials::get(target).ok().flatten()
}

fn stored(target: &str, what: &str) -> Result<String, String> {
    saved(target).ok_or_else(|| format!("No Discord bot is set up yet ({what} missing). The user adds it under Settings."))
}

fn bot_set() -> bool {
    saved(TOKEN_TARGET).is_some() && saved(CHANNEL_TARGET).is_some()
}

/// Whether NOVA can write in Discord at all.
pub fn configured() -> bool {
    saved(CHAT_TARGET).is_some() || bot_set()
}

/// The name the user gave the channel, e.g. "die Jungs".
pub fn label() -> Option<String> {
    saved(LABEL_TARGET)
}

/// Whether messages show the sender's name (webhook) or the bot's.
pub fn as_user() -> bool {
    saved(CHAT_TARGET).is_some()
}

/// Posts `content` in the saved channel. `user` is the name from NOVA's settings, shown on
/// webhook messages. Returns the channel's name for the reply.
pub async fn send(content: &str, user: Option<&str>) -> Result<String, String> {
    let content = clean_content(content);
    if content.is_empty() {
        return Err("The message is empty.".into());
    }
    let channel_label = label().unwrap_or_else(|| "the channel".into());
    if let Some(webhook) = saved(CHAT_TARGET) {
        if !crate::replay::valid_webhook(&webhook) {
            return Err("The saved Discord address isn't a Discord webhook.".into());
        }
        let response = crate::http::client()
            .post(webhook.trim())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(message_body(&content, Some(&sender_name(user))))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(crate::http::describe)?;
        if !response.status().is_success() {
            return Err(explain(response.status(), true));
        }
        return Ok(channel_label);
    }
    let token = stored(TOKEN_TARGET, "token")?;
    let channel = stored(CHANNEL_TARGET, "channel")?;
    let response = crate::http::client()
        .post(format!("{API}/channels/{channel}/messages"))
        .header(reqwest::header::AUTHORIZATION, format!("Bot {token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(message_body(&content, None))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(crate::http::describe)?;
    if !response.status().is_success() {
        return Err(explain(response.status(), false));
    }
    Ok(channel_label)
}

/// Asks Discord whether the saved webhook or bot works. Returns its name.
pub async fn check() -> Result<String, String> {
    let request = if let Some(webhook) = saved(CHAT_TARGET) {
        if !crate::replay::valid_webhook(&webhook) {
            return Err("The saved Discord address isn't a Discord webhook.".into());
        }
        // GET on a webhook's address describes it without posting anything.
        crate::http::client().get(webhook.trim())
    } else {
        let token = stored(TOKEN_TARGET, "token")?;
        crate::http::client().get(format!("{API}/users/@me")).header(reqwest::header::AUTHORIZATION, format!("Bot {token}"))
    };
    let webhook = as_user();
    let response = request.timeout(Duration::from_secs(15)).send().await.map_err(crate::http::describe)?;
    if !response.status().is_success() {
        return Err(explain(response.status(), webhook));
    }
    let text = response.text().await.map_err(crate::http::describe)?;
    let me: Value = serde_json::from_str(&text).map_err(|_| "Discord sent an answer NOVA doesn't understand.".to_string())?;
    let key = if webhook { "name" } else { "username" };
    Ok(me[key].as_str().unwrap_or("NOVA").to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    configured: bool,
    /// A shared channel webhook is saved.
    chat: bool,
    /// An own bot token and channel are saved.
    bot: bool,
    label: Option<String>,
}

fn status() -> DiscordStatus {
    DiscordStatus { configured: configured(), chat: saved(CHAT_TARGET).is_some(), bot: bot_set(), label: label() }
}

/// Saves the channel's name, or forgets it once neither way is set up.
fn save_label(label: &str) -> Result<(), String> {
    let label: String = label.trim().chars().take(40).collect();
    if !configured() {
        credentials::delete(LABEL_TARGET)
    } else if !label.is_empty() {
        credentials::set(LABEL_TARGET, &label)
    } else {
        Ok(())
    }
}

/// Whether a bot is set up, for the settings page.
#[tauri::command]
pub async fn discord_bot_status() -> CommandResult<DiscordStatus> {
    Ok(status())
}

/// Saves the shared channel webhook, or removes it when empty.
#[tauri::command]
pub async fn discord_chat_set(webhook: String, label: String) -> CommandResult<DiscordStatus> {
    let webhook = webhook.trim();
    if webhook.is_empty() {
        credentials::delete(CHAT_TARGET)?;
    } else if crate::replay::valid_webhook(webhook) {
        credentials::set(CHAT_TARGET, webhook)?;
    } else {
        return Err("That isn't a Discord webhook address. In Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.".into());
    }
    save_label(&label)?;
    Ok(status())
}

/// Saves the bot's token and channel ID, or removes both when the token is empty.
#[tauri::command]
pub async fn discord_bot_set(token: String, channel_id: String, label: String) -> CommandResult<DiscordStatus> {
    let token = token.trim();
    let channel_id = channel_id.trim();
    if token.is_empty() {
        credentials::delete(TOKEN_TARGET)?;
        credentials::delete(CHANNEL_TARGET)?;
    } else {
        if !plausible_token(token) {
            return Err("That doesn't look like a bot token. In the Developer Portal: Bot → Reset Token, then copy it here.".into());
        }
        if !valid_id(channel_id) {
            return Err("The channel ID is 17 to 20 digits. In Discord: Settings → Advanced → Developer Mode, then right-click the channel → Copy Channel ID.".into());
        }
        credentials::set(TOKEN_TARGET, token)?;
        credentials::set(CHANNEL_TARGET, channel_id)?;
    }
    save_label(&label)?;
    Ok(status())
}

/// Checks the saved webhook or bot with Discord and returns its name.
#[tauri::command]
pub async fn discord_bot_check() -> CommandResult<String> {
    check().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discord_ids_have_seventeen_to_twenty_digits() {
        assert!(valid_id("123456789012345678"));
        assert!(valid_id("12345678901234567890"));
        assert!(!valid_id("1234567890123456"));
        assert!(!valid_id("123456789012345678901"));
        assert!(!valid_id("12345678901234567a"));
        assert!(!valid_id(""));
    }

    #[test]
    fn tokens_are_long_and_contain_no_spaces() {
        let token = "a".repeat(59);
        assert!(plausible_token(&token));
        assert!(!plausible_token("short"));
        assert!(!plausible_token(&format!("{token} tail")));
    }

    #[test]
    fn messages_are_trimmed_and_capped() {
        assert_eq!(clean_content("  hi  "), "hi");
        assert_eq!(clean_content(&"a".repeat(MAX_CONTENT + 50)).chars().count(), MAX_CONTENT);
    }

    #[test]
    fn messages_never_ping_anyone() {
        let body: Value = serde_json::from_str(&message_body("@everyone hallo", None)).unwrap();
        assert_eq!(body["content"], "@everyone hallo");
        assert_eq!(body["allowed_mentions"]["parse"], json!([]));
        assert!(body.get("username").is_none());
    }

    #[test]
    fn webhook_messages_carry_the_senders_name() {
        let body: Value = serde_json::from_str(&message_body("hi", Some("Luca · via Nova"))).unwrap();
        assert_eq!(body["username"], "Luca · via Nova");
        assert_eq!(sender_name(Some(" Luca ")), "Luca · via Nova");
        assert_eq!(sender_name(None), "NOVA");
        assert_eq!(sender_name(Some("  ")), "NOVA");
    }

    #[test]
    fn sender_names_avoid_words_discord_refuses() {
        assert_eq!(sender_name(Some("DiscordKing")), "King · via Nova");
        assert_eq!(sender_name(Some("clyde")), "NOVA");
        assert_eq!(sender_name(Some("Jörg DISCORD")), "Jörg · via Nova");
        assert!(sender_name(Some(&"x".repeat(200))).chars().count() <= MAX_USERNAME);
    }

    #[test]
    fn errors_say_what_to_fix() {
        assert!(explain(reqwest::StatusCode::UNAUTHORIZED, false).contains("token"));
        assert!(explain(reqwest::StatusCode::NOT_FOUND, true).contains("webhook"));
        assert!(explain(reqwest::StatusCode::FORBIDDEN, false).contains("Send Messages"));
        assert!(explain(reqwest::StatusCode::NOT_FOUND, false).contains("channel"));
        assert_eq!(explain(reqwest::StatusCode::BAD_GATEWAY, true), "Discord answered 502.");
    }
}
