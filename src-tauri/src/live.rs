//! Live information: weather (Open-Meteo, no account or key needed) and news
//! from RSS/Atom feeds the user adds. Nothing here runs unless the user has
//! configured a location or a feed.

use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use serde_json::Value;

use crate::http;

type CommandResult<T> = Result<T, String>;

const MAX_FEED_BYTES: usize = 3 * 1024 * 1024;
const MAX_FEED_ITEMS: usize = 30;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    name: String,
    region: String,
    country: String,
    latitude: f64,
    longitude: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentWeather {
    temperature: f64,
    apparent_temperature: f64,
    humidity: f64,
    wind_speed: f64,
    weather_code: i64,
    is_day: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWeather {
    date: String,
    weather_code: i64,
    max: f64,
    min: f64,
    precipitation_probability: Option<f64>,
    sunrise: Option<String>,
    sunset: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    current: CurrentWeather,
    daily: Vec<DailyWeather>,
    temperature_unit: String,
    wind_unit: String,
    fetched_at_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    title: String,
    link: Option<String>,
    published: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    title: String,
    items: Vec<FeedItem>,
}

async fn get_json(url: url::Url) -> CommandResult<Value> {
    let response = http::client().get(url).timeout(Duration::from_secs(15)).send().await.map_err(http::describe)?;
    let status = response.status();
    let body = http::read_limited(response, 1024 * 1024).await?;
    if !status.is_success() {
        return Err(format!("Weather service returned HTTP {}", status.as_u16()));
    }
    serde_json::from_slice(&body).map_err(|_| "Unexpected response from the weather service".to_string())
}

pub fn parse_places(value: &Value) -> Vec<Place> {
    value["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(Place {
                name: r["name"].as_str()?.to_string(),
                region: r["admin1"].as_str().unwrap_or_default().to_string(),
                country: r["country"].as_str().unwrap_or_default().to_string(),
                latitude: r["latitude"].as_f64()?,
                longitude: r["longitude"].as_f64()?,
            })
        })
        .collect()
}

pub fn parse_forecast(value: &Value, now_ms: u64) -> CommandResult<Forecast> {
    let current = &value["current"];
    let num = |v: &Value| v.as_f64().ok_or_else(|| "Incomplete weather data".to_string());
    let daily = &value["daily"];
    let dates = daily["time"].as_array().cloned().unwrap_or_default();
    let at = |key: &str, i: usize| daily[key].get(i).cloned().unwrap_or(Value::Null);
    Ok(Forecast {
        current: CurrentWeather {
            temperature: num(&current["temperature_2m"])?,
            apparent_temperature: num(&current["apparent_temperature"])?,
            humidity: num(&current["relative_humidity_2m"])?,
            wind_speed: num(&current["wind_speed_10m"])?,
            weather_code: current["weather_code"].as_i64().unwrap_or(-1),
            is_day: current["is_day"].as_i64().unwrap_or(1) == 1,
        },
        daily: dates
            .iter()
            .enumerate()
            .filter_map(|(i, date)| {
                Some(DailyWeather {
                    date: date.as_str()?.to_string(),
                    weather_code: at("weather_code", i).as_i64().unwrap_or(-1),
                    max: at("temperature_2m_max", i).as_f64()?,
                    min: at("temperature_2m_min", i).as_f64()?,
                    precipitation_probability: at("precipitation_probability_max", i).as_f64(),
                    sunrise: at("sunrise", i).as_str().map(str::to_string),
                    sunset: at("sunset", i).as_str().map(str::to_string),
                })
            })
            .collect(),
        temperature_unit: value["current_units"]["temperature_2m"].as_str().unwrap_or("°C").to_string(),
        wind_unit: value["current_units"]["wind_speed_10m"].as_str().unwrap_or("km/h").to_string(),
        fetched_at_ms: now_ms,
    })
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{a0}'),
        "auml" => Some('ä'),
        "ouml" => Some('ö'),
        "uuml" => Some('ü'),
        "Auml" => Some('Ä'),
        "Ouml" => Some('Ö'),
        "Uuml" => Some('Ü'),
        "szlig" => Some('ß'),
        "eacute" => Some('é'),
        "egrave" => Some('è'),
        "agrave" => Some('à'),
        "ccedil" => Some('ç'),
        "ntilde" => Some('ñ'),
        "hellip" => Some('…'),
        "ndash" => Some('–'),
        "mdash" => Some('—'),
        "lsquo" => Some('‘'),
        "rsquo" => Some('’'),
        "ldquo" => Some('“'),
        "rdquo" => Some('”'),
        "euro" => Some('€'),
        "copy" => Some('©'),
        "reg" => Some('®'),
        "trade" => Some('™'),
        _ => {
            let code = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")).map(|h| u32::from_str_radix(h, 16));
            let code = code.or_else(|| name.strip_prefix('#').map(|d| d.parse::<u32>()));
            code.and_then(Result::ok).and_then(char::from_u32)
        }
    }
}

