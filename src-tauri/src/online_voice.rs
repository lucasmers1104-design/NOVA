//! Online voices: Google Gemini (free tier, uses the Gemini key from AI
//! providers) and ElevenLabs (free monthly credits, its own key). The text NOVA
//! says goes to that service, only while such a voice is picked.
//!
//! A voice preference looks like "online:gemini:Kore" or "online:elevenlabs:<voice id>".
//! Audio comes back as a file the panel decodes (WAV from Gemini, MP3 from ElevenLabs).

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use crate::ai::Provider;
use crate::credentials;

type CommandResult<T> = Result<T, String>;

const GEMINI_URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
/// The faster of Google's two: about 3.5 s for a sentence here, against 5 s.
const GEMINI_MODEL: &str = "gemini-3.8-flash-lite-tts";
const ELEVENLABS_URL: &str = "https://api.elevenlabs.io/v1";
/// Fast, and costs half the credits per character of the larger models.
const ELEVENLABS_MODEL: &str = "eleven_flash_v2_5";
const ELEVENLABS_KEY: &str = "NOVA:tts:elevenlabs";

/// One piece of a reply; a slow service falls back to NOVA's own voice.
const REQUEST_LIMIT: Duration = Duration::from_secs(30);
const LONGEST_AUDIO: usize = 16 * 1024 * 1024;
/// After "too many requests" NOVA doesn't ask again for this long, so each
/// sentence doesn't wait for another refusal.
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);

static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq)]
enum Service {
    Gemini,
    ElevenLabs,
}

pub fn is_online(voice: &str) -> bool {
    voice.starts_with("online:")
}

/// The voice id ends up in a URL, so only plain ids get through.
fn parse(voice: &str) -> Option<(Service, &str)> {
    let (service, id) = voice.strip_prefix("online:")?.split_once(':')?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    match service {
        "gemini" => Some((Service::Gemini, id)),
        "elevenlabs" => Some((Service::ElevenLabs, id)),
        _ => None,
    }
}

fn gemini_body(voice: &str, text: &str, rate: f32) -> Value {
    // Gemini has no speed number; it takes its delivery from a short description.
    let style = if rate >= 1.15 { Some("speak quickly") } else if rate <= 0.85 { Some("speak slowly") } else { None };
    let mut content = json!({ "type": "text", "text": text });
    if let Some(style) = style {
        content["annotations"] = json!([{ "type": "speech_metadata", "style": style }]);
    }
    json!({
        "model": GEMINI_MODEL,
        "input": [{ "type": "user_input", "content": [content] }],
        "response_format": { "type": "audio" },
        "generation_config": { "speech_config": [{ "voice": voice }] },
    })
}

/// The last audio part of the model's output, as a complete WAV file.
fn gemini_audio(reply: &Value) -> Result<Vec<u8>, String> {
    let audio = reply["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .rfind(|part| part["type"] == "audio")
        .and_then(|part| part["data"].as_str())
        .ok_or("Gemini sent no audio")?;
    base64::engine::general_purpose::STANDARD.decode(audio).map_err(|_| "Gemini's audio couldn't be read".to_string())
}

fn elevenlabs_body(text: &str, rate: f32, language: Option<&str>) -> Value {
    let mut body = json!({ "text": text, "model_id": ELEVENLABS_MODEL });
    if let Some(language) = language {
        body["language_code"] = json!(language);
    }
    if (rate - 1.0).abs() > 0.01 {
        // The service's range. Rounded: as a double, 1.2 from an f32 would be just above it.
        body["voice_settings"] = json!({ "speed": f64::from((rate.clamp(0.7, 1.2) * 100.0).round()) / 100.0 });
    }
    body
}

async fn checked(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let code = response.status();
    let body = crate::http::read_limited(response, LONGEST_AUDIO).await?;
    if code == reqwest::StatusCode::TOO_MANY_REQUESTS {
        *PAUSED_UNTIL.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now() + RATE_LIMIT_PAUSE);
    }
    if code.is_success() {
        Ok(body)
    } else {
        Err(error_message(code, &String::from_utf8_lossy(&body)))
    }
}

/// ElevenLabs puts its reason in `detail`, Gemini sends its `error` inside a list.
fn error_message(code: reqwest::StatusCode, body: &str) -> String {
    let reply = serde_json::from_str::<Value>(body).unwrap_or_default();
    let reply = reply.get(0).unwrap_or(&reply);
    let detail = reply["detail"]["message"].as_str().or(reply["error"]["message"].as_str());
    match detail {
        Some(detail) => crate::http::api_error_message(code, &json!({ "error": { "message": detail } }).to_string()),
        None => crate::http::api_error_message(code, body),
    }
}

