//! The single outbound HTTP client. Every network connection NOVA makes goes
//! through here, and only for features the user explicitly configured
//! (AI providers with a key, weather with a location, news feeds they added,
//! NOVA's voice when spoken replies use it, web pages NOVA AI is asked to read,
//! a test file when asked how fast the internet is, YouTube's pages when asked to
//! find or watch a video, a song's text when the lyrics are opened).

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

/// Bytes from outside as text: UTF-16 by its mark, UTF-8 (also cut off mid-letter),
/// or else the Latin-1 family that older German pages and Excel's CSV files use.
pub fn decode_text(bytes: &[u8]) -> String {
    let wide = |pair: fn([u8; 2]) -> u16, rest: &[u8]| String::from_utf16_lossy(&rest.as_chunks::<2>().0.iter().map(|units| pair(*units)).collect::<Vec<u16>>());
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return wide(u16::from_le_bytes, rest);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return wide(u16::from_be_bytes, rest);
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(error) if error.error_len().is_none() => String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// A readable message for transport errors (offline, timeout, TLS).
pub fn describe(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The request timed out".into()
    } else if error.is_connect() {
        "Couldn't connect — check your internet connection".into()
    } else {
        // reqwest's own text only says "error sending request"; the reason is further down.
        let mut text = format!("Network error: {error}");
        let mut cause = std::error::Error::source(&error);
        while let Some(reason) = cause {
            text.push_str(&format!(": {reason}"));
            cause = reason.source();
        }
        text
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
    fn reads_text_in_every_encoding_people_have() {
        assert_eq!(decode_text("Größe".as_bytes()), "Größe");
        assert_eq!(decode_text(&[0x47, 0x72, 0xF6, 0xDF, 0x65]), "Größe", "Windows-1252");
        assert_eq!(decode_text(&[0xFF, 0xFE, 0xD6, 0x00, 0x6C, 0x00]), "Öl");
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, 0x4F, 0x4B]), "OK");
        assert_eq!(decode_text(&[0x4F, 0x4B, 0xC3]), "OK", "cut off in the middle of ö");
    }

    #[test]
    fn extracts_provider_error_messages() {
        let body = r#"{"error":{"type":"invalid_request_error","message":"model not found"}}"#;
        assert_eq!(api_error_message(reqwest::StatusCode::BAD_REQUEST, body), "model not found");
        assert!(api_error_message(reqwest::StatusCode::UNAUTHORIZED, "{}").contains("rejected"));
        assert_eq!(api_error_message(reqwest::StatusCode::BAD_GATEWAY, "<html>"), "Request failed with HTTP 502");
    }
}
