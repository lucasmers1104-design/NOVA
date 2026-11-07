//! What NOVA AI understands without an AI provider: finding files, opening
//! results and apps. Everything else explains how to connect a provider.


#[derive(Debug, Clone, PartialEq)]
pub enum Intent {
    Search(String),
    /// "open the third one" — 1-based index into the last results.
    OpenResult(usize),
    /// "show the folder of the second one".
    RevealResult(usize),
    /// "open Spotify" — an app, or else a file by that name.
    Open(String),
    LookAtScreen,
    /// "lauter" — an action of the media_control tool.
    Media(&'static str),
    /// "spiele Entspannungsmusik".
    Spotify(String),
    /// "spiel lofi hip hop auf youtube".
    YouTube(String),
    /// "suche im Internet nach Kinoprogramm".
    WebSearch(String),
    /// "neue Aufgabe Müll rausbringen".
    AddTask(String),
    Greeting,
    Help,
    Unknown,
}

/// Whole requests about what's playing.
const MEDIA: &[(&str, &str)] = &[
    ("pause", "pause"), ("pausiere", "pause"), ("musik aus", "pause"), ("musik stoppen", "pause"), ("stopp die musik", "pause"), ("stop the music", "pause"),
    ("play", "play"), ("weiterspielen", "play"), ("spiel weiter", "play"), ("spiele weiter", "play"), ("musik an", "play"), ("resume", "play"),
    ("nächster titel", "next"), ("nächstes lied", "next"), ("nächster song", "next"), ("überspringen", "next"), ("next song", "next"), ("next track", "next"), ("skip", "next"),
    ("vorheriger titel", "previous"), ("voriges lied", "previous"), ("previous song", "previous"), ("previous track", "previous"),
    ("lauter", "volume_up"), ("louder", "volume_up"), ("leiser", "volume_down"), ("quieter", "volume_down"),
    ("stumm", "mute"), ("mute", "mute"), ("ton aus", "mute"), ("ton an", "unmute"), ("unmute", "unmute"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

const GERMAN_HINTS: &[&str] = &[
    "finde", "such", "öffne", "oeffne", "starte", "zeig", "meine", "mein", "bitte", "kannst", "du", "ich", "der", "die", "das", "wo ", "ist", "hallo",
    "bildschirm", "ordner", "datei", "erste", "zweite", "dritte", "schau", "hilfe", "danke",
];

pub fn language(text: &str) -> Lang {
    let lower = format!(" {} ", text.to_lowercase());
    let german = text.contains(['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'])
        || GERMAN_HINTS.iter().any(|h| lower.contains(&format!(" {h}")) || lower.contains(&format!("{h} ")));
    if german {
        Lang::De
    } else {
        Lang::En
    }
}

const ORDINALS: &[(&str, usize)] = &[
    ("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("fifth", 5), ("sixth", 6), ("seventh", 7), ("eighth", 8), ("ninth", 9), ("tenth", 10),
    ("last", usize::MAX), ("erste", 1), ("ersten", 1), ("zweite", 2), ("zweiten", 2), ("dritte", 3), ("dritten", 3), ("vierte", 4), ("vierten", 4),
    ("fünfte", 5), ("fünften", 5), ("sechste", 6), ("siebte", 7), ("achte", 8), ("neunte", 9), ("zehnte", 10), ("letzte", usize::MAX),
    ("letzten", usize::MAX),
];

fn ordinal(words: &[&str]) -> Option<usize> {
    for (i, w) in words.iter().enumerate() {
        if let Some((_, n)) = ORDINALS.iter().find(|(o, _)| o == w) {
            return Some(*n);
        }
        // "number 3", "nummer 3", "#3", "3."
        let digits = w.trim_start_matches('#').trim_end_matches('.');
        if let Ok(n) = digits.parse::<usize>() {
            let previous = i.checked_sub(1).map(|p| words[p]);
            if (1..=50).contains(&n) && (words.len() <= 3 || matches!(previous, Some("number" | "nummer" | "nr" | "nr." | "result" | "ergebnis" | "open" | "öffne"))) {
                return Some(n);
            }
        }
    }
    None
}

/// "Hey NOVA, find my LEGO project" → Search("LEGO project").
pub fn parse(text: &str) -> Intent {
    let mut cleaned = text.trim().trim_end_matches(['.', '!', '?']).to_string();
    for prefix in ["hey nova", "hallo nova", "hi nova", "ok nova", "nova"] {
        if cleaned.to_lowercase().starts_with(prefix) {
            cleaned = cleaned[prefix.len()..].trim_start_matches([',', ' ', ':']).to_string();
            break;
        }
    }
    let lower = cleaned.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    if words.is_empty() || ["hi", "hello", "hallo", "hey", "servus", "moin", "guten tag"].contains(&lower.as_str()) {
        return Intent::Greeting;
    }
    if ["help", "hilfe", "what can you do", "was kannst du"].iter().any(|h| lower.starts_with(h)) {
        return Intent::Help;
    }
    if ["screen", "bildschirm", "screenshot"].iter().any(|k| lower.contains(k)) && ["look", "schau", "see", "sieh", "analy", "take", "mach"].iter().any(|k| lower.contains(k)) {
        return Intent::LookAtScreen;
    }
    let polite = lower.strip_prefix("bitte ").unwrap_or(&lower);
    if let Some((_, action)) = MEDIA.iter().find(|(phrase, _)| *phrase == polite) {
        return Intent::Media(*action);
    }
    // Only at the start: "das spiel" further along is about something else.
    let original = cleaned.get(lower.len() - polite.len()..).unwrap_or(&cleaned);
    for verb in ["spiele ", "spiel ", "play "] {
        if polite.starts_with(verb) {
            if let Some(mut query) = find_after(original, verb) {
                for tail in [" auf youtube ab", " auf youtube", " on youtube"] {
                    if query.to_lowercase().ends_with(tail) {
                        query.truncate(query.len() - tail.len());
                        return Intent::YouTube(query);
                    }
                }
                for tail in [" ab", " auf spotify", " on spotify"] {
                    if query.to_lowercase().ends_with(tail) {
                        query.truncate(query.len() - tail.len());
                    }
                }
                return Intent::Spotify(query);
            }
        }
    }
    for verb in ["google ", "googel "] {
        if polite.starts_with(verb) {
            if let Some(query) = original.get(verb.len()..).map(str::trim).filter(|q| !q.is_empty()) {
                return Intent::WebSearch(query.to_string());
            }
        }
    }
    const WEB: &[&str] = &["suche im internet nach ", "such im internet nach ", "suche im web nach ", "suche online nach ", "search the web for ", "search the internet for ", "search online for "];
    for verb in WEB {
        if let Some(rest) = find_after(&cleaned, verb) {
            return Intent::WebSearch(rest);
        }
    }
    const NEW_TASK: &[&str] = &["neue aufgabe: ", "neue aufgabe ", "aufgabe hinzufügen: ", "aufgabe hinzufügen ", "new task: ", "new task ", "add a task: ", "add a task ", "add task: ", "add task "];
    for verb in NEW_TASK {
        if let Some(rest) = find_after(&cleaned, verb) {
            return Intent::AddTask(rest);
        }
    }
    let refers_to_result = words.iter().any(|w| ["one", "result", "file", "eine", "ergebnis", "datei", "das", "die", "den"].contains(w)) || words.len() <= 3;
    if let Some(n) = ordinal(&words).filter(|_| refers_to_result) {
        if ["folder", "ordner", "explorer", "location", "speicherort"].iter().any(|k| lower.contains(k)) {
            return Intent::RevealResult(n);
        }
        if ["open", "öffne", "oeffne", "show", "zeig", "nimm", "take"].iter().any(|k| lower.contains(k)) || words.len() <= 3 {
            return Intent::OpenResult(n);
        }
    }
    const SEARCH: &[&str] = &[
        "where is ", "where are ", "search for ", "look for ", "find ", "search ", "wo ist ", "wo sind ", "suche nach ", "such nach ", "suche ", "such ",
        "finde ", "find mir ", "zeig mir ", "zeige mir ",
    ];
    for verb in SEARCH {
        if let Some(rest) = find_after(&cleaned, verb) {
            return Intent::Search(rest);
        }
    }
    const OPEN: &[&str] = &["open ", "start ", "launch ", "run ", "öffne ", "oeffne ", "starte ", "mach ", "öffnen ", "starten "];
    for verb in OPEN {
        if let Some(rest) = find_after(&cleaned, verb) {
            let rest = rest.trim_end_matches(" auf").trim_end_matches(" for me").trim_end_matches(" für mich").to_string();
            return Intent::Open(rest);
        }
    }
    Intent::Unknown
}

/// Text after `verb` (case-insensitive), without filler like "my" or "bitte".
fn find_after(text: &str, verb: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let at = if lower.starts_with(verb) { 0 } else { lower.find(&format!(" {verb}")).map(|i| i + 1)? };
    // Lower case can change a text's length ("İ"): the position then only fits the lower-case text.
    let rest = if lower.len() == text.len() { text.get(at + verb.len()..)? } else { &lower[at + verb.len()..] };
    let fillers = ["bitte", "please", "mal", "kurz", "for me", "mir"];
    let rest: Vec<&str> = rest.split_whitespace().filter(|w| !fillers.contains(&w.to_lowercase().as_str())).collect();
    let rest = rest.join(" ");
    (!rest.trim().is_empty()).then(|| rest.trim().to_string())
}


pub fn no_provider(lang: Lang) -> &'static str {
    match lang {
        Lang::De => "Dafür brauche ich ein KI-Modell. Verbinde einen Anbieter unter Einstellungen → KI-Anbieter (Anthropic, OpenAI oder Gemini). Ohne KI kann ich Dateien finden und Apps öffnen – zum Beispiel: „Finde meine LEGO-Berechnung“ oder „Öffne Spotify“.",
        Lang::En => "I need an AI model for that. Connect a provider in Settings → AI providers (Anthropic, OpenAI or Gemini). Without one I can still find files and open apps — try “Find my LEGO calculation” or “Open Spotify”.",
    }
}

pub fn greeting(lang: Lang) -> &'static str {
    match lang {
        Lang::De => "Hallo! Ich bin NOVA. Ich kann Dateien finden, Apps öffnen, Dokumente erstellen und – mit Erlaubnis – auf deinen Bildschirm schauen. Was kann ich tun?",
        Lang::En => "Hi! I'm NOVA. I can find files, open apps, create documents and — with your permission — look at your screen. What can I do for you?",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_that_change_length_in_lower_case_dont_crash_it() {
        assert_eq!(find_after("İ find ü", "find "), Some("ü".into()));
        assert_eq!(find_after("ẞ öffne Spotify", "öffne "), Some("spotify".into()));
    }

    #[test]
    fn recognizes_searches_in_both_languages() {
        assert_eq!(parse("Hey NOVA, find my LEGO calculation"), Intent::Search("my LEGO calculation".into()));
        assert_eq!(parse("Finde bitte meine LEGO-Berechnung"), Intent::Search("meine LEGO-Berechnung".into()));
        assert_eq!(parse("Wo ist das Bild von meinem Hogwarts-Schloss?"), Intent::Search("das Bild von meinem Hogwarts-Schloss".into()));
        assert_eq!(parse("search for the PDF about my 3D printer"), Intent::Search("the PDF about my 3D printer".into()));
    }

    #[test]
    fn recognizes_follow_ups_on_results() {
        assert_eq!(parse("Open the third one"), Intent::OpenResult(3));
        assert_eq!(parse("Öffne die zweite"), Intent::OpenResult(2));
        assert_eq!(parse("öffne nummer 4"), Intent::OpenResult(4));
        assert_eq!(parse("zeig mir den Ordner der ersten Datei"), Intent::RevealResult(1));
        assert_eq!(parse("die letzte"), Intent::OpenResult(usize::MAX));
    }

    #[test]
    fn recognizes_music_web_and_tasks() {
        assert_eq!(parse("Lauter"), Intent::Media("volume_up"));
        assert_eq!(parse("Hey NOVA, nächster Titel"), Intent::Media("next"));
        assert_eq!(parse("bitte pause!"), Intent::Media("pause"));
        assert_eq!(parse("Spiele Entspannungsmusik"), Intent::Spotify("Entspannungsmusik".into()));
        assert_eq!(parse("Nova, spiel bitte Daft Punk auf Spotify ab"), Intent::Spotify("Daft Punk".into()));
        assert_eq!(parse("play Daft Punk on Spotify"), Intent::Spotify("Daft Punk".into()));
        assert_eq!(parse("Suche im Internet nach Kino Köln"), Intent::WebSearch("Kino Köln".into()));
        assert_eq!(parse("google Wetter Köln"), Intent::WebSearch("Wetter Köln".into()));
        assert_eq!(parse("Neue Aufgabe: Müll rausbringen"), Intent::AddTask("Müll rausbringen".into()));
        assert_eq!(parse("add task call Sam"), Intent::AddTask("call Sam".into()));
        // Not taken for music or the web.
        assert_eq!(parse("Wo ist das Spiel Hogwarts"), Intent::Search("das Spiel Hogwarts".into()));
        assert_eq!(parse("Öffne Google Chrome"), Intent::Open("Google Chrome".into()));
    }

    #[test]
    fn recognizes_apps_screen_and_small_talk() {
        assert_eq!(parse("Öffne Spotify"), Intent::Open("Spotify".into()));
        assert_eq!(parse("starte bitte Word"), Intent::Open("Word".into()));
        assert_eq!(parse("Hey NOVA, look at my screen"), Intent::LookAtScreen);
        assert_eq!(parse("Schau mal auf meinen Bildschirm"), Intent::LookAtScreen);
        assert_eq!(parse("Hallo"), Intent::Greeting);
        assert_eq!(parse("Write a poem about autumn"), Intent::Unknown);
    }

    #[test]
    fn detects_the_language() {
        assert_eq!(language("Finde meine Datei"), Lang::De);
        assert_eq!(language("Größe"), Lang::De);
        assert_eq!(language("Find my file"), Lang::En);
    }
}
