//! NOVA AI: a common streaming interface over OpenAI, Anthropic and Google Gemini.
//!
//! - API keys live in Windows Credential Manager and never reach the webview.
//! - Only the conversation text the user typed is sent; NOVA never attaches files.
//! - Responses stream to the UI over a Tauri channel and are stored in SQLite.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::credentials;
use crate::http;
use crate::storage::conversations::{self, Message};
use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

const MAX_MESSAGE_CHARS: usize = 100_000;
const MAX_KEY_LEN: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Openai, Provider::Anthropic, Provider::Gemini];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Provider::Openai => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Provider::Openai => "OpenAI",
            Provider::Anthropic => "Anthropic",
            Provider::Gemini => "Google Gemini",
        }
    }

    fn credential_target(self) -> String {
        format!("NOVA:ai:{}", self.id())
    }

    pub(crate) fn api_key(self) -> CommandResult<String> {
        credentials::get(&self.credential_target())?
            .ok_or_else(|| format!("Add your {} API key in Settings → AI providers first.", self.label()))
    }
}

pub fn is_valid_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 120
        && model.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'/'))
        && !model.contains("..")
}

// --- Server-sent events --------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE parser that is safe across arbitrary chunk boundaries,
/// including multi-byte UTF-8 characters split between chunks.
#[derive(Default)]
pub struct SseParser {
    pending_bytes: Vec<u8>,
    buffer: String,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.pending_bytes.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending_bytes) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        let text = String::from_utf8_lossy(&self.pending_bytes[..valid]).into_owned();
        self.pending_bytes.drain(..valid);
        self.buffer.push_str(&text);

        let mut events = Vec::new();
        while let Some(newline) = self.buffer.find('\n') {
            let line = self.buffer[..newline].trim_end_matches('\r').to_string();
            self.buffer.drain(..=newline);
            self.line(&line, &mut events);
        }
        events
    }

    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        let rest = std::mem::take(&mut self.buffer);
        if !rest.is_empty() {
            self.line(rest.trim_end_matches('\r'), &mut events);
        }
        self.line("", &mut events);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push(SseEvent { event: self.event.take(), data: self.data.join("\n") });
                self.data.clear();
            }
            self.event = None;
        } else if let Some(value) = line.strip_prefix("data:") {
            self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        } else if let Some(value) = line.strip_prefix("event:") {
            self.event = Some(value.trim().to_string());
        }
        // `id:`, `retry:` and `:comment` lines carry nothing NOVA needs.
    }
}

/// Text added by one streamed event; `Err` when the provider reports an error mid-stream.
pub fn extract_delta(provider: Provider, event: &SseEvent) -> Result<Option<String>, String> {
    if event.data == "[DONE]" {
        return Ok(None);
    }
    let Ok(value) = serde_json::from_str::<Value>(&event.data) else { return Ok(None) };
    if let Some(message) = value["error"]["message"].as_str() {
        return Err(message.to_string());
    }
    Ok(match provider {
        Provider::Openai => value["choices"][0]["delta"]["content"].as_str().map(str::to_string),
        Provider::Anthropic => match value["type"].as_str() {
            Some("content_block_delta") if value["delta"]["type"] == "text_delta" => value["delta"]["text"].as_str().map(str::to_string),
            _ => None,
        },
        Provider::Gemini => {
            if let Some(reason) = value["promptFeedback"]["blockReason"].as_str() {
                return Err(format!("Gemini blocked this request ({reason})"));
            }
            let parts = value["candidates"][0]["content"]["parts"].as_array();
            let text: String = parts.into_iter().flatten().filter_map(|p| p["text"].as_str()).collect();
            (!text.is_empty()).then_some(text)
        }
    })
}

// --- Requests ---------------------------------------------------------------------

struct Turn<'a> {
    role: &'a str,
    content: &'a str,
}