async fn request(service: Service, voice: &str, text: &str, rate: f32, language: Option<&str>) -> Result<Vec<u8>, String> {
    let client = crate::http::client();
    match service {
        Service::Gemini => {
            let key = Provider::Gemini.api_key()?;
            let response = client.post(GEMINI_URL).header("x-goog-api-key", key).json(&gemini_body(voice, text, rate)).timeout(REQUEST_LIMIT).send().await.map_err(crate::http::describe)?;
            let reply = checked(response).await?;
            let reply = serde_json::from_slice::<Value>(&reply).map_err(|_| "Gemini's answer couldn't be read".to_string())?;
            gemini_audio(&reply)
        }
        Service::ElevenLabs => {
            let key = credentials::get(ELEVENLABS_KEY)?.ok_or("Add your ElevenLabs API key under Settings → Assistant model & voice first.")?;
            let url = format!("{ELEVENLABS_URL}/text-to-speech/{voice}?output_format=mp3_44100_128");
            let response = client.post(url).header("xi-api-key", key).json(&elevenlabs_body(text, rate, language)).timeout(REQUEST_LIMIT).send().await.map_err(crate::http::describe)?;
            checked(response).await
        }
    }
}

fn cache_file<R: Runtime>(app: &AppHandle<R>, voice: &str, text: &str, rate: f32) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("No local data folder: {e}"))?.join("voice").join("online");
    let digest = Sha256::digest(format!("{voice}|{rate}|{text}"));
    let name: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    Ok(dir.join(name))
}

/// Says `text` with an online voice. `keep`: one of NOVA's fixed lines
/// ("one moment", a greeting), kept on disk so it costs one request ever and
/// plays at once. What NOVA answers is never kept.
pub async fn speak<R: Runtime>(app: &AppHandle<R>, voice: &str, text: &str, rate: f32, language: Option<&str>, keep: bool) -> Result<Vec<u8>, String> {
    let (service, id) = parse(voice).ok_or("Unknown online voice")?;
    let cached = if keep { cache_file(app, voice, text, rate).ok() } else { None };
    if let Some(audio) = cached.as_ref().and_then(|file| std::fs::read(file).ok()) {
        return Ok(audio);
    }
    if PAUSED_UNTIL.lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|until| Instant::now() < until) {
        return Err("Rate limited: the free limit was reached for now".into());
    }
    let audio = request(service, id, text, rate, language).await?;
    if let Some(file) = cached {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, &audio);
    }
    Ok(audio)
}

#[derive(Debug, Serialize)]
pub struct OnlineVoiceKeys {
    gemini: bool,
    elevenlabs: bool,
}

#[tauri::command]
pub async fn online_voice_keys() -> CommandResult<OnlineVoiceKeys> {
    Ok(OnlineVoiceKeys { gemini: Provider::Gemini.api_key().is_ok(), elevenlabs: credentials::get(ELEVENLABS_KEY)?.is_some() })
}

#[tauri::command]
pub async fn elevenlabs_key_set(key: String) -> CommandResult<()> {
    let key = key.trim();
    if key.len() < 10 || key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a valid API key".into());
    }
    credentials::set(ELEVENLABS_KEY, key)
}

