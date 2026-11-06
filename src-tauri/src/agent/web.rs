//! Reading web pages for NOVA AI: public addresses only, text only, size-limited.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use url::{Host, Url};

const MAX_BYTES: usize = 3 * 1024 * 1024;
const MAX_CHARS: usize = 12_000;
const MAX_REDIRECTS: usize = 5;
/// Long enough for real pages, too short to smuggle much out in a query string.
const MAX_URL: usize = 500;

/// Never looks into the user's own network, also not through a public name or redirect.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_broadcast() || v4.is_unspecified() || v4.is_documentation() || a == 0 || (a == 100 && (64..128).contains(&b)) || a >= 224)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80)
            }
        },
    }
}

/// Checks an address without touching the network.
pub fn check_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL {
        return Err("That web address is too long".into());
    }
    let url = Url::parse(raw.trim()).map_err(|_| "That isn't a valid web address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http(s) web pages can be read".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Web addresses with a login can't be read".into());
    }
    let public = match url.host() {
        Some(Host::Ipv4(ip)) => is_public(ip.into()),
        Some(Host::Ipv6(ip)) => is_public(ip.into()),
        Some(Host::Domain(domain)) => {
            let domain = domain.to_lowercase();
            domain.contains('.') && ![".localhost", ".local", ".internal", ".lan", ".home", ".test"].iter().any(|suffix| domain.ends_with(suffix))
        }
        None => false,
    };
    if !public {
        return Err("NOVA AI only reads public web pages, not addresses in your own network".into());
    }
    Ok(url)
}

/// The addresses behind a URL, if every one of them is public.
fn public_addresses(url: &Url) -> Option<Vec<SocketAddr>> {
    let (host, port) = (url.host_str()?, url.port_or_known_default()?);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs().ok()?.collect();
    (!addresses.is_empty() && addresses.iter().all(|a| is_public(a.ip()))).then_some(addresses)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub url: String,
    pub title: Option<String>,
    pub text: String,
}

/// Downloads a page and reduces it to its text. Blocking; call off the async runtime.
pub fn read(url: &Url) -> Result<Page, String> {
    tauri::async_runtime::block_on(async {
        let mut current = url.clone();
        for _ in 0..=MAX_REDIRECTS {
            let addresses = public_addresses(&current).ok_or("NOVA AI only reads public web pages, not addresses in your own network")?;
            let client = crate::http::checked_client(current.host_str().unwrap_or_default(), &addresses)?;
            let mut response = client.get(current.clone()).timeout(Duration::from_secs(20)).send().await.map_err(crate::http::describe)?;
            if response.status().is_redirection() {
                let location = response.headers().get(reqwest::header::LOCATION).and_then(|l| l.to_str().ok()).ok_or("The page redirected nowhere")?;
                let next = current.join(location).map_err(|_| "The page redirected to an invalid address".to_string())?;
                current = check_url(next.as_str())?;
                continue;
            }
            if !response.status().is_success() {
                return Err(format!("The page answered with HTTP {}", response.status().as_u16()));
            }
            let kind = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|c| c.to_str().ok()).unwrap_or("text/html").to_lowercase();
            let html = kind.contains("html");
            if !(html || kind.starts_with("text/") || kind.contains("json") || kind.contains("xml")) {
                return Err(format!("That isn't a readable page ({kind}). Open it in the browser instead."));
            }
            // Long pages are cut, not refused: the start is what matters.
            let mut body = Vec::new();
            while body.len() < MAX_BYTES {
                match response.chunk().await.map_err(crate::http::describe)? {
                    Some(chunk) => body.extend_from_slice(&chunk),
                    None => break,
                }
            }
            let raw = String::from_utf8_lossy(&body);
            let (title, text) = if html { html_to_text(&raw) } else { (None, tidy(&raw)) };
            return Ok(Page { url: current.to_string(), title, text: shorten(text) });
        }
        Err("The page redirected too many times".to_string())
    })
}

fn shorten(text: String) -> String {
    match text.char_indices().nth(MAX_CHARS) {
        Some((end, _)) => format!("{}\n[Page cut off here]", &text[..end]),
        None => text,
    }
}

const SKIPPED: &[&str] = &["script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer"];
const BLOCKS: &[&str] = &["p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article", "main", "header", "aside", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "hr"];