fn build_request(
    provider: Provider,
    key: &str,
    model: &str,
    turns: &[Turn<'_>],
    system: Option<&str>,
    temperature: Option<f32>,
    max_tokens: u32,
) -> reqwest::RequestBuilder {
    let client = http::client();
    match provider {
        Provider::Openai => {
            let mut messages: Vec<Value> = Vec::new();
            if let Some(system) = system {
                messages.push(json!({ "role": "system", "content": system }));
            }
            messages.extend(turns.iter().map(|t| json!({ "role": t.role, "content": t.content })));
            let mut body = json!({ "model": model, "messages": messages, "stream": true });
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            client.post("https://api.openai.com/v1/chat/completions").bearer_auth(key).json_body(&body)
        }
        Provider::Anthropic => {
            let messages: Vec<Value> = turns.iter().map(|t| json!({ "role": t.role, "content": t.content })).collect();
            let mut body = json!({ "model": model, "max_tokens": max_tokens, "messages": messages, "stream": true });
            if let Some(system) = system {
                body["system"] = json!(system);
            }
            if let Some(t) = temperature {
                body["temperature"] = json!(t);
            }
            client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json_body(&body)
        }
        Provider::Gemini => {
            let model = model.strip_prefix("models/").unwrap_or(model);
            let contents: Vec<Value> = turns
                .iter()
                .map(|t| json!({ "role": if t.role == "assistant" { "model" } else { "user" }, "parts": [{ "text": t.content }] }))
                .collect();
            let mut body = json!({ "contents": contents, "generationConfig": { "maxOutputTokens": max_tokens } });
            if let Some(system) = system {
                body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            }
            if let Some(t) = temperature {
                body["generationConfig"]["temperature"] = json!(t);
            }
            client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"))
                .header("x-goog-api-key", key)
                .json_body(&body)
        }
    }
}

/// `serde_json` body without enabling reqwest's `json` feature.
pub(crate) trait JsonBody {
    fn json_body(self, body: &Value) -> Self;
}

impl JsonBody for reqwest::RequestBuilder {
    fn json_body(self, body: &Value) -> Self {
        self.header("content-type", "application/json").body(body.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
    name: String,
}

const NON_CHAT_MODELS: &[&str] = &[
    "embedding", "tts", "whisper", "dall-e", "moderation", "image", "audio", "realtime", "transcribe", "search", "babbage", "davinci",
];

pub fn parse_models(provider: Provider, body: &Value) -> Vec<ModelInfo> {
    let mut models: Vec<ModelInfo> = match provider {
        Provider::Openai => body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["id"].as_str())
            .filter(|id| !NON_CHAT_MODELS.iter().any(|n| id.contains(n)))
            .map(|id| ModelInfo { id: id.into(), name: id.into() })
            .collect(),
        Provider::Anthropic => body["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                Some(ModelInfo { id: id.into(), name: m["display_name"].as_str().unwrap_or(id).into() })
            })
            .collect(),
        Provider::Gemini => body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["supportedGenerationMethods"].as_array().is_some_and(|a| a.iter().any(|x| x == "generateContent")))
            .filter_map(|m| {
                let id = m["name"].as_str()?.strip_prefix("models/")?;
                Some(ModelInfo { id: id.into(), name: m["displayName"].as_str().unwrap_or(id).into() })
            })
            .collect(),
    };
    if provider == Provider::Openai {
        models.sort_by(|a, b| b.id.cmp(&a.id));
    }
    models
}

// --- Commands -----------------------------------------------------------------

#[derive(Default)]
pub struct ChatRequests(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    openai: bool,
    anthropic: bool,
    gemini: bool,
}

#[tauri::command]
pub async fn ai_key_status() -> CommandResult<KeyStatus> {
    let has = |p: Provider| credentials::get(&p.credential_target()).map(|k| k.is_some());
    Ok(KeyStatus { openai: has(Provider::Openai)?, anthropic: has(Provider::Anthropic)?, gemini: has(Provider::Gemini)? })
}

#[tauri::command]
pub async fn ai_key_set(provider: Provider, key: String) -> CommandResult<()> {
    let key = key.trim();
    if key.len() < 10 || key.len() > MAX_KEY_LEN || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("That doesn't look like a valid API key".into());
    }
    credentials::set(&provider.credential_target(), key)
}

#[tauri::command]
pub async fn ai_key_delete(provider: Provider) -> CommandResult<()> {
    credentials::delete(&provider.credential_target())
}

/// Lists models available to the user's key, straight from the provider.
#[tauri::command]
pub async fn ai_models(provider: Provider) -> CommandResult<Vec<ModelInfo>> {
    let key = provider.api_key()?;
    let client = http::client();
    let request = match provider {
        Provider::Openai => client.get("https://api.openai.com/v1/models").bearer_auth(&key),
        Provider::Anthropic => client
            .get("https://api.anthropic.com/v1/models?limit=100")
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01"),
        Provider::Gemini => client.get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200").header("x-goog-api-key", &key),
    };
    let response = request.timeout(Duration::from_secs(20)).send().await.map_err(http::describe)?;
    let status = response.status();
    let body = String::from_utf8_lossy(&http::read_limited(response, 4 * 1024 * 1024).await?).into_owned();
    if !status.is_success() {
        return Err(http::api_error_message(status, &body));
    }
    let value: Value = serde_json::from_str(&body).map_err(|_| "Unexpected response from the provider".to_string())?;
    Ok(parse_models(provider, &value))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    request_id: String,
    conversation_id: Option<String>,
    provider: Provider,
    model: String,
    message: String,
    system_prompt: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    Started { conversation_id: String, user_message: Message },
    Delta { text: String },
    Done { message: Message },
    Failed { error: String, message: Option<Message> },
}