/// One pass of entity decoding. Feeds often escape titles twice or put HTML in
/// CDATA; unknown names stay as they are instead of vanishing.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest.find(';').filter(|end| *end <= 12).and_then(|end| decode_entity(&rest[1..end]).map(|c| (c, end)));
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

/// A feed's bytes as text: UTF-8, or else Latin-1 as older feeds declare it.
fn feed_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// Parses RSS 2.0, RSS 1.0 (RDF) and Atom feeds into a common shape.
pub fn parse_feed(xml: &str) -> CommandResult<Feed> {
    // No text trimming: it would also drop the spaces around entity references
    // ("Tech &amp; Code" → "Tech&Code"); values are trimmed when an element ends.
    let mut reader = Reader::from_str(xml);

    let mut path: Vec<String> = Vec::new();
    let mut feed_title = String::new();
    let mut items: Vec<FeedItem> = Vec::new();
    let mut current: Option<FeedItem> = None;
    let mut text = String::new();

    loop {
        match reader.read_event().map_err(|e| format!("This isn't a valid RSS or Atom feed ({e})"))? {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_ascii_lowercase();
                if name == "item" || name == "entry" {
                    current = Some(FeedItem { title: String::new(), link: None, published: None });
                }
                if name == "link" {
                    if let (Some(item), Some(href)) = (current.as_mut(), attribute(&e, "href")) {
                        if item.link.is_none() && attribute(&e, "rel").is_none_or(|rel| rel == "alternate") {
                            item.link = Some(href);
                        }
                    }
                }
                // Markup inside a title (Atom's type="xhtml") is part of the title.
                if !path.iter().any(|p| p == "title") {
                    text.clear();
                }
                path.push(name);
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_ascii_lowercase();
                if name == "link" {
                    if let (Some(item), Some(href)) = (current.as_mut(), attribute(&e, "href")) {
                        if item.link.is_none() && attribute(&e, "rel").is_none_or(|rel| rel == "alternate") {
                            item.link = Some(href);
                        }
                    }
                }
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::CData(t) => text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) => {
                let name = r.into_inner();
                match decode_entity(&name) {
                    Some(c) => text.push(c),
                    None => {
                        text.push('&');
                        text.push_str(&name);
                        text.push(';');
                    }
                }
            }
            Event::End(_) => {
                let name = path.pop().unwrap_or_default();
                if path.iter().any(|p| p == "title") {
                    continue;
                }
                let value = decode_entities(text.trim());
                match (current.as_mut(), name.as_str()) {
                    (Some(item), "title") if item.title.is_empty() => item.title = value,
                    (Some(item), "link") if item.link.is_none() && !value.is_empty() => item.link = Some(value),
                    (Some(item), "pubdate" | "published" | "updated" | "date") if item.published.is_none() => item.published = Some(value),
                    (Some(_), "item" | "entry") => {
                        if let Some(item) = current.take().filter(|i| !i.title.is_empty()) {
                            items.push(item);
                        }
                        if items.len() >= MAX_FEED_ITEMS {
                            break;
                        }
                    }
                    (None, "title") if feed_title.is_empty() => feed_title = value,
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if items.is_empty() && feed_title.is_empty() {
        return Err("No feed entries were found at this address".into());
    }
    // Only web links are kept; anything else (javascript:, file:) is dropped.
    for item in &mut items {
        item.link = item.link.take().filter(|l| l.starts_with("https://") || l.starts_with("http://"));
    }
    Ok(Feed { title: feed_title, items })
}

fn attribute(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == key)
        .map(|a| decode_entities(&a.value))
}

pub fn validate_feed_url(raw: &str) -> CommandResult<url::Url> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "Enter a full feed address, e.g. https://example.com/feed.xml".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err("Only http and https feeds are supported".into());
    }
    Ok(url)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub async fn weather_search(query: String) -> CommandResult<Vec<Place>> {
    let query = query.trim();
    if query.chars().count() < 2 || query.chars().count() > 80 {
        return Ok(Vec::new());
    }
    let url = url::Url::parse_with_params(
        "https://geocoding-api.open-meteo.com/v1/search",
        &[("name", query), ("count", "6"), ("language", "en"), ("format", "json")],
    )
    .map_err(|e| e.to_string())?;
    Ok(parse_places(&get_json(url).await?))
}

#[tauri::command]
pub async fn weather_forecast(latitude: f64, longitude: f64, fahrenheit: bool) -> CommandResult<Forecast> {
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return Err("Invalid coordinates".into());
    }
    let (lat, lon) = (format!("{latitude:.4}"), format!("{longitude:.4}"));
    let mut params = vec![
        ("latitude", lat.as_str()),
        ("longitude", lon.as_str()),
        ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"),
        ("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset"),
        ("timezone", "auto"),
        ("forecast_days", "6"),
    ];
    if fahrenheit {
        params.push(("temperature_unit", "fahrenheit"));
        params.push(("wind_speed_unit", "mph"));
    }
    let url = url::Url::parse_with_params("https://api.open-meteo.com/v1/forecast", &params).map_err(|e| e.to_string())?;
    parse_forecast(&get_json(url).await?, now_ms())
}

