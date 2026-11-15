//! The developer key. Without it NOVA's AI answers only with Claude Haiku, and the Discord
//! relay keeps its cooldowns; with it, entered under Settings → Entwickler, both are lifted.
//!
//! Only the key's SHA-256 is in the code (made by `node scripts/dev-key.mjs`, which keeps the
//! key itself at %USERPROFILE%\.nova\dev-key.txt). The key the user enters is checked against
//! it and then kept in Windows' credential store.

use std::sync::atomic::{AtomicU8, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ai::Provider;
use crate::credentials;
type CommandResult<T> = Result<T, String>;

const DEV_KEY_SHA256: &str = "a730db4559ecaf236c932a1a51ce901a065de8506430ff7f3176cf352cd8f3a4";
const TARGET: &str = "NOVA:dev-key";

/// The one model everyone without the key gets.
pub const LOCKED_MODEL: &str = "claude-haiku-5-5";

/// 0 = not looked yet, 1 = locked, 2 = unlocked.
static STATE: AtomicU8 = AtomicU8::new(0);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `key` is the developer key, compared without an early exit.
fn matches(key: &str) -> bool {
    let given = hex(&Sha256::digest(key.trim().as_bytes()));
    given.len() == DEV_KEY_SHA256.len() && given.bytes().zip(DEV_KEY_SHA256.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// The saved key, if it is the right one (for the relay, which checks it too).
pub fn key() -> Option<String> {
    credentials::get(TARGET).ok().flatten().filter(|key| matches(key))
}

/// Whether this PC has the developer key.
pub fn unlocked() -> bool {
    match STATE.load(Ordering::Relaxed) {
        2 => true,
        1 => false,
        _ => {
            let open = key().is_some();
            STATE.store(if open { 2 } else { 1 }, Ordering::Relaxed);
            open
        }
    }
}

/// Whether this provider and model may answer here.
pub fn allows(provider: Provider, model: &str) -> bool {
    unlocked() || allowed_when_locked(provider, model)
}

fn allowed_when_locked(provider: Provider, model: &str) -> bool {
    provider == Provider::Anthropic && (model == LOCKED_MODEL || model.starts_with(&format!("{LOCKED_MODEL}-")))
}

/// What the AI settings say when a choice isn't allowed.
pub const LOCKED_MESSAGE: &str = "Ohne Entwickler-Schlüssel steht nur Claude Haiku zur Verfügung.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevKeyStatus {
    unlocked: bool,
    locked_model: &'static str,
}

fn status() -> DevKeyStatus {
    DevKeyStatus { unlocked: unlocked(), locked_model: LOCKED_MODEL }
}

#[tauri::command]
pub async fn dev_key_status() -> CommandResult<DevKeyStatus> {
    Ok(status())
}

/// Saves the developer key if it is the right one; an empty one removes it.
#[tauri::command]
pub async fn dev_key_set(key: String) -> CommandResult<DevKeyStatus> {
    let key = key.trim();
    if key.is_empty() {
        credentials::delete(TARGET)?;
        STATE.store(1, Ordering::Relaxed);
        return Ok(status());
    }
    if !matches(key) {
        // A wrong guess costs a moment, so trying many is slow.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        return Err("Dieser Schlüssel stimmt nicht.".into());
    }
    credentials::set(TARGET, key)?;
    STATE.store(2, Ordering::Relaxed);
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_right_key_matches() {
        assert!(!matches(""));
        assert!(!matches("novadev_wrong"));
        assert!(!matches(DEV_KEY_SHA256));
    }

    #[test]
    fn locked_means_claude_haiku_only() {
        assert!(allowed_when_locked(Provider::Anthropic, "claude-haiku-5-5"));
        assert!(allowed_when_locked(Provider::Anthropic, "claude-haiku-5-5-20261001"));
        assert!(!allowed_when_locked(Provider::Anthropic, "claude-opus-5-5"));
        assert!(!allowed_when_locked(Provider::Anthropic, "claude-sonnet-5-5"));
        assert!(!allowed_when_locked(Provider::Anthropic, "claude-haiku-5-55"));
        assert!(!allowed_when_locked(Provider::Openai, "claude-haiku-5-5"));
        assert!(!allowed_when_locked(Provider::Gemini, "gemini-pro"));
    }
}