/// The page's title and readable text. Not a full HTML parser; good enough for reading.
pub fn html_to_text(html: &str) -> (Option<String>, String) {
    // ASCII lowercasing keeps every byte offset valid for `html` too.
    let lower = html.to_ascii_lowercase();
    let title = lower.find("<title").and_then(|at| {
        let start = at + lower[at..].find('>')? + 1;
        let end = start + lower[start..].find("</title")?;
        Some(tidy(&decode_entities(&html[start..end]))).filter(|t| !t.is_empty())
    });
    let mut out = String::with_capacity(html.len() / 4);
    let mut i = 0;
    while let Some(relative) = html[i..].find('<') {
        let start = i + relative;
        out.push_str(&html[i..start]);
        if lower[start..].starts_with("<!--") {
            i = lower[start..].find("-->").map_or(html.len(), |e| start + e + 3);
            continue;
        }
        let Some(close) = html[start..].find('>') else {
            i = html.len();
            break;
        };
        let end = start + close + 1;
        let tag = &lower[start + 1..end - 1];
        let closing = tag.starts_with('/');
        let name: String = tag.trim_start_matches('/').chars().take_while(char::is_ascii_alphanumeric).collect();
        i = end;
        if !closing && !tag.ends_with('/') && SKIPPED.contains(&name.as_str()) {
            let closer = format!("</{name}");
            i = lower[end..].find(&closer).map_or(html.len(), |at| {
                let after = end + at;
                lower[after..].find('>').map_or(html.len(), |e| after + e + 1)
            });
        } else if BLOCKS.contains(&name.as_str()) {
            out.push('\n');
        }
    }
    if i < html.len() {
        out.push_str(&html[i..]);
    }
    (title, tidy(&decode_entities(&out)))
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest.find(';').filter(|&end| end <= 10).and_then(|end| {
            let name = &rest[1..end];
            let value = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "auml" => Some('ä'),
                "ouml" => Some('ö'),
                "uuml" => Some('ü'),
                "Auml" => Some('Ä'),
                "Ouml" => Some('Ö'),
                "Uuml" => Some('Ü'),
                "szlig" => Some('ß'),
                "euro" => Some('€'),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                _ => name.strip_prefix('#').and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => n.parse().ok(),
                }).and_then(char::from_u32),
            };
            value.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// One line per block of text, no runs of spaces or empty lines.
fn tidy(text: &str) -> String {
    text.lines().map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses_pass() {
        assert!(check_url("https://www.kfc.de/menu?x=1").is_ok());
        assert!(check_url("http://93.184.216.34/").is_ok());
        for bad in [
            "file:///C:/Windows/win.ini",
            "ftp://example.com/x",
            "http://localhost:1420/",
            "http://intranet/",
            "http://printer.local/",
            "http://127.0.0.1/",
            "http://192.168.0.1/",
            "http://10.0.0.8/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:192.168.0.1]/",
            "https://user:secret@example.com/",
            "not a url",
        ] {
            assert!(check_url(bad).is_err(), "accepted {bad}");
        }
        assert!(check_url(&format!("https://example.com/?data={}", "x".repeat(600))).is_err());
    }

    #[test]
    fn reduces_html_to_its_text() {
        let html = r#"<!doctype html><html><head><title>KFC &amp; mehr</title><style>p{color:red}</style></head>
            <body><nav><a href="/">Menü</a></nav><!-- hidden --><h1>Öffnungs&shy;zeiten</h1>
            <p>Täglich <b>10:00</b>&nbsp;Uhr</p><script>alert("nein")</script><ul><li>Burger</li><li>Grüße &#8364; &#x20AC;</li></ul></body></html>"#;
        let (title, text) = html_to_text(html);
        assert_eq!(title.as_deref(), Some("KFC & mehr"));
        assert_eq!(text, "Öffnungs&shy;zeiten\nTäglich 10:00 Uhr\nBurger\nGrüße € €");
    }

    #[test]
    fn survives_broken_html_and_long_pages() {
        assert_eq!(html_to_text("a < b").1, "a");
        assert_eq!(html_to_text("<script>never closed").1, "");
        assert_eq!(decode_entities("Tom & Jerry &bogus; &#xZZ;"), "Tom & Jerry &bogus; &#xZZ;");
        let long = shorten("ä".repeat(MAX_CHARS + 5));
        assert!(long.ends_with("[Page cut off here]"));
        assert_eq!(long.chars().filter(|c| *c == 'ä').count(), MAX_CHARS);
    }
}
