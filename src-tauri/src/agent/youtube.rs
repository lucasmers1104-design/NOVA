//! YouTube without a key: finds videos in the data of its public search and channel
//! pages, and plays them in the user's own browser, where they watch them anyway.
//! Those pages can change, so anything that isn't understood counts as "nothing
//! found" and the search opens in the browser instead. Ads stay: they're YouTube's.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::pc;

/// How long a page may take, and how much of one is read.
const PAGE_TIMEOUT: Duration = Duration::from_secs(15);
const MOST_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MOST_LISTED: usize = 8;
const LONGEST_DESCRIPTION: usize = 4000;
/// How long a started video gets to show up in Windows' media controls.
const STARTING: Duration = Duration::from_secs(12);
/// After this long a paused video isn't still loading: the browser didn't start it.
const AUTOPLAY_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub length: Option<String>,
    pub age: Option<String>,
    pub live: bool,
}

/// The eleven characters of a video id: a link built from it can't lead anywhere else.
pub fn is_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A video id from an id or any kind of YouTube link.
pub fn video_id(text: &str) -> Option<String> {
    let text = text.trim();
    if is_video_id(text) {
        return Some(text.to_string());
    }
    let url = url::Url::parse(text).ok()?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.").to_string();
    let id = match host.as_str() {
        "youtu.be" => url.path_segments()?.next().map(str::to_string),
        "youtube.com" | "music.youtube.com" => match url.path_segments()?.next() {
            Some("watch") => url.query_pairs().find(|(key, _)| key == "v").map(|(_, value)| value.into_owned()),
            Some("shorts" | "live" | "embed") => url.path_segments()?.nth(1).map(str::to_string),
            _ => None,
        },
        _ => None,
    };
    id.filter(|id| is_video_id(id))
}

pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// The data a YouTube page carries for itself.
fn page_data(html: &str) -> Option<Value> {
    let at = html.find("ytInitialData")?;
    let start = at + html[at..].find('{')?;
    serde_json::Deserializer::from_str(&html[start..]).into_iter::<Value>().next()?.ok()
}

/// Visits everything inside `value`, in order.
fn walk<'a>(value: &'a Value, visit: &mut dyn FnMut(&'a str, &'a Value)) {
    match value {
        Value::Object(fields) => {
            for (key, inner) in fields {
                visit(key, inner);
                walk(inner, visit);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, visit);
            }
        }
        _ => {}
    }
}

fn text_of(value: &Value) -> Option<String> {
    value["simpleText"].as_str().or_else(|| value["runs"][0]["text"].as_str()).map(str::to_string)
}

fn from_renderer(video: &Value) -> Option<Video> {
    let id = video["videoId"].as_str().filter(|id| is_video_id(id))?;
    let badges = video["badges"].to_string() + &video["thumbnailOverlays"].to_string();
    Some(Video {
        id: id.to_string(),
        title: text_of(&video["title"])?,
        channel: text_of(&video["ownerText"]).or_else(|| text_of(&video["longBylineText"])).unwrap_or_default(),
        length: text_of(&video["lengthText"]),
        age: text_of(&video["publishedTimeText"]),
        live: badges.contains("LIVE"),
    })
}

/// Channel pages describe their videos in a newer shape.
fn from_lockup(lockup: &Value) -> Option<Video> {
    let id = lockup["contentId"].as_str().filter(|id| is_video_id(id) && lockup["contentType"] == "LOCKUP_CONTENT_TYPE_VIDEO")?;
    let meta = &lockup["metadata"]["lockupMetadataViewModel"];
    let mut parts = Vec::new();
    walk(&meta["metadata"], &mut |key, value| {
        if key == "content" {
            parts.extend(value.as_str().map(str::to_string));
        }
    });
    let mut length = None;
    walk(&lockup["contentImage"], &mut |key, value| {
        if key == "thumbnailBadgeViewModel" && length.is_none() {
            length = value["text"].as_str().map(str::to_string);
        }
    });
    Some(Video { id: id.to_string(), title: meta["title"]["content"].as_str()?.to_string(), channel: String::new(), length, age: parts.last().cloned(), live: false })
}

/// The videos on a page, in the order it lists them.
fn videos_in(data: &Value) -> Vec<Video> {
    let mut found: Vec<Video> = Vec::new();
    walk(data, &mut |key, value| {
        let video = match key {
            "videoRenderer" | "gridVideoRenderer" => from_renderer(value),
            "lockupViewModel" => from_lockup(value),
            _ => None,
        };
        if let Some(video) = video.filter(|video| !found.iter().any(|known| known.id == video.id)) {
            found.push(video);
        }
    });
    found
}

/// (id, name) of the channels a search page lists.
fn channels_in(data: &Value) -> Vec<(String, String)> {
    let mut found = Vec::new();
    walk(data, &mut |key, value| {
        if key == "channelRenderer" {
            if let (Some(id), Some(name)) = (value["channelId"].as_str(), text_of(&value["title"])) {
                found.push((id.to_string(), name));
            }
        }
    });
    found
}

