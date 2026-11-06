//! Spotify through its own desktop app, read and pressed via Windows UI
//! Automation. Spotify's Web API isn't open to apps like NOVA (five users per
//! app, and playback needs Premium), while this works with any account.
//!
//! Elements are found by where they are and what their links point to, not by
//! their labels, so it works in every language. Pressing something brings
//! Spotify to the front whatever NOVA does, so the window that was in front
//! comes back afterwards, and none of this runs during a game.

use std::time::{Duration, Instant};

use super::pc::{self, Target, WindowVerb};

type Element = (String, String, Option<String>);

const STARTING: Duration = Duration::from_secs(15);
const RESULTS: Duration = Duration::from_secs(8);
const CONFIRMING: Duration = Duration::from_secs(6);
const RESULTS_CHANGE: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Song,
    Album,
    Playlist,
    Artist,
}

impl Kind {
    pub fn parse(raw: &str) -> Option<Kind> {
        match raw {
            "song" => Some(Kind::Song),
            "album" => Some(Kind::Album),
            "playlist" => Some(Kind::Playlist),
            "artist" => Some(Kind::Artist),
            _ => None,
        }
    }

    /// The end of the search tab's link. Songs come from "all results", where Spotify ranks best.
    fn tab(self) -> Option<&'static str> {
        match self {
            Kind::Song => None,
            Kind::Album => Some("/albums"),
            Kind::Playlist => Some("/playlists"),
            Kind::Artist => Some("/artists"),
        }
    }

    fn link(self) -> &'static str {
        match self {
            Kind::Song => "/track/",
            Kind::Album => "/album/",
            Kind::Playlist => "/playlist/",
            Kind::Artist => "/artist/",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Control {
    Shuffle,
    Repeat,
    Like,
}

fn links_to(element: &Element, part: &str) -> bool {
    element.0 == "link" && element.2.as_deref().is_some_and(|value| value.contains(part))
}

/// The last of the search tabs: results come after it.
fn tabs_end(elements: &[Element]) -> Option<usize> {
    elements.iter().rposition(|element| links_to(element, "/search/"))
}

fn pick_tab(elements: &[Element], tab: &str) -> Option<usize> {
    elements.iter().position(|element| links_to(element, "/search/") && element.2.as_deref().is_some_and(|value| value.ends_with(tab)))
}

/// The play button of the first result of this kind. In a list and on a card it
/// comes just before the result's link; on the top result, right after it.
fn pick_result(elements: &[Element], kind: Kind) -> Option<usize> {
    let start = tabs_end(elements)? + 1;
    let link = start + elements[start..].iter().position(|element| links_to(element, kind.link()))?;
    let is_button = |index: &usize| elements[*index].0 == "button";
    (start..link).rev().take(3).find(is_button).or_else(|| (link..elements.len()).find(is_button))
}

/// The player bar, found from its progress slider ("0:12/2:02"), which comes after
/// add, shuffle, back, play, next and repeat in every language.
fn pick_control(elements: &[Element], control: Control) -> Option<usize> {
    let progress = elements.iter().position(|(kind, _, value)| kind == "slider" && value.as_deref().is_some_and(|value| value.contains('/') && value.contains(':')))?;
    if control == Control::Repeat {
        return (0..progress).rev().find(|index| elements[*index].0 == "checkbox");
    }
    let mut buttons = (0..progress).rev().filter(|index| elements[*index].0 == "button");
    // Back from the slider: next, play, back, shuffle, add.
    buttons.nth(if control == Control::Shuffle { 3 } else { 4 })
}

/// What is in the user's library, in order: "Lieblingssongs Angeheftet Playlist • name".
/// Those are the buttons before the player bar's first control whose label has the type's dot.
fn library(elements: &[Element]) -> Vec<&str> {
    let player = pick_control(elements, Control::Like).unwrap_or(elements.len());
    elements[..player].iter().filter(|(kind, name, _)| kind == "button" && name.contains(" • ")).map(|(_, name, _)| name.as_str()).collect()
}

fn pick_library(elements: &[Element], wanted: &str) -> Option<usize> {
    let wanted = wanted.to_lowercase();
    let player = pick_control(elements, Control::Like).unwrap_or(elements.len());
    elements[..player].iter().position(|(kind, name, _)| kind == "button" && name.contains(" • ") && name.to_lowercase().contains(&wanted))
}

/// A playlist's own big play button, on the page opened from the library. The
/// page's heading is what tells it from the page before: there, "Zu Lieblingssongs
/// hinzufügen" names it too, and pressing that would change the user's library.
fn pick_page_play(elements: &[Element], wanted: &str) -> Option<usize> {
    let wanted = wanted.to_lowercase();
    let bar_end = elements.iter().rposition(|(kind, ..)| kind == "slider")?;
    let heading = (bar_end..elements.len()).find(|index| elements[*index].0 == "text" && elements[*index].1.to_lowercase().contains(&wanted))?;
    (heading..elements.len()).find(|index| elements[*index].0 == "button" && elements[*index].1.to_lowercase().contains(&wanted))
}

fn read(target: &Target) -> Result<Vec<Element>, String> {
    crate::shell::with_com(false, || pc::read_window(target))
}

fn press(target: &Target, pick: &dyn Fn(&[Element]) -> Option<usize>) -> Result<Option<String>, String> {
    crate::shell::with_com(false, || pc::act_on(target, pick, None))
}

/// Runs `action` until it gives something or the time is up.
fn wait_for<T>(limit: Duration, mut action: impl FnMut() -> Result<Option<T>, String>) -> Result<Option<T>, String> {
    let started = Instant::now();
    loop {
        if let Some(found) = action()? {
            return Ok(Some(found));
        }
        if started.elapsed() >= limit {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn spotify_window() -> Option<pc::WindowInfo> {
    pc::windows().into_iter().find(|window| window.process == "spotify")
}

/// Spotify's window, with the app started if it wasn't running. The list of
/// elements only fills after it has been asked for once, so that's waited for too.
fn open_spotify() -> Result<Target, String> {
    if spotify_window().is_none() {
        crate::shell::open_system_link("spotify:").map_err(|_| "Spotify isn't installed on this PC.".to_string())?;
    }
    let found = wait_for(STARTING, || Ok(spotify_window()))?;
    found.ok_or("Spotify didn't open in time.")?;
    let target = pc::pick_window(&pc::windows(), "spotify")?;
    let ready = wait_for(STARTING, || Ok(read(&target)?.iter().any(|(kind, ..)| kind == "slider").then_some(())))?;
    ready.ok_or("Spotify didn't get ready in time. Is someone logged in?")?;
    Ok(target)
}

/// Runs `work` on Spotify and leaves things as they were: the same window in
/// front, and Spotify minimized again if it was.
fn with_spotify<T>(work: impl FnOnce(&Target) -> Result<T, String>) -> Result<T, String> {
    let windows = pc::windows();
    let previous = windows.iter().find(|window| window.foreground && window.process != "spotify").map(|window| window.hwnd.to_string());
    let minimized = windows.iter().any(|window| window.process == "spotify" && window.minimized);
    let target = open_spotify()?;
    // Spotify ignores clicks from outside while it's minimized.
    pc::show_quietly(&target, true)?;
    std::thread::sleep(Duration::from_millis(500));
    let result = work(&target);
    // Twice: Spotify can come forward again a moment after the press.
    for _ in 0..2 {
        if minimized {
            let _ = pc::show_quietly(&target, false);
        }
        if let Some(window) = previous.as_ref().and_then(|id| pc::pick_window(&pc::windows(), id).ok()) {
            let _ = pc::window_action(&window, WindowVerb::Focus);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    result
}

fn letters(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Whether Spotify shows the search for this query. Its search field says so;
/// the window's title doesn't, because that names the song while one plays.
fn shows_search(elements: &[Element], query: &str) -> bool {
    let wanted = letters(query);
    elements.iter().any(|(kind, _, value)| kind == "dropdown" && value.as_deref().is_some_and(|value| letters(value) == wanted)) && tabs_end(elements).is_some()
}

/// The first result's link, to tell new results from the ones still showing.
fn first_result(elements: &[Element], kind: Kind) -> Option<String> {
    let start = tabs_end(elements)? + 1;
    elements[start..].iter().find(|element| links_to(element, kind.link())).and_then(|element| element.2.clone())
}

/// Whether the song that kept playing can be what was asked for, as when it's
/// asked for twice: its title (before " by ") is part of the search.
fn fits_search(track: &str, query: &str) -> bool {
    let title = letters(track.split(" by ").next().unwrap_or(track));
    !title.is_empty() && letters(query).contains(&title)
}

/// What plays now, once Spotify reports it. For a moment after the press it still
/// says "playing" about the song from before, so a new song is waited for. The
/// same song only counts if it fits the search; otherwise the press didn't work,
/// and the user is told that rather than told it worked.
fn confirm_playing(before: Option<&str>, query: Option<&str>) -> Result<String, String> {
    let current = || -> Result<Option<(String, bool)>, String> { Ok(crate::media::platform::state()?.filter(|state| state.describe().contains("Spotify")).map(|state| (state.track(), state.is_playing()))) };
    if let Some(track) = wait_for(CONFIRMING, || Ok(current()?.filter(|(track, playing)| *playing && before != Some(track.as_str())).map(|(track, _)| track)))? {
        return Ok(track);
    }
    match current()? {
        Some((track, true)) if query.is_some_and(|query| fits_search(&track, query)) => Ok(track),
        Some((track, true)) => Err(format!("Spotify still plays {track}, so that didn't work. Try again.")),
        _ => Err("NOVA pressed play, but Spotify doesn't report playing yet. On a free account an ad may be running first.".into()),
    }
}

fn track_before() -> Option<String> {
    crate::media::platform::state().ok().flatten().map(|state| state.track())
}

/// Searches for `query` and plays the first result of this kind.
pub fn play(query: &str, kind: Kind) -> Result<String, String> {
    let before = track_before();
    with_spotify(|target| {
        let old_result = first_result(&read(target)?, Kind::Song);
        let link = format!("spotify:search:{}", crate::shell::encode_query(query));
        crate::shell::open_system_link_owned(&link)?;
        let mut shown = wait_for(RESULTS / 2, || Ok(shows_search(&read(target)?, query).then_some(())))?;
        // Spotify sometimes drops a link it gets while it's busy.
        if shown.is_none() {
            crate::shell::open_system_link_owned(&link)?;
            shown = wait_for(RESULTS, || Ok(shows_search(&read(target)?, query).then_some(())))?;
        }
        if shown.is_none() {
            let field = read(target)?.into_iter().find(|(kind, ..)| kind == "dropdown").and_then(|element| element.2);
            return Err(format!("Spotify didn't show the search in time (its search field says {field:?})."));
        }
        // The search field changes before the results do, and pressing now would
        // start something from the search before. The same search gives the same
        // first result, so this only waits so long.
        let replaced = wait_for(RESULTS_CHANGE, || Ok(first_result(&read(target)?, Kind::Song).filter(|result| Some(result) != old_result.as_ref())))?;
        if replaced.is_none() && first_result(&read(target)?, Kind::Song).is_none() {
            return Err(format!("Spotify found no songs for “{query}”."));
        }
        // New results still settle for a moment; the first one can move.
        std::thread::sleep(Duration::from_millis(400));
        if let Some(tab) = kind.tab() {
            press(target, &|elements| pick_tab(elements, tab))?.ok_or("Spotify's search looks different than NOVA expects.")?;
            std::thread::sleep(Duration::from_millis(1500));
        }
        let pressed = wait_for(RESULTS, || press(target, &|elements| pick_result(elements, kind)))?;
        pressed.ok_or_else(|| format!("Spotify found nothing of that kind for “{query}”."))?;
        confirm_playing(before.as_deref(), Some(query))
    })
}

/// Presses shuffle, repeat or add-to-library in the player bar. Says how the button reads now.
pub fn control(action: Control) -> Result<String, String> {
    with_spotify(|target| {
        press(target, &|elements| pick_control(elements, action))?.ok_or("Spotify's player bar isn't showing. Is something loaded?")?;
        std::thread::sleep(Duration::from_millis(700));
        let elements = read(target)?;
        Ok(pick_control(&elements, action).map_or_else(String::new, |index| elements[index].1.clone()))
    })
}

/// The playlists, albums and artists in the user's library.
pub fn library_items() -> Result<Vec<String>, String> {
    with_spotify(|target| Ok(library(&read(target)?).into_iter().map(str::to_string).collect()))
}

/// Opens something from the user's library and plays it.
pub fn play_from_library(wanted: &str) -> Result<String, String> {
    let before = track_before();
    with_spotify(|target| {
        press(target, &|elements| pick_library(elements, wanted))?.ok_or_else(|| format!("“{wanted}” isn't in the Spotify library. Check spotify_library."))?;
        let pressed = wait_for(RESULTS, || press(target, &|elements| pick_page_play(elements, wanted)))?;
        pressed.ok_or_else(|| format!("Spotify opened “{wanted}”, but NOVA found no play button on it."))?;
        confirm_playing(before.as_deref(), None)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(kind: &str, name: &str, value: Option<&str>) -> Element {
        (kind.into(), name.into(), value.map(str::to_string))
    }

    /// As the app really shows it: the player bar, the tabs and results of a search.
    fn bar() -> Vec<Element> {
        vec![
            // While something plays, the title names that instead of the search.
            e("document", "Mamma Mia • HUGEL", Some("https://xpui.app.spotify.com/index.html")),
            e("dropdown", "Was möchtest du wiedergeben?", Some("Blinding+Lights")),
            e("button", "Lieblingssongs Angeheftet Playlist • /_ucax", None),
            e("button", "어디에 최고가 있나요 Playlist • /_ucax", None),
            e("button", "Fluxxwave Single • Clovis Reyes", None),
            e("button", "Ansicht „Aktueller Titel“", None),
            e("button", "Zur Playlist hinzufügen", None),
            e("button", "Shuffle für „어디에 최고가 있나요“ aktivieren", None),
            e("button", "Zurück", None),
            e("button", "Play", None),
            e("button", "Weiter", None),
            e("checkbox", "Wiederholen aktivieren", None),
            e("text", "0:12", None),
            e("slider", "Fortschritt ändern", Some("0:12/2:02")),
            e("button", "Lyrics", None),
            e("slider", "Lautstärke ändern", Some("0:00")),
        ]
    }

    fn tabs() -> Vec<Element> {
        ["", "/tracks", "/playlists", "/albums", "/artists", "/genres"].iter().map(|end| e("link", "Tab", Some(&format!("https://xpui.app.spotify.com/search/Blinding%2BLights{end}")))).collect()
    }

    fn all_results() -> Vec<Element> {
        [
            bar(),
            tabs(),
            vec![
                e("cell", "Blinding Lights", None),
                e("link", "Blinding Lights", Some("https://xpui.app.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b")),
                e("cell", "Song • The Weeknd", None),
                e("link", "The Weeknd", Some("https://xpui.app.spotify.com/intl-de/artist/1Xyo4u8uXC1ZmMpatF05PJ")),
                e("cell", "Play", None),
                e("button", "Play", None),
                e("button", "Blinding Lights (Funny Indian Remix) wiedergeben", None),
                e("cell", "Blinding Lights (Funny Indian Remix)", None),
                e("link", "Blinding Lights (Funny Indian Remix)", Some("https://xpui.app.spotify.com/intl-de/track/2g5pvlmBju3Jj9bipyGYPQ")),
            ],
        ]
        .concat()
    }

    fn name_of(elements: &[Element], index: Option<usize>) -> &str {
        &elements[index.unwrap()].1
    }

    #[test]
    fn plays_the_top_song_not_the_player_bars_button() {
        let elements = all_results();
        let index = pick_result(&elements, Kind::Song).unwrap();
        assert_eq!(elements[index].1, "Play");
        assert!(index > tabs_end(&elements).unwrap(), "the one in the results, after the tabs");
    }

    #[test]
    fn plays_a_song_listed_after_another_top_result() {
        let elements = [
            bar(),
            tabs(),
            vec![
                e("button", "Queen wiedergeben", None),
                e("link", "Queen", Some("https://xpui.app.spotify.com/intl-de/artist/1dfeR4HaWDbWqFHLkxsg1d")),
                e("text", "Künstler*in", None),
                e("button", "Mehr Optionen", None),
                e("text", "x", None),
                e("text", "y", None),
                e("text", "z", None),
                e("button", "Bohemian Rhapsody wiedergeben", None),
                e("cell", "Bohemian Rhapsody", None),
                e("link", "Bohemian Rhapsody", Some("https://xpui.app.spotify.com/intl-de/track/abc")),
            ],
        ]
        .concat();
        assert_eq!(name_of(&elements, pick_result(&elements, Kind::Song)), "Bohemian Rhapsody wiedergeben");
    }

    #[test]
    fn plays_from_the_card_on_a_results_tab() {
        for (kind, card, play, link) in [
            (Kind::Album, "Greatest Hits II 1991 • Queen", "Greatest Hits II von Queen abspielen", "https://xpui.app.spotify.com/intl-de/album/36ezh7pwcktRIhXmL2AFhp"),
            (Kind::Playlist, "Queen: Greatest Hits Von Queen", "Queen: Greatest Hits wiedergeben", "https://xpui.app.spotify.com/playlist/595cY5S1FpMpiEIWsk6dG7"),
            (Kind::Artist, "Queen Künstler*in", "Queen wiedergeben", "https://xpui.app.spotify.com/intl-de/artist/1dfeR4HaWDbWqFHLkxsg1d"),
        ] {
            let elements = [bar(), tabs(), vec![e("checkbox", "Genres", None), e("button", card, None), e("button", play, None), e("link", "Result", Some(link)), e("button", "Next card", None)]].concat();
            assert_eq!(name_of(&elements, pick_result(&elements, kind)), play);
        }
    }

    #[test]
    fn finds_nothing_without_results() {
        assert_eq!(pick_result(&bar(), Kind::Song), None);
        assert_eq!(pick_result(&[bar(), tabs()].concat(), Kind::Song), None);
    }

    #[test]
    fn finds_the_search_tabs_by_their_links() {
        let elements = all_results();
        assert_eq!(elements[pick_tab(&elements, "/albums").unwrap()].2.as_deref(), Some("https://xpui.app.spotify.com/search/Blinding%2BLights/albums"));
        assert_eq!(pick_tab(&bar(), "/albums"), None);
    }

    #[test]
    fn finds_the_player_controls_in_any_language() {
        let elements = bar();
        assert_eq!(name_of(&elements, pick_control(&elements, Control::Shuffle)), "Shuffle für „어디에 최고가 있나요“ aktivieren");
        assert_eq!(name_of(&elements, pick_control(&elements, Control::Repeat)), "Wiederholen aktivieren");
        assert_eq!(name_of(&elements, pick_control(&elements, Control::Like)), "Zur Playlist hinzufügen");
        // The volume slider isn't the progress slider, and without a bar there's nothing to press.
        assert_eq!(pick_control(&[e("slider", "Lautstärke", Some("0:00"))], Control::Shuffle), None);
    }

    #[test]
    fn reads_the_library_and_finds_in_it() {
        let elements = bar();
        assert_eq!(library(&elements).len(), 3);
        assert_eq!(library(&elements)[0], "Lieblingssongs Angeheftet Playlist • /_ucax");
        assert_eq!(name_of(&elements, pick_library(&elements, "lieblingssongs")), "Lieblingssongs Angeheftet Playlist • /_ucax");
        assert_eq!(pick_library(&elements, "Gibt es nicht"), None);
    }

    #[test]
    fn plays_a_page_from_its_own_button() {
        let elements = [bar(), vec![e("text", "Lieblingssongs", None), e("button", "Lieblingssongs wiedergeben", None), e("button", "Smart Shuffle für „Lieblingssongs“ aktivieren", None)]].concat();
        assert_eq!(name_of(&elements, pick_page_play(&elements, "Lieblingssongs")), "Lieblingssongs wiedergeben");
        assert_eq!(pick_page_play(&bar(), "Lieblingssongs"), None, "the library entry itself comes before the bar");
        // Still on a search page: this button changes the library, so it must never be chosen.
        let search = [bar(), vec![e("button", "Zu „Lieblingssongs“ hinzufügen", None)]].concat();
        assert_eq!(pick_page_play(&search, "Lieblingssongs"), None);
    }

    #[test]
    fn knows_when_the_search_shows() {
        assert!(shows_search(&all_results(), "Blinding Lights"));
        assert!(shows_search(&all_results(), "blinding lights!"));
        assert!(!shows_search(&all_results(), "Queen"));
        assert!(!shows_search(&all_results(), "Blinding"), "not the whole search");
        assert!(!shows_search(&bar(), "Blinding Lights"));
    }

    #[test]
    fn tells_new_results_from_old_ones() {
        assert_eq!(first_result(&all_results(), Kind::Song).as_deref(), Some("https://xpui.app.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b"));
        assert_eq!(first_result(&all_results(), Kind::Playlist), None);
        assert_eq!(first_result(&bar(), Kind::Song), None);
    }

    #[test]
    fn the_old_song_only_counts_if_it_was_asked_for() {
        assert!(fits_search("Thriller by Michael Jackson", "Thriller Michael Jackson"));
        assert!(fits_search("Thriller by Michael Jackson", "thriller"));
        assert!(!fits_search("Thriller by Michael Jackson", "Numb Linkin Park"));
        assert!(!fits_search("", "Numb"));
    }

    #[test]
    fn kinds_come_from_the_tool() {
        assert_eq!(Kind::parse("album"), Some(Kind::Album));
        assert_eq!(Kind::parse("podcast"), None);
    }

    /// Plays songs for real, in a row, counts how many are right, and pauses.
    /// `cargo test --lib -- --ignored spotify_many --nocapture`
    #[test]
    #[ignore]
    fn spotify_many() {
        let front = || pc::windows().iter().find(|w| w.foreground).map(|w| w.process.clone()).unwrap_or_default();
        let mut right = 0;
        let songs = [("Thriller Michael Jackson", "Thriller"), ("Lose Yourself Eminem", "Lose Yourself"), ("Numb Linkin Park", "Numb")];
        for (query, expected) in songs {
            let started = Instant::now();
            let outcome = play(query, Kind::Song);
            right += usize::from(outcome.as_ref().is_ok_and(|track| track.to_lowercase().contains(&expected.to_lowercase())));
            eprintln!("{query}: {outcome:?} in {} ms | in front: {} | minimized: {:?}", started.elapsed().as_millis(), front(), spotify_window().map(|w| w.minimized));
            std::thread::sleep(Duration::from_millis(1500));
        }
        eprintln!("=== {right} of {}", songs.len());
        if crate::media::platform::state().unwrap().is_some_and(|state| state.is_playing()) {
            eprintln!("pause: {:?}", crate::media::platform::control("toggle"));
        }
        eprintln!("end, in front: {} | minimized: {:?}", front(), spotify_window().map(|w| w.minimized));
    }

}