#[tauri::command]
pub async fn elevenlabs_key_delete() -> CommandResult<()> {
    credentials::delete(ELEVENLABS_KEY)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct OnlineVoice {
    id: String,
    name: String,
}

fn elevenlabs_voices(reply: &Value) -> Vec<OnlineVoice> {
    reply["voices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| Some(OnlineVoice { id: v["voice_id"].as_str()?.to_string(), name: v["name"].as_str()?.chars().take(60).collect() }))
        .filter(|v| parse(&format!("online:elevenlabs:{}", v.id)).is_some())
        .collect()
}

/// The voices this ElevenLabs account can use, the ones it added itself included.
#[tauri::command]
pub async fn elevenlabs_voices_list() -> CommandResult<Vec<OnlineVoice>> {
    let Some(key) = credentials::get(ELEVENLABS_KEY)? else { return Ok(Vec::new()) };
    let response = crate::http::client().get(format!("{ELEVENLABS_URL}/voices")).header("xi-api-key", key).timeout(REQUEST_LIMIT).send().await.map_err(crate::http::describe)?;
    let reply = checked(response).await?;
    Ok(elevenlabs_voices(&serde_json::from_slice(&reply).map_err(|_| "ElevenLabs' answer couldn't be read".to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Times both Gemini voice models with the key saved in NOVA.
    /// `cargo test -- --ignored gemini_models --nocapture`
    #[test]
    #[ignore]
    fn gemini_models() {
        let key = Provider::Gemini.api_key().unwrap();
        let client = reqwest::Client::new();
        let out = std::env::var_os("NOVA_VOICE_OUT").map(PathBuf::from);
        tauri::async_runtime::block_on(async {
            for round in 0..2 {
                for model in ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"] {
                    for (name, text) in [("kurz", "Alles klar, mach ich."), ("lang", "Klar, ich schaue mir das an und sage dir gleich Bescheid, was dein PC gerade so langsam macht.")] {
                        let mut body = gemini_body("Sulafat", text, 1.0);
                        body["model"] = json!(model);
                        let started = Instant::now();
                        let response = client.post(GEMINI_URL).header("x-goog-api-key", &key).json(&body).send().await.unwrap();
                        let status = response.status();
                        let bytes = response.bytes().await.unwrap();
                        let ms = started.elapsed().as_millis();
                        let audio = serde_json::from_slice::<Value>(&bytes).ok().and_then(|reply| gemini_audio(&reply).ok());
                        eprintln!("{round} {model} {name}: {status} {ms} ms, {} KB audio", audio.as_ref().map_or(0, |a| a.len() / 1024));
                        if let (Some(dir), Some(audio), 0) = (&out, audio, round) {
                            let _ = std::fs::write(dir.join(format!("{model}-{name}.wav")), audio);
                        }
                    }
                }
            }
        });
    }

    #[test]
    fn voice_ids_are_plain() {
        assert_eq!(parse("online:gemini:Kore"), Some((Service::Gemini, "Kore")));
        assert_eq!(parse("online:elevenlabs:JBFqnCBsd6RMkjVDRZzb"), Some((Service::ElevenLabs, "JBFqnCBsd6RMkjVDRZzb")));
        assert_eq!(parse("online:elevenlabs:../../user"), None);
        assert_eq!(parse("online:elevenlabs:a?b=c"), None);
        assert_eq!(parse("online:other:x"), None);
        assert_eq!(parse("nova:thorsten"), None);
        assert!(is_online("online:gemini:Kore") && !is_online("nova:thorsten") && !is_online(""));
    }

    #[test]
    fn asks_gemini_as_documented() {
        let body = gemini_body("Kore", "Hallo", 1.0);
        assert_eq!(body["model"], GEMINI_MODEL);
        assert_eq!(body["input"][0]["content"][0], json!({ "type": "text", "text": "Hallo" }));
        assert_eq!(body["response_format"]["type"], "audio");
        assert_eq!(body["generation_config"]["speech_config"][0]["voice"], "Kore");
        assert_eq!(gemini_body("Kore", "Hallo", 1.5)["input"][0]["content"][0]["annotations"][0]["style"], "speak quickly");
    }

    #[test]
    fn takes_the_last_audio_of_the_model_output() {
        let reply = json!({ "steps": [
            { "type": "thought", "content": [{ "type": "audio", "data": "AAAA" }] },
            { "type": "model_output", "content": [{ "type": "text", "text": "x" }, { "type": "audio", "data": "UklGRg==" }] },
        ]});
        assert_eq!(gemini_audio(&reply).unwrap(), b"RIFF");
        assert!(gemini_audio(&json!({ "steps": [] })).is_err());
        assert!(gemini_audio(&json!({ "steps": [{ "type": "model_output", "content": [{ "type": "audio", "data": "%%" }] }] })).is_err());
    }

    #[test]
    fn asks_elevenlabs_with_language_and_speed_only_when_needed() {
        assert_eq!(elevenlabs_body("Hi", 1.0, None), json!({ "text": "Hi", "model_id": ELEVENLABS_MODEL }));
        let body = elevenlabs_body("Hallo", 2.0, Some("de"));
        assert_eq!(body["language_code"], "de");
        assert_eq!(body["voice_settings"]["speed"], 1.2);
    }

    #[test]
    fn reads_both_kinds_of_error() {
        let eleven = r#"{"detail":{"status":"quota_exceeded","message":"You have 3 credits left"}}"#;
        assert_eq!(error_message(reqwest::StatusCode::BAD_REQUEST, eleven), "You have 3 credits left");
        let google = r#"{"error":{"message":"Quota exceeded"}}"#;
        assert_eq!(error_message(reqwest::StatusCode::TOO_MANY_REQUESTS, google), "Rate limited: Quota exceeded");
        // As Gemini really answers a wrong key.
        let listed = r#"[{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]"#;
        assert_eq!(error_message(reqwest::StatusCode::BAD_REQUEST, listed), "API key not valid. Please pass a valid API key.");
        // ElevenLabs answers a wrong key without a body.
        assert_eq!(error_message(reqwest::StatusCode::UNAUTHORIZED, ""), "The API key was rejected");
    }

    #[test]
    fn lists_only_usable_elevenlabs_voices() {
        let reply = json!({ "voices": [{ "voice_id": "abc123", "name": "George" }, { "voice_id": "../x", "name": "Bad" }, { "name": "No id" }] });
        assert_eq!(elevenlabs_voices(&reply), vec![OnlineVoice { id: "abc123".into(), name: "George".into() }]);
    }
}
