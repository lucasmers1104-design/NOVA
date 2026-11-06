//! Provider-independent conversation model for NOVA AI, with request builders
//! and streaming parsers for Anthropic, OpenAI and Google Gemini that support
//! tool calls, images and usage reporting.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::ai::{JsonBody, Provider, SseEvent};

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    /// Only in a `Role::Control` message: the effort from here on (Anthropic).
    Effort(Effort),
    Text(String),
    Image { media_type: String, data: String },
    ToolCall { id: String, name: String, input: Value },
    ToolResult { id: String, name: String, content: String, is_error: bool, image: Option<(String, String)> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    /// An instruction for the provider between turns (an effort change);
    /// only Anthropic understands it, the others skip it.
    Control,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
    /// The provider's own assistant content (thinking blocks, signatures),
    /// echoed back unchanged when the same provider continues the conversation.
    pub native: Option<(Provider, Value)>,
}

impl Message {
    pub fn user(parts: Vec<Part>) -> Self {
        Self { role: Role::User, parts, native: None }
    }
}

pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    #[default]
    Medium,
    High,
}

impl Effort {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

pub struct Request<'a> {
    pub provider: Provider,
    pub key: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub effort: Effort,
}

/// The models Anthropic's `output_config.effort` applies to.
fn anthropic_supports_effort(model: &str) -> bool {
    ["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-sonnet-4-6"]
        .iter()
        .any(|p| model.starts_with(p))
}

/// The models that can search the web on Anthropic's side.
fn anthropic_supports_web_search(model: &str) -> bool {
    anthropic_supports_effort(model) || model.starts_with("claude-haiku-4-5")
}

/// Searches per request; each one costs extra (see `WEB_SEARCH_MICROS`).
const MAX_WEB_SEARCHES: u32 = 3;

/// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
fn anthropic_supports_fallbacks(model: &str) -> bool {
    ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"].contains(&model)
}

pub const ANTHROPIC_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Effort changes inside the conversation (keep the prompt cache).
pub const ANTHROPIC_MESSAGE_EFFORT_BETA: &str = "mid-conversation-output-config-2026-07-01";

/// Models that take an effort change as a message (with adaptive thinking, NOVA's default).
pub fn anthropic_supports_message_effort(model: &str) -> bool {
    ["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"].iter().any(|p| model == *p || model.starts_with(&format!("{p}-")))
}

/// Cache breakpoint: the provider keeps everything up to here for a few minutes.
fn ephemeral() -> Value {
    json!({ "type": "ephemeral" })
}

/// Debug builds only: `NOVA_DEV_ANTHROPIC_URL` points NOVA AI at a local mock
/// server for end-to-end tests without a real key. Release builds ignore it.
pub fn dev_endpoint() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("NOVA_DEV_ANTHROPIC_URL").ok().filter(|u| u.starts_with("http://127.0.0.1:"))
    } else {
        None
    }
}

fn data_url(media_type: &str, data: &str) -> String {
    format!("data:{media_type};base64,{data}")
}

pub fn build(request: &Request<'_>) -> reqwest::RequestBuilder {
    let client = crate::http::client();
    match request.provider {
        Provider::Anthropic => {
            let mut body = anthropic_body(request);
            body["stream"] = json!(true);
            // Tools and system prompt stay cached (explicit breakpoint), and the
            // conversation so far too (automatic breakpoint on the newest block).
            body["cache_control"] = ephemeral();
            let mut betas = anthropic_betas(request);
            if anthropic_supports_fallbacks(request.model) {
                body["fallbacks"] = json!("default");
                betas.push(ANTHROPIC_FALLBACK_BETA);
            }
            anthropic_request(client, request.key, &betas).json_body(&body)
        }
        Provider::Openai => {
            let mut messages = vec![json!({ "role": "system", "content": request.system })];
            messages.extend(openai_messages(request.messages));
            let mut body = json!({
                "model": request.model,
                "messages": messages,
                "stream": true,
                "stream_options": { "include_usage": true },
            });
            if !request.tools.is_empty() {
                body["tools"] = request
                    .tools
                    .iter()
                    .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
                    .collect();
            }
            client.post("https://api.openai.com/v1/chat/completions").bearer_auth(request.key).json_body(&body)
        }
        Provider::Gemini => {
            let model = request.model.strip_prefix("models/").unwrap_or(request.model);
            let mut body = json!({
                "contents": gemini_contents(request.messages),
                "systemInstruction": { "parts": [{ "text": request.system }] },
                "generationConfig": { "maxOutputTokens": 16384 },
            });
            if !request.tools.is_empty() {
                body["tools"] = json!([{ "functionDeclarations": request
                    .tools
                    .iter()
                    .map(|t| {
                        // Gemini rejects an object schema without properties; a tool without arguments has none.
                        if t.schema["properties"].as_object().is_some_and(|p| p.is_empty()) {
                            json!({ "name": t.name, "description": t.description })
                        } else {
                            json!({ "name": t.name, "description": t.description, "parameters": t.schema })
                        }
                    })
                    .collect::<Vec<_>>() }]);
            }
            client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"))
                .header("x-goog-api-key", request.key)
                .json_body(&body)
        }
    }
}