#[tauri::command]
pub async fn ai_chat(
    db: tauri::State<'_, Database>,
    requests: tauri::State<'_, ChatRequests>,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> CommandResult<()> {
    if !is_valid_model_id(&request.model) {
        return Err("Choose a valid model".into());
    }
    let text = request.message.trim();
    if text.is_empty() || text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("Messages must be 1–{MAX_MESSAGE_CHARS} characters"));
    }
    let key = request.provider.api_key()?;
    let provider = request.provider;

    let conversation = match &request.conversation_id {
        Some(id) => {
            let existing = db.with(|c| conversations::get(c, id))?;
            db.with(|c| conversations::update_model(c, &existing.id, provider.id(), &request.model))?;
            existing
        }
        None => {
            let title: String = text.lines().next().unwrap_or("New chat").chars().take(60).collect();
            db.with(|c| conversations::create(c, &title, provider.id(), &request.model))?
        }
    };
    let user_message = db.with(|c| conversations::add_message(c, &conversation.id, "user", text, None))?;
    let history = db.with(|c| conversations::messages(c, &conversation.id))?;
    let _ = on_event.send(ChatEvent::Started { conversation_id: conversation.id.clone(), user_message });

    let cancelled = Arc::new(AtomicBool::new(false));
    requests.0.lock().map_err(|_| "lock poisoned")?.insert(request.request_id.clone(), cancelled.clone());

    let turns: Vec<Turn<'_>> = history
        .iter()
        .filter(|m| m.error.is_none() || !m.content.is_empty())
        .map(|m| Turn { role: m.role.as_str(), content: m.content.as_str() })
        .collect();
    let outcome = stream_reply(
        build_request(
            provider,
            &key,
            &request.model,
            &turns,
            request.system_prompt.as_deref().filter(|s| !s.trim().is_empty()),
            request.temperature.map(|t| t.clamp(0.0, 2.0)),
            // Generous: with thinking on, 4096 tokens cut long answers off mid-sentence.
            request.max_tokens.unwrap_or(16_000).clamp(64, 32_000),
        ),
        provider,
        &on_event,
        &cancelled,
    )
    .await;
    requests.0.lock().map_err(|_| "lock poisoned")?.remove(&request.request_id);

    match outcome {
        Ok(reply) => {
            let message = db.with(|c| conversations::add_message(c, &conversation.id, "assistant", &reply, None))?;
            let _ = on_event.send(ChatEvent::Done { message });
        }
        Err((partial, error)) => {
            let message = (!partial.is_empty())
                .then(|| db.with(|c| conversations::add_message(c, &conversation.id, "assistant", &partial, Some(&error))))
                .transpose()?;
            let _ = on_event.send(ChatEvent::Failed { error, message });
        }
    }
    Ok(())
}

/// Streams the reply; on failure returns the partial text and an error message.
async fn stream_reply(
    request: reqwest::RequestBuilder,
    provider: Provider,
    on_event: &Channel<ChatEvent>,
    cancelled: &AtomicBool,
) -> Result<String, (String, String)> {
    let mut reply = String::new();
    let mut response = request
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| (String::new(), http::describe(e)))?;
    let status = response.status();
    if !status.is_success() {
        let body = http::read_limited(response, 256 * 1024).await.unwrap_or_default();
        return Err((String::new(), http::api_error_message(status, &String::from_utf8_lossy(&body))));
    }

    let mut parser = SseParser::default();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err((reply, "Stopped".into()));
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err((reply, http::describe(e))),
        };
        for event in parser.push(&chunk) {
            match extract_delta(provider, &event) {
                Ok(Some(text)) => {
                    reply.push_str(&text);
                    let _ = on_event.send(ChatEvent::Delta { text });
                }
                Ok(None) => {}
                Err(error) => return Err((reply, error)),
            }
        }
    }
    for event in parser.finish() {
        if let Ok(Some(text)) = extract_delta(provider, &event) {
            reply.push_str(&text);
            let _ = on_event.send(ChatEvent::Delta { text });
        }
    }
    if reply.is_empty() {
        return Err((reply, "The model returned an empty response".into()));
    }
    Ok(reply)
}