fn fetch(address: &str) -> Result<String, String> {
    tauri::async_runtime::block_on(async {
        let response = crate::http::client().get(address).timeout(PAGE_TIMEOUT).send().await.map_err(crate::http::describe)?;
        if !response.status().is_success() {
            return Err(format!("YouTube answered with HTTP {}", response.status().as_u16()));
        }
        let body = crate::http::read_limited(response, MOST_PAGE_BYTES).await?;
        Ok(String::from_utf8_lossy(&body).into_owned())
    })
}

fn search_page(query: &str) -> Result<Value, String> {
    page_data(&fetch(&format!("https://www.youtube.com/results?search_query={}", crate::shell::encode_query(query)))?).ok_or_else(|| "YouTube's page looks different than NOVA expects.".to_string())
}

/// The videos YouTube finds for `query`, best first.
pub fn search(query: &str) -> Result<Vec<Video>, String> {
    let mut videos = videos_in(&search_page(query)?);
    videos.truncate(MOST_LISTED);
    Ok(videos)
}

/// A channel by the name people call it: its id and proper name.
pub fn find_channel(wanted: &str) -> Result<(String, String), String> {
    let found = channels_in(&search_page(wanted)?);
    let lower = wanted.trim().trim_start_matches('@').to_lowercase();
    found.iter().find(|(_, name)| name.to_lowercase() == lower).or_else(|| found.first()).cloned().ok_or_else(|| format!("YouTube has no channel called “{wanted}”."))
}

/// A channel's newest videos, newest first.
pub fn channel_videos(id: &str, name: &str) -> Result<Vec<Video>, String> {
    let address = format!("https://www.youtube.com/channel/{}/videos", crate::shell::encode_query(id));
    let read = || -> Result<Vec<Video>, String> { Ok(videos_in(&page_data(&fetch(&address)?).ok_or("YouTube's page looks different than NOVA expects.")?)) };
    let mut videos = read()?;
    // Now and then YouTube sends the page without its list.
    if videos.is_empty() {
        videos = read()?;
    }
    for video in &mut videos {
        video.channel = name.to_string();
    }
    videos.truncate(MOST_LISTED);
    Ok(videos)
}