/// The parts every Anthropic request shares, so a prewarm and the real request
/// cache the same prefix byte for byte.
fn anthropic_body(request: &Request<'_>) -> Value {
    let mut body = json!({
        "model": request.model,
        "max_tokens": 32000,
        "system": [{ "type": "text", "text": request.system, "cache_control": ephemeral() }],
        "messages": anthropic_messages(request.messages),
    });
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema, "eager_input_streaming": true }))
            .chain(anthropic_supports_web_search(request.model).then(|| json!({ "type": "web_search_20250305", "name": "web_search", "max_uses": MAX_WEB_SEARCHES })))
            .collect();
    }
    if anthropic_supports_effort(request.model) {
        body["output_config"] = json!({ "effort": request.effort.as_str() });
    }
    body
}

fn anthropic_betas(request: &Request<'_>) -> Vec<&'static str> {
    let mut betas = Vec::new();
    if request.messages.iter().any(|m| m.role == Role::Control) {
        betas.push(ANTHROPIC_MESSAGE_EFFORT_BETA);
    }
    betas
}

fn anthropic_request(client: &reqwest::Client, key: &str, betas: &[&str]) -> reqwest::RequestBuilder {
    let endpoint = dev_endpoint().unwrap_or_else(|| "https://api.anthropic.com/v1/messages".into());
    let mut builder = client.post(endpoint).header("x-api-key", key).header("anthropic-version", "2023-06-01");
    if !betas.is_empty() {
        builder = builder.header("anthropic-beta", betas.join(","));
    }
    builder
}

/// A request that only fills Anthropic's prompt cache (no reply, max_tokens 0),
/// sent while the user is still speaking so the real request starts warm. It
/// marks the system prompt and the newest earlier message; the placeholder
/// question after them is read but never answered.
pub fn build_prewarm(request: &Request<'_>) -> Option<reqwest::RequestBuilder> {
    if request.provider != Provider::Anthropic {
        return None;
    }
    let mut body = anthropic_body(request);
    body["max_tokens"] = json!(0);
    if let Some(messages) = body["messages"].as_array_mut() {
        if let Some(blocks) = messages.last_mut().and_then(|m| m["content"].as_array_mut()) {
            // Thinking blocks can't carry a breakpoint; the newest other block can.
            if let Some(block) = blocks.iter_mut().rev().find(|b| !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking" | "server_tool_use" | "web_search_tool_result"))) {
                block["cache_control"] = ephemeral();
            }
        }
        messages.push(json!({ "role": "user", "content": [{ "type": "text", "text": "." }] }));
    }
    Some(anthropic_request(crate::http::client(), request.key, &anthropic_betas(request)).json_body(&body))
}

/// Usage from a non-streamed Anthropic response (a prewarm).
pub fn anthropic_usage(body: &Value) -> Usage {
    let usage = &body["usage"];
    Usage {
        input: usage["input_tokens"].as_u64().unwrap_or(0),
        output: usage["output_tokens"].as_u64().unwrap_or(0),
        cache_read: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
        cache_write: usage["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        web_searches: 0,
    }
}

fn anthropic_messages(messages: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role {
            Role::Control => {
                for part in &message.parts {
                    if let Part::Effort(effort) = part {
                        out.push(json!({ "role": "system", "content": [], "output_config": { "effort": effort.as_str() } }));
                    }
                }
            }
            Role::Assistant => {
                let content = match &message.native {
                    Some((Provider::Anthropic, native)) => native.clone(),
                    _ => Value::Array(
                        message
                            .parts
                            .iter()
                            .filter_map(|p| match p {
                                Part::Text(t) if !t.is_empty() => Some(json!({ "type": "text", "text": t })),
                                Part::ToolCall { id, name, input } => Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input })),
                                _ => None,
                            })
                            .collect(),
                    ),
                };
                if content.as_array().is_some_and(|a| !a.is_empty()) {
                    out.push(json!({ "role": "assistant", "content": content }));
                }
            }
            Role::User => {
                // Tool results first, as the API requires.
                let mut content: Vec<Value> = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::ToolResult { id, content, is_error, image, .. } => {
                            let mut blocks = vec![json!({ "type": "text", "text": content })];
                            if let Some((media_type, data)) = image {
                                blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }));
                            }
                            Some(json!({ "type": "tool_result", "tool_use_id": id, "content": blocks, "is_error": is_error }))
                        }
                        _ => None,
                    })
                    .collect();
                content.extend(message.parts.iter().filter_map(|p| match p {
                    Part::Image { media_type, data } => Some(json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } })),
                    Part::Text(t) if !t.is_empty() => Some(json!({ "type": "text", "text": t })),
                    _ => None,
                }));
                if !content.is_empty() {
                    out.push(json!({ "role": "user", "content": content }));
                }
            }
        }
    }
    out
}