#[tauri::command]
pub async fn news_fetch(url: String) -> CommandResult<Feed> {
    let url = validate_feed_url(&url)?;
    let response = http::client().get(url).timeout(Duration::from_secs(15)).send().await.map_err(http::describe)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The feed returned HTTP {}", status.as_u16()));
    }
    let body = http::read_limited(response, MAX_FEED_BYTES).await?;
    parse_feed(&feed_text(&body))
}

/// Opens an http(s) link in the default browser.
#[tauri::command]
pub async fn open_url(url: String) -> CommandResult<()> {
    let url = validate_feed_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || crate::shell::open_url(url.as_str())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rss_with_entities_and_cdata() {
        let xml = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Tech &amp; Code</title>
            <item><title><![CDATA[Rust 2.0 <released>]]></title><link>https://example.com/a</link><pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate></item>
            <item><title>Caf&#233; news</title><link>javascript:alert(1)</link></item>
            <item><link>https://example.com/no-title</link></item>
            </channel></rss>"#;
        let feed = parse_feed(xml).unwrap();
        assert_eq!(feed.title, "Tech & Code");
        assert_eq!(feed.items.len(), 2);
        assert_eq!(feed.items[0].title, "Rust 2.0 <released>");
        assert_eq!(feed.items[0].link.as_deref(), Some("https://example.com/a"));
        assert_eq!(feed.items[1].title, "Café news");
        assert_eq!(feed.items[1].link, None, "non-web links are dropped");
    }

    #[test]
    fn decodes_titles_escaped_twice_and_marked_up() {
        let xml = r#"<rss><channel><title>News</title>
            <item><title><![CDATA[It&#8217;s &uuml;ber &unknown; 5 & 6]]></title><link>https://example.com/a?x=1&amp;y=2</link></item>
            <item><title>M&uuml;nchen</title></item>
            </channel></rss>"#;
        let feed = parse_feed(xml).unwrap();
        assert_eq!(feed.items[0].title, "It’s über &unknown; 5 & 6");
        assert_eq!(feed.items[0].link.as_deref(), Some("https://example.com/a?x=1&y=2"));
        assert_eq!(feed.items[1].title, "München");
        let atom = r#"<feed><entry><title type="xhtml"><div>Hallo <b>Welt</b></div></title><link href="https://e.xyz/?a=1&#38;b=2"/></entry></feed>"#;
        let feed = parse_feed(atom).unwrap();
        assert_eq!(feed.items[0].title, "Hallo Welt");
        assert_eq!(feed.items[0].link.as_deref(), Some("https://e.xyz/?a=1&b=2"));
        assert_eq!(feed_text(&[0x4D, 0xFC, 0x6E]), "Mün", "Latin-1 feeds keep their umlauts");
    }

    #[test]
    fn parses_atom_links_from_attributes() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
            <entry><title>Post</title><link rel="alternate" href="https://blog.example/post"/><updated>2026-11-01T10:00:00Z</updated></entry></feed>"#;
        let feed = parse_feed(xml).unwrap();
        assert_eq!(feed.items[0].link.as_deref(), Some("https://blog.example/post"));
        assert_eq!(feed.items[0].published.as_deref(), Some("2026-11-01T10:00:00Z"));
    }

    #[test]
    fn rejects_non_feeds() {
        assert!(parse_feed("<html><body>Not a feed</body></html>").is_err());
    }

    #[test]
    fn validates_feed_urls() {
        assert!(validate_feed_url("https://example.com/feed").is_ok());
        assert!(validate_feed_url("file:///C:/secret.xml").is_err());
        assert!(validate_feed_url("javascript:alert(1)").is_err());
        assert!(validate_feed_url("example.com").is_err());
    }

    #[test]
    fn parses_open_meteo_payloads() {
        let places = parse_places(&json!({ "results": [{ "name": "Berlin", "admin1": "Berlin", "country": "Germany", "latitude": 52.52, "longitude": 13.41 }] }));
        assert_eq!(places[0].name, "Berlin");

        let forecast = parse_forecast(
            &json!({
                "current_units": { "temperature_2m": "°C", "wind_speed_10m": "km/h" },
                "current": { "temperature_2m": 8.5, "apparent_temperature": 6.1, "relative_humidity_2m": 81, "weather_code": 3, "wind_speed_10m": 12.4, "is_day": 0 },
                "daily": { "time": ["2026-11-01", "2026-11-02"], "weather_code": [3, 61], "temperature_2m_max": [10.1, 9.0],
                           "temperature_2m_min": [4.2, 5.5], "precipitation_probability_max": [10, 80], "sunrise": ["2026-11-01T07:05", "2026-11-02T07:07"], "sunset": ["2026-11-01T16:40", "2026-11-02T16:38"] }
            }),
            1,
        )
        .unwrap();
        assert!(!forecast.current.is_day);
        assert_eq!(forecast.daily.len(), 2);
        assert_eq!(forecast.daily[1].precipitation_probability, Some(80.0));
        assert!(parse_forecast(&json!({}), 1).is_err());
    }
}