fn letters(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Whether the title Windows reports is this video. Browsers may add or cut something.
fn same_title(reported: &str, wanted: &str) -> bool {
    let (reported, wanted) = (letters(reported), letters(wanted));
    let start: String = wanted.chars().take(24).collect();
    // A song called "Hello" isn't the video "Adele - Hello (Official Video)": a cut title is most of it.
    !reported.is_empty() && (reported.contains(&start) || (reported.chars().count() * 2 >= wanted.chars().count() && wanted.contains(&reported)))
}

/// Opens the video in the browser, with whatever else plays paused first, and
/// says whether Windows reports it playing. False can mean that an ad runs first.
pub fn play(video: &Video) -> Result<bool, String> {
    crate::media::platform::pause_all(None)?;
    crate::shell::open_url(&watch_url(&video.id))?;
    let started = Instant::now();
    while started.elapsed() < STARTING {
        std::thread::sleep(Duration::from_millis(500));
        let press = started.elapsed() >= AUTOPLAY_WAIT;
        if crate::media::platform::find_playing(&|title| same_title(title, &video.title), press)? == Some(true) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What the page of a video says about it, for the model to read.
pub fn about(id: &str) -> Result<String, String> {
    let page = fetch(&watch_url(id))?;
    let player = page.find("ytInitialPlayerResponse").and_then(|at| {
        let start = at + page[at..].find('{')?;
        serde_json::Deserializer::from_str(&page[start..]).into_iter::<Value>().next()?.ok()
    });
    let details = player.as_ref().map(|data| &data["videoDetails"]).ok_or("YouTube's page looks different than NOVA expects.")?;
    let title = details["title"].as_str().ok_or("YouTube doesn't show this video.")?;
    let description: String = details["shortDescription"].as_str().unwrap_or_default().chars().take(LONGEST_DESCRIPTION).collect();
    let minutes = details["lengthSeconds"].as_str().and_then(|s| s.parse::<u64>().ok()).map_or(0, |s| s / 60);
    let views = details["viewCount"].as_str().unwrap_or("?");
    let channel = details["author"].as_str().unwrap_or("?");
    Ok(format!("Title: {title}\nChannel: {channel}\nLength: {minutes} min, {views} views\nDescription:\n{description}"))
}

/// The browser window showing YouTube.
pub fn youtube_window() -> Result<pc::Target, String> {
    let windows = pc::windows();
    let window = windows.iter().find(|w| w.title.to_lowercase().contains("youtube") && pc::BROWSERS.contains(&w.process.as_str())).ok_or("No browser window shows YouTube in front. The tab may be in the background.")?;
    pc::pick_window(&windows, &window.hwnd.to_string())
}

/// Sends one of YouTube's own keys to its window: f is fullscreen, c captions, m mute.
pub fn press_key(key: &str) -> Result<(), String> {
    let target = youtube_window()?;
    pc::send_input(&target, &[pc::parse_combo(key)?], 1, None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_real_video_ids_get_into_a_link() {
        assert!(is_video_id("dQw4w9WgXcQ"));
        assert!(!is_video_id("dQw4w9WgXc"));
        assert!(!is_video_id("dQw4w9WgXc&"));
        assert_eq!(video_id("dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=3").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://youtu.be/dQw4w9WgXcQ?si=abc").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://m.youtube.com/shorts/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(video_id("https://evil.example/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(video_id("https://www.youtube.com/watch?v=../../x"), None);
        assert_eq!(video_id("Rick Astley"), None);
    }

    fn renderer(id: &str, title: &str) -> Value {
        json!({ "videoRenderer": { "videoId": id, "title": { "runs": [{ "text": title }] }, "ownerText": { "runs": [{ "text": "Kanal" }] }, "lengthText": { "simpleText": "3:20" }, "publishedTimeText": { "simpleText": "vor 2 Tagen" } } })
    }

    #[test]
    fn reads_the_videos_of_a_search_page() {
        let html = format!("<script>var ytInitialData = {};</script><script>var other = {{}};</script>", json!({ "contents": [renderer("aaaaaaaaaaa", "Erstes"), { "adSlotRenderer": { "videoId": "ccccccccccc" } }, renderer("bbbbbbbbbbb", "Zweites"), renderer("aaaaaaaaaaa", "Erstes")] }));
        let videos = videos_in(&page_data(&html).unwrap());
        assert_eq!(videos.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["aaaaaaaaaaa", "bbbbbbbbbbb"]);
        assert_eq!(videos[0].channel, "Kanal");
        assert_eq!(videos[0].length.as_deref(), Some("3:20"));
        assert!(!videos[0].live);
    }

    #[test]
    fn reads_the_videos_of_a_channel_page() {
        let data = json!({ "tabs": [{ "richItemRenderer": { "content": { "lockupViewModel": {
            "contentId": "_c2e1NcI3Sc",
            "contentType": "LOCKUP_CONTENT_TYPE_VIDEO",
            "contentImage": { "thumbnailViewModel": { "overlays": [{ "thumbnailBottomOverlayViewModel": { "badges": [{ "thumbnailBadgeViewModel": { "text": "22:28" } }] } }] } },
            "metadata": { "lockupMetadataViewModel": { "title": { "content": "Neues Video" }, "metadata": { "contentMetadataViewModel": { "metadataRows": [{ "metadataParts": [{ "text": { "content": "1 Mio. Aufrufe" } }, { "text": { "content": "vor 3 Tagen" } }] }] } } } }
        } } } }, { "lockupViewModel": { "contentId": "PLxxxxxxxxx", "contentType": "LOCKUP_CONTENT_TYPE_PLAYLIST" } }] });
        let videos = videos_in(&data);
        assert_eq!(videos.len(), 1, "a playlist isn't a video");
        assert_eq!((videos[0].title.as_str(), videos[0].length.as_deref(), videos[0].age.as_deref()), ("Neues Video", Some("22:28"), Some("vor 3 Tagen")));
    }

    #[test]
    fn a_page_it_doesnt_understand_finds_nothing() {
        assert!(page_data("<html>Bitte stimme den Cookies zu</html>").is_none());
        assert!(videos_in(&json!({ "something": "else" })).is_empty());
    }

    #[test]
    fn reads_channels() {
        let data = json!({ "a": { "channelRenderer": { "channelId": "UCX6OQ3DkcsbYNE6H8uQQuVA", "title": { "simpleText": "MrBeast" } } } });
        assert_eq!(channels_in(&data), [("UCX6OQ3DkcsbYNE6H8uQQuVA".to_string(), "MrBeast".to_string())]);
    }

    #[test]
    fn knows_its_video_in_the_media_controls() {
        assert!(same_title("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"));
        assert!(same_title("Rick Astley - Never Gonna Give You Up (Official Video)...", "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)"));
        assert!(!same_title("Queen - Radio Ga Ga", "Rick Astley - Never Gonna Give You Up"));
        assert!(!same_title("", "Rick Astley"));
        assert!(!same_title("Hello", "Adele - Hello (Official Music Video)"));
    }

    /// Asks the real YouTube: `cargo test --lib -- --ignored youtube_live --nocapture`
    #[test]
    #[ignore]
    fn youtube_live() {
        let found = search("lofi hip hop").unwrap();
        eprintln!("{found:#?}");
        assert!(found.len() >= 3);
        let (id, name) = find_channel("MrBeast").unwrap();
        eprintln!("{id} {name}");
        let videos = channel_videos(&id, &name).unwrap();
        eprintln!("{:#?}", videos.first());
        assert!(videos.len() >= 3);
        eprintln!("{}", about(&videos[0].id).unwrap());
    }
}
