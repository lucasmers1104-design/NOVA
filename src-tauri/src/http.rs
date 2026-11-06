//! The single outbound HTTP client. Every network connection NOVA makes goes
//! through here, and only for features the user explicitly configured
//! (AI providers with a key, weather with a location, news feeds they added,
//! NOVA's voice when spoken replies use it, web pages NOVA AI is asked to read).

use std::sync::OnceLock;
use std::time::Duration;

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("NOVA/", env!("CARGO_PKG_VERSION"), " (desktop command center)"))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP client configuration is static and valid")
    })
}

/// For one web page hop NOVA AI reads: follows no redirects by itself, so each
/// hop can be checked first, and connects only to the addresses that were checked
/// (a name can't answer differently the second time it is asked).
pub fn checked_client(host: &str, addresses: &[std::net::SocketAddr]) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("NOVA/", env!("CARGO_PKG_VERSION"), " (desktop command center)"))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addresses)
        .build()
        .map_err(describe)
}

/// Reads a response body up to `limit` bytes.
pub async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(describe)? {
        if body.len() + chunk.len() > limit {
            return Err(format!("Response exceeds {} KB", limit / 1024));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A readable message for transport errors (offline, timeout, TLS).
pub fn describe(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The request timed out".into()
    } else if error.is_connect() {
        "Couldn't connect — check your internet connection".into()
    } else {
        format!("Network error: {error}")
    }
}

/// Extracts `error.message` from the JSON error bodies used by OpenAI, Anthropic and Google.
pub fn api_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
    match (status.as_u16(), detail) {
        (401 | 403, Some(d)) => format!("The API key was rejected: {d}"),
        (401 | 403, None) => "The API key was rejected".into(),
        (429, Some(d)) => format!("Rate limited: {d}"),
        (_, Some(d)) => d,
        (code, None) => format!("Request failed with HTTP {code}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_provider_error_messages() {
        let body = r#"{"error":{"type":"invalid_request_error","message":"model not found"}}"#;
        assert_eq!(api_error_message(reqwest::StatusCode::BAD_REQUEST, body), "model not found");
        assert!(api_error_message(reqwest::StatusCode::UNAUTHORIZED, "{}").contains("rejected"));
        assert_eq!(api_error_message(reqwest::StatusCode::BAD_GATEWAY, "<html>"), "Request failed with HTTP 502");
    }
}