#[tauri::command]
pub async fn ai_chat_cancel(requests: tauri::State<'_, ChatRequests>, request_id: String) -> CommandResult<()> {
    if let Some(flag) = requests.0.lock().map_err(|_| "lock poisoned")?.get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut parser = SseParser::default();
        let mut out: Vec<SseEvent> = chunks.iter().flat_map(|c| parser.push(c)).collect();
        out.extend(parser.finish());
        out
    }

    #[test]
    fn parses_sse_across_chunk_boundaries() {
        let parsed = events(&[b"event: ping\nda", b"ta: {\"a\":1}\n\ndata: second\r\n", b"\n"]);
        assert_eq!(
            parsed,
            vec![
                SseEvent { event: Some("ping".into()), data: "{\"a\":1}".into() },
                SseEvent { event: None, data: "second".into() }
            ]
        );
    }

    #[test]
    fn keeps_utf8_characters_split_between_chunks() {
        let text = "data: Grüße 👋\n\n".as_bytes();
        let (a, b) = text.split_at(10); // splits inside "ü"
        let parsed = events(&[a, b]);
        assert_eq!(parsed[0].data, "Grüße 👋");
    }

    #[test]
    fn flushes_a_final_event_without_trailing_blank_line() {
        assert_eq!(events(&[b"data: tail"]), vec![SseEvent { event: None, data: "tail".into() }]);
    }

    fn data(json: &str) -> SseEvent {
        SseEvent { event: None, data: json.into() }
    }

    #[test]
    fn extracts_openai_deltas() {
        let e = data(r#"{"choices":[{"delta":{"content":"Hel"}}]}"#);
        assert_eq!(extract_delta(Provider::Openai, &e).unwrap().as_deref(), Some("Hel"));
        assert_eq!(extract_delta(Provider::Openai, &data("[DONE]")).unwrap(), None);
        assert_eq!(extract_delta(Provider::Openai, &data(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#)).unwrap(), None);
    }

    #[test]
    fn extracts_anthropic_deltas_and_errors() {
        let delta = data(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#);
        assert_eq!(extract_delta(Provider::Anthropic, &delta).unwrap().as_deref(), Some("Hi"));
        let ping = data(r#"{"type":"ping"}"#);
        assert_eq!(extract_delta(Provider::Anthropic, &ping).unwrap(), None);
        let error = data(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#);
        assert_eq!(extract_delta(Provider::Anthropic, &error).unwrap_err(), "Overloaded");
    }

    #[test]
    fn extracts_gemini_deltas_and_blocks() {
        let e = data(r#"{"candidates":[{"content":{"parts":[{"text":"A"},{"text":"B"}],"role":"model"}}]}"#);
        assert_eq!(extract_delta(Provider::Gemini, &e).unwrap().as_deref(), Some("AB"));
        let blocked = data(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#);
        assert!(extract_delta(Provider::Gemini, &blocked).unwrap_err().contains("SAFETY"));
    }

    #[test]
    fn validates_model_ids() {
        assert!(is_valid_model_id("claude-sonnet-5-5"));
        assert!(is_valid_model_id("models/gemini-pro"));
        assert!(!is_valid_model_id("../../etc"));
        assert!(!is_valid_model_id("gpt 4"));
        assert!(!is_valid_model_id(""));
    }

    #[test]
    fn parses_model_lists() {
        let openai = json!({ "data": [{ "id": "gpt-x" }, { "id": "text-embedding-3" }, { "id": "o-mini" }] });
        assert_eq!(parse_models(Provider::Openai, &openai).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["o-mini", "gpt-x"]);
        let gemini = json!({ "models": [
            { "name": "models/gemini-a", "displayName": "Gemini A", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/embed", "supportedGenerationMethods": ["embedContent"] }
        ]});
        let parsed = parse_models(Provider::Gemini, &gemini);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "gemini-a");
    }

    #[test]
    fn builds_provider_requests_without_leaking_keys_into_urls() {
        let turns = [Turn { role: "user", content: "hi" }];
        for provider in Provider::ALL {
            let request = build_request(provider, "secret-key-123", "model-1", &turns, Some("be brief"), None, 512).build().unwrap();
            assert!(!request.url().as_str().contains("secret-key-123"), "{provider:?} put the key in the URL");
            let body = String::from_utf8(request.body().unwrap().as_bytes().unwrap().to_vec()).unwrap();
            assert!(body.contains("be brief") && body.contains("hi"));
        }
    }
}