fn openai_messages(messages: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        match message.role {
            Role::Control => {}
            Role::Assistant => {
                let text: String = message.parts.iter().filter_map(|p| if let Part::Text(t) = p { Some(t.as_str()) } else { None }).collect();
                let calls: Vec<Value> = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::ToolCall { id, name, input } => {
                            Some(json!({ "id": id, "type": "function", "function": { "name": name, "arguments": input.to_string() } }))
                        }
                        _ => None,
                    })
                    .collect();
                let mut m = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) } });
                if !calls.is_empty() {
                    m["tool_calls"] = Value::Array(calls);
                }
                if !m["content"].is_null() || m.get("tool_calls").is_some() {
                    out.push(m);
                }
            }
            Role::User => {
                let mut tool_images = Vec::new();
                for part in &message.parts {
                    if let Part::ToolResult { id, content, image, .. } = part {
                        out.push(json!({ "role": "tool", "tool_call_id": id, "content": content }));
                        if let Some((media_type, data)) = image {
                            tool_images.push(json!({ "type": "image_url", "image_url": { "url": data_url(media_type, data) } }));
                        }
                    }
                }
                let mut content: Vec<Value> = Vec::new();
                if !tool_images.is_empty() {
                    content.push(json!({ "type": "text", "text": "Screenshot returned by the look_at_screen tool:" }));
                    content.extend(tool_images);
                }
                for part in &message.parts {
                    match part {
                        Part::Text(t) if !t.is_empty() => content.push(json!({ "type": "text", "text": t })),
                        Part::Image { media_type, data } => content.push(json!({ "type": "image_url", "image_url": { "url": data_url(media_type, data) } })),
                        _ => {}
                    }
                }
                if !content.is_empty() {
                    out.push(json!({ "role": "user", "content": content }));
                }
            }
        }
    }
    out
}

fn gemini_contents(messages: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let parts: Vec<Value> = match (message.role, &message.native) {
            (Role::Control, _) => continue,
            (Role::Assistant, Some((Provider::Gemini, Value::Array(native)))) => native.clone(),
            (Role::Assistant, _) => message
                .parts
                .iter()
                .filter_map(|p| match p {
                    Part::Text(t) if !t.is_empty() => Some(json!({ "text": t })),
                    Part::ToolCall { name, input, .. } => Some(json!({ "functionCall": { "name": name, "args": input } })),
                    _ => None,
                })
                .collect(),
            (Role::User, _) => {
                let mut parts = Vec::new();
                for part in &message.parts {
                    if let Part::ToolResult { name, content, is_error, .. } = part {
                        parts.push(json!({ "functionResponse": { "name": name, "response": { "content": content, "is_error": is_error } } }));
                    }
                }
                for part in &message.parts {
                    match part {
                        Part::ToolResult { image: Some((media_type, data)), .. } | Part::Image { media_type, data } => {
                            parts.push(json!({ "inlineData": { "mimeType": media_type, "data": data } }));
                        }
                        Part::Text(t) if !t.is_empty() => parts.push(json!({ "text": t })),
                        _ => {}
                    }
                }
                parts
            }
        };
        if !parts.is_empty() {
            out.push(json!({ "role": if message.role == Role::User { "user" } else { "model" }, "parts": parts }));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Streaming responses
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    /// Prompt tokens read fresh (without the cached ones below).
    pub input: u64,
    pub output: u64,
    /// Prompt tokens served from the provider's cache (much cheaper).
    pub cache_read: u64,
    /// Prompt tokens written to the cache (a little dearer).
    pub cache_write: u64,
    /// Web searches the provider ran for this reply.
    pub web_searches: u64,
}

impl Usage {
    /// All prompt tokens, cached or not.
    pub fn prompt(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    EndTurn,
    ToolUse,
    MaxTokens,
    /// The model or a safety system declined; with a category when known.
    Refusal(Option<String>),
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The parsed arguments, or the raw text when it wasn't valid JSON.
    pub input: Result<Value, String>,
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub native: Option<(Provider, Value)>,
    pub stop: Stop,
    pub usage: Usage,
    pub model: Option<String>,
}

impl Turn {
    pub fn message(&self) -> Message {
        let mut parts = Vec::new();
        if !self.text.is_empty() {
            parts.push(Part::Text(self.text.clone()));
        }
        for call in &self.calls {
            parts.push(Part::ToolCall { id: call.id.clone(), name: call.name.clone(), input: call.input.clone().unwrap_or_else(|_| json!({})) });
        }
        Message { role: Role::Assistant, parts, native: self.native.clone() }
    }
}

/// Collects one streamed reply.
pub struct Accumulator {
    provider: Provider,
    text: String,
    stop: Option<Stop>,
    usage: Usage,
    model: Option<String>,
    // Anthropic
    blocks: Vec<Value>,
    partial_json: BTreeMap<usize, String>,
    invalid_inputs: BTreeMap<usize, String>,
    web_search_started: bool,
    // OpenAI: index → (id, name, arguments)
    openai_calls: BTreeMap<u64, (String, String, String)>,
    // Gemini
    gemini_parts: Vec<Value>,
    gemini_calls: Vec<ToolCall>,
}

impl Accumulator {
    pub fn new(provider: Provider) -> Self {
        Self {
            provider,
            text: String::new(),
            stop: None,
            usage: Usage::default(),
            model: None,
            blocks: Vec::new(),
            partial_json: BTreeMap::new(),
            invalid_inputs: BTreeMap::new(),
            web_search_started: false,
            openai_calls: BTreeMap::new(),
            gemini_parts: Vec::new(),
            gemini_calls: Vec::new(),
        }
    }

    /// True once after the provider began a web search, so the panel can say so.
    pub fn take_web_search_started(&mut self) -> bool {
        std::mem::take(&mut self.web_search_started)
    }

    /// Handles one event; returns text to show, or the provider's error.
    pub fn push(&mut self, event: &SseEvent) -> Result<Option<String>, String> {
        if event.data == "[DONE]" {
            return Ok(None);
        }
        let Ok(value) = serde_json::from_str::<Value>(&event.data) else { return Ok(None) };
        if let Some(message) = value["error"]["message"].as_str() {
            return Err(message.to_string());
        }
        let shown = match self.provider {
            Provider::Anthropic => self.anthropic(&value),
            Provider::Openai => self.openai(&value),
            Provider::Gemini => self.gemini(&value)?,
        };
        if let Some(text) = &shown {
            self.text.push_str(text);
        }
        Ok(shown)
    }

    fn anthropic(&mut self, value: &Value) -> Option<String> {
        match value["type"].as_str()? {
            "message_start" => {
                let usage = &value["message"]["usage"];
                self.usage.input = usage["input_tokens"].as_u64().unwrap_or(0);
                self.usage.cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
                self.usage.cache_write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                self.model = value["message"]["model"].as_str().map(str::to_string);
                None
            }
            "content_block_start" => {
                let index = value["index"].as_u64()? as usize;
                if self.blocks.len() <= index {
                    self.blocks.resize(index + 1, Value::Null);
                }
                self.blocks[index] = value["content_block"].clone();
                // The input of a server tool goes back in the conversation like any other.
                if matches!(self.blocks[index]["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                    self.partial_json.insert(index, String::new());
                }
                if self.blocks[index]["type"] == "server_tool_use" {
                    self.web_search_started = true;
                }
                None
            }
            "content_block_delta" => {
                let index = value["index"].as_u64()? as usize;
                let delta = &value["delta"];
                let block = self.blocks.get_mut(index)?;
                match delta["type"].as_str()? {
                    "text_delta" => {
                        let text = delta["text"].as_str()?.to_string();
                        let joined = format!("{}{}", block["text"].as_str().unwrap_or(""), text);
                        block["text"] = Value::String(joined);
                        return Some(text);
                    }
                    "thinking_delta" => {
                        let joined = format!("{}{}", block["thinking"].as_str().unwrap_or(""), delta["thinking"].as_str().unwrap_or(""));
                        block["thinking"] = Value::String(joined);
                    }
                    "signature_delta" => block["signature"] = delta["signature"].clone(),
                    "citations_delta" => match block["citations"].as_array_mut() {
                        Some(citations) => citations.push(delta["citation"].clone()),
                        None => block["citations"] = json!([delta["citation"]]),
                    },
                    "input_json_delta" => {
                        if let Some(partial) = self.partial_json.get_mut(&index) {
                            partial.push_str(delta["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    _ => {}
                }
                None
            }
            "content_block_stop" => {
                let index = value["index"].as_u64()? as usize;
                if let Some(raw) = self.partial_json.remove(&index) {
                    // Eager input streaming: the API doesn't validate the JSON, so parse strictly.
                    let parsed = if raw.trim().is_empty() { Ok(json!({})) } else { serde_json::from_str::<Value>(&raw) };
                    match parsed {
                        Ok(input) if input.is_object() => self.blocks[index]["input"] = input,
                        _ => {
                            self.blocks[index]["input"] = json!({});
                            self.invalid_inputs.insert(index, raw);
                        }
                    }
                }
                None
            }
            "message_delta" => {
                if let Some(output) = value["usage"]["output_tokens"].as_u64() {
                    self.usage.output = output;
                }
                if let Some(input) = value["usage"]["input_tokens"].as_u64() {
                    self.usage.input = self.usage.input.max(input);
                }
                if let Some(read) = value["usage"]["cache_read_input_tokens"].as_u64() {
                    self.usage.cache_read = self.usage.cache_read.max(read);
                }
                if let Some(write) = value["usage"]["cache_creation_input_tokens"].as_u64() {
                    self.usage.cache_write = self.usage.cache_write.max(write);
                }
                if let Some(searches) = value["usage"]["server_tool_use"]["web_search_requests"].as_u64() {
                    self.usage.web_searches = self.usage.web_searches.max(searches);
                }
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.stop = Some(match reason {
                        "end_turn" | "stop_sequence" => Stop::EndTurn,
                        "tool_use" => Stop::ToolUse,
                        "max_tokens" => Stop::MaxTokens,
                        "refusal" => Stop::Refusal(value["delta"]["stop_details"]["category"].as_str().map(str::to_string)),
                        other => Stop::Other(other.to_string()),
                    });
                }
                None
            }
            _ => None,
        }
    }

    fn openai(&mut self, value: &Value) -> Option<String> {
        if let Some(model) = value["model"].as_str() {
            self.model = Some(model.to_string());
        }
        if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
            self.usage = Usage { input: usage["prompt_tokens"].as_u64().unwrap_or(0), output: usage["completion_tokens"].as_u64().unwrap_or(0), ..Usage::default() };
        }
        let choice = &value["choices"][0];
        if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_u64().unwrap_or(0);
                let entry = self.openai_calls.entry(index).or_default();
                if let Some(id) = call["id"].as_str() {
                    entry.0 = id.to_string();
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    entry.1.push_str(name);
                }
                if let Some(arguments) = call["function"]["arguments"].as_str() {
                    entry.2.push_str(arguments);
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop = Some(match reason {
                "stop" => Stop::EndTurn,
                "tool_calls" | "function_call" => Stop::ToolUse,
                "length" => Stop::MaxTokens,
                "content_filter" => Stop::Refusal(Some("content_filter".into())),
                other => Stop::Other(other.to_string()),
            });
        }
        choice["delta"]["content"].as_str().filter(|t| !t.is_empty()).map(str::to_string)
    }

    fn gemini(&mut self, value: &Value) -> Result<Option<String>, String> {
        if let Some(reason) = value["promptFeedback"]["blockReason"].as_str() {
            return Err(format!("Gemini blocked this request ({reason})"));
        }
        if let Some(model) = value["modelVersion"].as_str() {
            self.model = Some(model.to_string());
        }
        let usage = &value["usageMetadata"];
        if usage.is_object() {
            self.usage = Usage {
                input: usage["promptTokenCount"].as_u64().unwrap_or(0),
                output: usage["candidatesTokenCount"].as_u64().unwrap_or(0) + usage["thoughtsTokenCount"].as_u64().unwrap_or(0),
                ..Usage::default()
            };
        }
        let candidate = &value["candidates"][0];
        let mut shown = String::new();
        for part in candidate["content"]["parts"].as_array().into_iter().flatten() {
            self.gemini_parts.push(part.clone());
            if let Some(call) = part.get("functionCall") {
                // Gemini often sends no id; ours must stay unique across replies, because tool cards are found by id.
                static NEXT_CALL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
                let id = call["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("gemini-call-{}", NEXT_CALL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
                let input = call.get("args").cloned().unwrap_or_else(|| json!({}));
                self.gemini_calls.push(ToolCall { id, name: call["name"].as_str().unwrap_or_default().to_string(), input: Ok(input) });
            } else if part["thought"] != true {
                if let Some(text) = part["text"].as_str() {
                    shown.push_str(text);
                }
            }
        }
        if let Some(reason) = candidate["finishReason"].as_str() {
            self.stop = Some(match reason {
                "STOP" => Stop::EndTurn,
                "MAX_TOKENS" => Stop::MaxTokens,
                "SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "RECITATION" => Stop::Refusal(Some(reason.to_lowercase())),
                other => Stop::Other(other.to_string()),
            });
        }
        Ok((!shown.is_empty()).then_some(shown))
    }

    pub fn finish(mut self) -> Turn {
        let (calls, native) = match self.provider {
            Provider::Anthropic => {
                // After a mid-reply fallback, drop what the declined attempt left
                // before the last `fallback` marker except its text (API rule).
                if let Some(last) = self.blocks.iter().rposition(|b| b["type"] == "fallback") {
                    let mut index = 0;
                    self.blocks.retain(|b| {
                        let keep = index >= last || matches!(b["type"].as_str(), Some("text") | Some("fallback"));
                        index += 1;
                        keep
                    });
                    self.invalid_inputs.clear();
                }
                let calls = self
                    .blocks
                    .iter()
                    .enumerate()
                    .filter(|(_, b)| b["type"] == "tool_use")
                    .map(|(i, b)| ToolCall {
                        id: b["id"].as_str().unwrap_or_default().to_string(),
                        name: b["name"].as_str().unwrap_or_default().to_string(),
                        input: match self.invalid_inputs.get(&i) {
                            Some(raw) => Err(raw.clone()),
                            None => Ok(b["input"].clone()),
                        },
                    })
                    .collect();
                let mut blocks: Vec<Value> = self.blocks.into_iter().filter(|b| !b.is_null()).collect();
                // Text blocks start with `citations: null`, which the API doesn't take back.
                for block in &mut blocks {
                    if block["citations"].is_null() {
                        if let Some(fields) = block.as_object_mut() {
                            fields.remove("citations");
                        }
                    }
                }
                (calls, Some((Provider::Anthropic, Value::Array(blocks))))
            }
            Provider::Openai => {
                let calls = self
                    .openai_calls
                    .into_values()
                    .map(|(id, name, arguments)| ToolCall {
                        id,
                        name,
                        input: if arguments.trim().is_empty() {
                            Ok(json!({}))
                        } else {
                            serde_json::from_str::<Value>(&arguments).ok().filter(Value::is_object).ok_or(arguments)
                        },
                    })
                    .collect();
                (calls, None)
            }
            Provider::Gemini => (self.gemini_calls, Some((Provider::Gemini, Value::Array(self.gemini_parts)))),
        };
        let stop = match self.stop {
            Some(Stop::EndTurn) | None if !calls.is_empty() => Stop::ToolUse,
            Some(stop) => stop,
            None => Stop::EndTurn,
        };
        Turn { text: self.text, calls, native, stop, usage: self.usage, model: self.model }
    }
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/// US dollars per million input / output / cache-read tokens, from
/// Anthropic's published prices (as of 2026-10-06; cache writes cost 1.25x
/// input). Other providers' prices change too often to hard-code, so NOVA
/// shows their token counts without a cost estimate.
const ANTHROPIC_PRICES: &[(&str, f64, f64, f64)] = &[
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4-8", 5.0, 25.0, 0.50),
    ("claude-opus-4-7", 5.0, 25.0, 0.50),
    ("claude-opus-4-6", 5.0, 25.0, 0.50),
    ("claude-sonnet-5-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4-6", 3.0, 15.0, 0.30),
    ("claude-haiku-5-5", 0.10, 0.50, 0.01),
    ("claude-haiku-4-5", 1.0, 5.0, 0.10),
];
/// Writing a prompt to the cache (5-minute lifetime) costs this much more than reading it fresh.
const CACHE_WRITE_FACTOR: f64 = 1.25;
/// One web search on Anthropic's side: $10 per 1,000, on top of the tokens.
const WEB_SEARCH_MICROS: f64 = 10_000.0;

/// Estimated cost in millionths of a US dollar, when NOVA knows the model's price.
pub fn estimate_cost_micros(provider: Provider, model: &str, usage: Usage) -> Option<i64> {
    if provider != Provider::Anthropic {
        return None;
    }
    // Exact id, or a dated snapshot of it (claude-haiku-4-5-20251001).
    let (_, mut input, mut output, mut read) = *ANTHROPIC_PRICES
        .iter()
        .find(|(id, ..)| model == *id || model.strip_prefix(id).is_some_and(|rest| rest.starts_with("-20")))?;
    if model.starts_with("claude-haiku-5-5") && usage.prompt() > 100_000 {
        // Long prompts on Haiku 5.5 are billed at a higher rate.
        (input, output, read) = (0.50, 2.50, 0.05);
    }
    // $ per million tokens = micro-dollars per token.
    let cost = usage.input as f64 * input + usage.cache_write as f64 * input * CACHE_WRITE_FACTOR + usage.cache_read as f64 * read + usage.output as f64 * output + usage.web_searches as f64 * WEB_SEARCH_MICROS;
    Some(cost.round() as i64)
}

pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(provider: Provider, events: &[&str]) -> (Vec<String>, Turn) {
        let mut acc = Accumulator::new(provider);
        let mut shown = Vec::new();
        for data in events {
            if let Some(text) = acc.push(&SseEvent { event: None, data: data.to_string() }).unwrap() {
                shown.push(text);
            }
        }
        (shown, acc.finish())
    }

    #[test]
    fn parses_anthropic_text_thinking_and_tool_use() {
        let (shown, turn) = feed(
            Provider::Anthropic,
            &[
                r#"{"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":120,"cache_read_input_tokens":30}}}"#,
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig=="}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Ich suche "}}"#,
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"danach."}}"#,
                r#"{"type":"content_block_stop","index":1}"#,
                r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"search_files","input":{}}}"#,
                r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"text\": \"le"}}"#,
                r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"go\"}"}}"#,
                r#"{"type":"content_block_stop","index":2}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
                r#"{"type":"message_stop"}"#,
            ],
        );
        assert_eq!(shown, ["Ich suche ", "danach."]);
        assert_eq!(turn.text, "Ich suche danach.");
        assert_eq!(turn.stop, Stop::ToolUse);
        assert_eq!(turn.usage, Usage { input: 120, output: 42, cache_read: 30, ..Usage::default() });
        assert_eq!(turn.usage.prompt(), 150);
        assert_eq!(turn.calls, vec![ToolCall { id: "toolu_1".into(), name: "search_files".into(), input: Ok(json!({ "text": "lego" })) }]);
        let native = &turn.native.as_ref().unwrap().1;
        assert_eq!(native[0]["signature"], "sig==", "thinking blocks are kept for replay");
        assert_eq!(native[2]["input"], json!({ "text": "lego" }));
    }

    #[test]
    fn flags_invalid_tool_json_and_refusals() {
        let (_, turn) = feed(
            Provider::Anthropic,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"open_file","input":{}}}"#,
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\": \"C:\\x"}}"#,
                r#"{"type":"content_block_stop","index":0}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}"#,
            ],
        );
        assert!(turn.calls[0].input.is_err());
        assert_eq!(turn.stop, Stop::MaxTokens);
        let (_, refused) = feed(
            Provider::Anthropic,
            &[r#"{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}},"usage":{"output_tokens":0}}"#],
        );
        assert_eq!(refused.stop, Stop::Refusal(Some("cyber".into())));
    }

    #[test]
    fn drops_declined_blocks_before_a_fallback_marker() {
        let (_, turn) = feed(
            Provider::Anthropic,
            &[
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"Teil"}}"#,
                r#"{"type":"content_block_start","index":2,"content_block":{"type":"fallback","model":"claude-opus-4-8"}}"#,
                r#"{"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}"#,
                r#"{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":" Rest"}}"#,
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
            ],
        );
        let types: Vec<&str> = turn.native.as_ref().unwrap().1.as_array().unwrap().iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["text", "fallback", "text"]);
    }

    #[test]
    fn parses_openai_tool_calls_across_chunks() {
        let (shown, turn) = feed(
            Provider::Openai,
            &[
                r#"{"model":"gpt-x","choices":[{"delta":{"role":"assistant","content":"Okay. "}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open_app","arguments":"{\"na"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"me\":\"Spotify\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":12}}"#,
                "[DONE]",
            ],
        );
        assert_eq!(shown, ["Okay. "]);
        assert_eq!(turn.stop, Stop::ToolUse);
        assert_eq!(turn.usage, Usage { input: 80, output: 12, ..Usage::default() });
        assert_eq!(turn.calls[0].input, Ok(json!({ "name": "Spotify" })));
        assert_eq!(turn.model.as_deref(), Some("gpt-x"));
    }

    #[test]
    fn parses_gemini_function_calls_and_keeps_raw_parts() {
        let (shown, turn) = feed(
            Provider::Gemini,
            &[
                r#"{"candidates":[{"content":{"parts":[{"text":"Moment."}],"role":"model"}}]}"#,
                r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"search_files","args":{"text":"drucker"}},"thoughtSignature":"abc"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":7,"thoughtsTokenCount":3}}"#,
            ],
        );
        assert_eq!(shown, ["Moment."]);
        assert_eq!(turn.stop, Stop::ToolUse, "a function call means tool use even with STOP");
        assert_eq!(turn.usage, Usage { input: 50, output: 10, ..Usage::default() });
        assert_eq!(turn.native.as_ref().unwrap().1[1]["thoughtSignature"], "abc");
    }

    fn sample_history() -> Vec<Message> {
        vec![
            Message::user(vec![Part::Image { media_type: "image/png".into(), data: "AAAA".into() }, Part::Text("Was siehst du?".into())]),
            Message {
                role: Role::Assistant,
                parts: vec![Part::Text("Ich schaue.".into()), Part::ToolCall { id: "c1".into(), name: "search_files".into(), input: json!({ "text": "x" }) }],
                native: None,
            },
            Message::user(vec![Part::ToolResult { id: "c1".into(), name: "search_files".into(), content: "2 files".into(), is_error: false, image: None }]),
        ]
    }

    #[test]
    fn builds_requests_for_every_provider_without_keys_in_urls() {
        let tools = [ToolSpec { name: "search_files", description: "Search", schema: json!({ "type": "object", "properties": {} }) }];
        let history = sample_history();
        for provider in Provider::ALL {
            let request = build(&Request { provider, key: "secret-key-1", model: "claude-opus-5-5", system: "Be NOVA", messages: &history, tools: &tools, effort: Effort::Low })
                .build()
                .unwrap();
            assert!(!request.url().as_str().contains("secret-key-1"));
            let body: Value = serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
            let text = body.to_string();
            assert!(text.contains("Be NOVA") && text.contains("search_files") && text.contains("AAAA"), "{provider:?}: {text}");
            match provider {
                Provider::Anthropic => {
                    assert_eq!(body["output_config"]["effort"], "low");
                    assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral", "tools and system prompt are cached");
                    assert_eq!(body["cache_control"]["type"], "ephemeral", "and the conversation so far");
                    assert_eq!(body["fallbacks"], "default");
                    assert_eq!(request.headers()["anthropic-beta"], ANTHROPIC_FALLBACK_BETA);
                    assert_eq!(body["tools"][0]["eager_input_streaming"], true);
                    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
                }
                Provider::Openai => {
                    assert_eq!(body["messages"][3]["role"], "tool");
                    assert_eq!(body["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"text\":\"x\"}");
                }
                Provider::Gemini => {
                    assert_eq!(body["contents"][1]["parts"][1]["functionCall"]["name"], "search_files");
                    assert_eq!(body["contents"][2]["parts"][0]["functionResponse"]["name"], "search_files");
                }
            }
        }
    }

    #[test]
    fn prewarm_marks_the_shared_prefix_and_asks_for_nothing() {
        let tools = [ToolSpec { name: "search_files", description: "Search", schema: json!({ "type": "object", "properties": {} }) }];
        let mut history = sample_history();
        history.push(Message { role: Role::Assistant, parts: vec![Part::Text("Zwei Dateien.".into())], native: None });
        let request = Request { provider: Provider::Anthropic, key: "k", model: "claude-haiku-5-5", system: "Be NOVA", messages: &history, tools: &tools, effort: Effort::Medium };
        let prewarm = build_prewarm(&request).unwrap().build().unwrap();
        let body: Value = serde_json::from_slice(prewarm.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["max_tokens"], 0);
        assert!(body.get("stream").is_none() && body.get("cache_control").is_none() && body.get("fallbacks").is_none());
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[messages.len() - 2]["content"][0]["cache_control"]["type"], "ephemeral", "the newest real message is marked");
        assert_eq!(messages.last().unwrap()["content"][0]["text"], ".");
        // The real request shares tools and system byte for byte.
        let real = build(&request).build().unwrap();
        let real: Value = serde_json::from_slice(real.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(real["tools"], body["tools"]);
        assert_eq!(real["system"], body["system"]);
        assert!(build_prewarm(&Request { provider: Provider::Openai, ..request }).is_none());
    }

    #[test]
    fn effort_changes_become_system_messages_for_anthropic_only() {
        let history = vec![
            Message::user(vec![Part::Text("a".into())]),
            Message { role: Role::Assistant, parts: vec![Part::Text("b".into())], native: None },
            Message { role: Role::Control, parts: vec![Part::Effort(Effort::Low)], native: None },
            Message::user(vec![Part::Text("c".into())]),
        ];
        let body_of = |provider| {
            let request = build(&Request { provider, key: "k", model: "claude-haiku-5-5", system: "s", messages: &history, tools: &[], effort: Effort::Medium }).build().unwrap();
            let beta = request.headers().get("anthropic-beta").map(|h| h.to_str().unwrap().to_string());
            (serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(), beta)
        };
        let (anthropic, beta) = body_of(Provider::Anthropic);
        assert_eq!(anthropic["messages"][2], json!({ "role": "system", "content": [], "output_config": { "effort": "low" } }));
        assert_eq!(beta.as_deref(), Some(ANTHROPIC_MESSAGE_EFFORT_BETA));
        assert_eq!(body_of(Provider::Openai).0["messages"].as_array().unwrap().len(), 4, "system prompt + 3 turns");
        assert_eq!(body_of(Provider::Gemini).0["contents"].as_array().unwrap().len(), 3);
        assert!(anthropic_supports_message_effort("claude-haiku-5-5") && !anthropic_supports_message_effort("claude-haiku-4-5"));
    }

    #[test]
    fn older_anthropic_models_get_no_effort_or_fallbacks() {
        let request = build(&Request { provider: Provider::Anthropic, key: "k", model: "claude-haiku-4-5", system: "s", messages: &[], tools: &[], effort: Effort::High })
            .build()
            .unwrap();
        let body: Value = serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert!(body.get("output_config").is_none() && body.get("fallbacks").is_none() && body.get("tools").is_none());
        assert!(request.headers().get("anthropic-beta").is_none());
    }

    #[test]
    fn keeps_web_searches_for_the_next_request() {
        let mut acc = Accumulator::new(Provider::Anthropic);
        for data in [
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"KFC\"}"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://kfc.de","title":"KFC","encrypted_content":"abc"}]}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"text","text":"","citations":null}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Plain"}}"#,
            r#"{"type":"content_block_stop","index":2}"#,
            r#"{"type":"content_block_start","index":3,"content_block":{"type":"text","text":"","citations":null}}"#,
            r#"{"type":"content_block_delta","index":3,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://kfc.de"}}}"#,
            r#"{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":" cited"}}"#,
            r#"{"type":"content_block_stop","index":3}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":1}}}"#,
        ] {
            acc.push(&SseEvent { event: None, data: data.into() }).unwrap();
        }
        assert!(acc.take_web_search_started());
        assert!(!acc.take_web_search_started());
        let turn = acc.finish();
        assert_eq!(turn.text, "Plain cited");
        assert!(turn.calls.is_empty(), "the provider ran the search, not NOVA");
        assert_eq!(turn.stop, Stop::EndTurn);
        assert_eq!(turn.usage.web_searches, 1);
        let (_, native) = turn.native.unwrap();
        assert_eq!(native[0]["input"]["query"], "KFC");
        assert_eq!(native[1]["content"][0]["encrypted_content"], "abc");
        assert!(native[2].get("citations").is_none());
        assert_eq!(native[3]["citations"][0]["url"], "https://kfc.de");
    }

    #[test]
    fn offers_web_search_only_on_anthropic_models_that_have_it() {
        let tools = [ToolSpec { name: "t", description: "d", schema: json!({ "type": "object" }) }];
        let body = |model: &str| anthropic_body(&Request { provider: Provider::Anthropic, key: "k", model, system: "s", messages: &[], tools: &tools, effort: Effort::Medium });
        assert_eq!(body("claude-haiku-5-5")["tools"][1]["type"], "web_search_20250305");
        assert!(body("claude-3-haiku")["tools"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn estimates_costs_only_for_known_prices() {
        let usage = Usage { input: 1_000_000, output: 100_000, ..Usage::default() };
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-opus-5-5", usage), Some(6_000_000));
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-opus-5", usage), Some(7_500_000));
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-haiku-4-5-20251001", usage), Some(1_500_000));
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-haiku-5-5", Usage { input: 200_000, ..Usage::default() }), Some(100_000));
        // Cached prompt tokens: reads at a tenth, writes at 1.25x.
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-haiku-5-5", Usage { web_searches: 2, ..Usage::default() }), Some(20_000));
        let cached = Usage { input: 100, output: 50, cache_read: 10_000, cache_write: 2_000, ..Usage::default() };
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-haiku-5-5", cached), Some((100.0 * 0.1 + 2_000.0 * 0.125 + 10_000.0 * 0.01 + 50.0 * 0.5_f64).round() as i64));
        assert_eq!(estimate_cost_micros(Provider::Anthropic, "claude-unknown", usage), None);
        assert_eq!(estimate_cost_micros(Provider::Openai, "gpt-x", usage), None);
    }
}
