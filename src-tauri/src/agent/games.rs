//! Game settings: the plain settings files games keep in the user's folders.
//! NOVA changes those and nothing else, never a game's own files, so it stays
//! clear of anti-cheat. A game has to be closed: it writes its settings back on exit.

use std::path::{Path, PathBuf};

const LONGEST_VALUE: usize = 200;
/// What the model gets of one file; Fortnite's alone is over 30 KB.
const LONGEST_LISTING: usize = 14_000;
/// Settings people mean, for files too long to show whole.
const USEFUL: &[&str] = &[
    "quality", "resolution", "framerate", "fps", "vsync", "fullscreen", "windowed", "scalab", "motionblur", "shadow", "nvidia", "reflex", "raytrac", "dlss", "fsr", "tsr", "nanite", "lumen", "rhi",
    "brightness", "gamma", "volume", "sensitiv", "viewdistance", "fov", "antialias", "texture", "effects", "postprocess", "foliage", "graphics", "render",
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Style {
    /// `Key=Value` under `[Section]`.
    Ini,
    /// Minecraft's `key:value`.
    Colon,
}

impl Style {
    fn separator(self) -> char {
        match self {
            Style::Ini => '=',
            Style::Colon => ':',
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Game {
    pub name: String,
    pub path: PathBuf,
    pub style: Style,
    /// Lower-case letters and digits of its name, to recognize it running.
    key: String,
    /// Its process has a generic name (Java), so its window title tells.
    by_window: bool,
}

fn letters(text: &str) -> String {
    text.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// "FortniteGame" → "Fortnite".
fn game_name(folder: &str) -> String {
    folder.strip_suffix("Game").filter(|n| !n.is_empty()).unwrap_or(folder).to_string()
}

fn game(name: String, path: PathBuf, style: Style, by_window: bool) -> Game {
    Game { key: letters(&name), name, path, style, by_window }
}

/// Unreal Engine games in `local` (Fortnite, Valorant and many more all keep their settings there).
fn unreal_games(local: &Path) -> Vec<Game> {
    let mut games = Vec::new();
    let Ok(folders) = std::fs::read_dir(local) else { return games };
    for folder in folders.flatten() {
        let config = folder.path().join("Saved").join("Config");
        let found = ["WindowsClient", "Windows", "WindowsNoEditor"].iter().map(|variant| config.join(variant).join("GameUserSettings.ini")).find(|file| file.is_file());
        if let Some(file) = found {
            games.push(game(game_name(&folder.file_name().to_string_lossy()), file, Style::Ini, false));
        }
    }
    games
}

/// Every game on this PC whose settings NOVA can change.
pub fn installed() -> Vec<Game> {
    let mut games = std::env::var_os("LOCALAPPDATA").map(|local| unreal_games(Path::new(&local))).unwrap_or_default();
    if let Some(file) = std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join(".minecraft").join("options.txt")).filter(|file| file.is_file()) {
        games.push(game("Minecraft".into(), file, Style::Colon, true));
    }
    // Documents may have moved to OneDrive, so Windows says where it is.
    let documents = crate::files::known_folders().into_iter().find(|folder| folder.id == "documents").map(|folder| PathBuf::from(folder.path));
    if let Some(file) = documents.map(|documents| documents.join("My Games").join("Rocket League").join("TAGame").join("Config").join("TASystemSettings.ini")).filter(|file| file.is_file()) {
        games.push(game("Rocket League".into(), file, Style::Ini, false));
    }
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

pub fn pick(games: &[Game], wanted: &str) -> Result<Game, String> {
    let wanted = letters(wanted);
    if wanted.is_empty() {
        return Err("Say which game".into());
    }
    let names = || games.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", ");
    if let Some(exact) = games.iter().find(|g| g.key == wanted) {
        return Ok(exact.clone());
    }
    let matches: Vec<&Game> = games.iter().filter(|g| g.key.contains(&wanted) || wanted.contains(&g.key)).collect();
    match matches.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!("NOVA found no settings file for that game. It knows these: {}.", names())),
        several => Err(format!("That could be {}.", several.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

// ---------------------------------------------------------------------------
// Starting games
// ---------------------------------------------------------------------------

/// A game installed through a launcher, started by the launcher's own link.
#[derive(Debug, Clone, PartialEq)]
pub struct Installed {
    pub name: String,
    pub launcher: &'static str,
    pub link: String,
    /// Fully installed; otherwise the launcher still has to download or update it.
    pub ready: bool,
}

/// Steam's own parts that show up beside the games.
const STEAM_NOT_GAMES: &[&str] = &["steamworks common redistributables", "steam linux runtime", "steamvr", "proton"];

/// One `.item` file of the Epic Games Launcher.
fn parse_epic_manifest(text: &str) -> Option<Installed> {
    let item: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let name = item["DisplayName"].as_str()?.trim();
    let part = |key: &str| item[key].as_str().map(crate::shell::encode_query).filter(|p| !p.is_empty());
    let (namespace, id, app) = (part("CatalogNamespace")?, part("CatalogItemId")?, part("AppName")?);
    // Add-ons have manifests too; they point at their game instead of being one.
    if name.is_empty() || item["bIsApplication"].as_bool() == Some(false) || item["MainGameAppName"].as_str().is_some_and(|main| !main.is_empty() && main != item["AppName"].as_str().unwrap_or_default()) {
        return None;
    }
    Some(Installed {
        name: name.to_string(),
        launcher: "Epic Games",
        link: format!("com.epicgames.launcher://apps/{namespace}%3A{id}%3A{app}?action=launch&silent=true"),
        ready: !item["bIsIncompleteInstall"].as_bool().unwrap_or(false),
    })
}

/// The value of `"key" "value"` in one of Steam's text files, in the first place it appears.
fn steam_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let mut parts = line.split('"').skip(1).step_by(2);
        (parts.next()?.eq_ignore_ascii_case(key)).then(|| parts.next()).flatten()
    })
}

/// One `appmanifest_*.acf` of Steam.
fn parse_steam_manifest(text: &str) -> Option<Installed> {
    let id = steam_value(text, "appid").filter(|id| id.chars().all(|c| c.is_ascii_digit()) && !id.is_empty())?;
    let name = steam_value(text, "name")?.trim();
    let lower = name.to_lowercase();
    if name.is_empty() || STEAM_NOT_GAMES.iter().any(|part| lower.starts_with(part)) {
        return None;
    }
    // Bit 4 of StateFlags: fully installed, and nothing else (updating, downloading) going on.
    let ready = steam_value(text, "StateFlags") == Some("4");
    Some(Installed { name: name.to_string(), launcher: "Steam", link: format!("steam://rungameid/{id}"), ready })
}

/// The folders of `libraryfolders.vdf`, where Steam keeps games on other drives.
fn steam_library_folders(text: &str) -> Vec<PathBuf> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('"').skip(1).step_by(2);
            parts.next()?.eq_ignore_ascii_case("path").then(|| parts.next()).flatten()
        })
        .map(|path| PathBuf::from(path.replace("\\\\", "\\")))
        .collect()
}

fn epic_games() -> Vec<Installed> {
    let Some(data) = std::env::var_os("ProgramData") else { return Vec::new() };
    let Ok(files) = std::fs::read_dir(Path::new(&data).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")) else { return Vec::new() };
    files.flatten().filter(|file| file.path().extension().is_some_and(|e| e.eq_ignore_ascii_case("item"))).filter_map(|file| parse_epic_manifest(&std::fs::read_to_string(file.path()).ok()?)).collect()
}

fn steam_games() -> Vec<Installed> {
    let Some(steam) = crate::agent::pc::steam_folder() else { return Vec::new() };
    let mut libraries = vec![steam.clone()];
    if let Ok(text) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
        libraries.extend(steam_library_folders(&text));
    }
    let mut seen = std::collections::HashSet::new();
    // Steam writes the same folder as c:/program files and as C:\\Program Files.
    libraries.retain(|library| seen.insert(library.to_string_lossy().replace('/', "\\").to_lowercase()));
    let mut games = Vec::new();
    for library in libraries {
        let Ok(files) = std::fs::read_dir(library.join("steamapps")) else { continue };
        for file in files.flatten() {
            if file.file_name().to_string_lossy().starts_with("appmanifest_") {
                games.extend(std::fs::read_to_string(file.path()).ok().and_then(|text| parse_steam_manifest(&text)));
            }
        }
    }
    games
}

/// The games Epic and Steam have installed on this PC.
pub fn library() -> Vec<Installed> {
    let mut games = epic_games();
    games.extend(steam_games());
    games.sort_by_key(|game| game.name.to_lowercase());
    games
}

pub fn pick_installed(games: &[Installed], wanted: &str) -> Result<Installed, String> {
    let wanted = letters(wanted);
    if wanted.is_empty() {
        return Err("Say which game".into());
    }
    if let Some(exact) = games.iter().find(|g| letters(&g.name) == wanted) {
        return Ok(exact.clone());
    }
    let matches: Vec<&Installed> = games.iter().filter(|g| letters(&g.name).contains(&wanted) || wanted.contains(&letters(&g.name))).collect();
    match matches.as_slice() {
        [one] => Ok((*one).clone()),
        [] if games.is_empty() => Err("No games from Epic or Steam were found on this PC. For other launchers try open_app.".into()),
        [] => Err(format!("That game isn't installed through Epic or Steam. Installed: {}. For other launchers try open_app.", games.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "))),
        several => Err(format!("That could be {}.", several.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "))),
    }
}

/// Whether `game` runs, from the lower-case names of the running processes and the window titles.
pub fn is_running(game: &Game, processes: &[String], titles: &[String]) -> bool {
    if game.by_window {
        // "Minecraft 1.21.4", not a browser tab about it.
        return titles.iter().any(|title| letters(title).strip_prefix(&game.key).is_some_and(|rest| rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit())));
    }
    processes.iter().any(|process| letters(process).contains(&game.key))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16,
}

fn decode(bytes: &[u8]) -> Result<(String, Encoding), String> {
    if let Some(wide) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = wide.as_chunks::<2>().0.iter().map(|pair| u16::from_le_bytes(*pair)).collect();
        return Ok((String::from_utf16_lossy(&units), Encoding::Utf16));
    }
    let (rest, encoding) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).map_or((bytes, Encoding::Utf8), |rest| (rest, Encoding::Utf8Bom));
    let text = std::str::from_utf8(rest).map_err(|_| "This settings file isn't plain text, so NOVA leaves it alone".to_string())?;
    Ok((text.to_string(), encoding))
}

fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF], text.as_bytes()].concat(),
        Encoding::Utf16 => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect(),
    }
}

/// `(section, key, value)` for a settings line.
fn parse_line<'a>(line: &'a str, style: Style, section: &'a str) -> Option<(&'a str, &'a str, &'a str)> {
    let trimmed = line.trim_end_matches('\r');
    if trimmed.is_empty() || trimmed.starts_with([';', '#', '[']) {
        return None;
    }
    let (key, value) = trimmed.split_once(style.separator())?;
    Some((section, key.trim(), value))
}

fn section_of(line: &str) -> Option<&str> {
    line.trim_end_matches('\r').strip_prefix('[')?.strip_suffix(']')
}

/// The settings as lines for the model: those matching `search`, or the whole
/// file while it is short, or the ones people usually mean.
pub fn listing(text: &str, style: Style, search: Option<&str>) -> String {
    let search = search.map(str::to_lowercase);
    let mut section = "";
    let mut all = Vec::new();
    for line in text.lines() {
        if let Some(name) = section_of(line) {
            section = name;
        } else if let Some((in_section, key, value)) = parse_line(line, style, section) {
            all.push((in_section, key, value));
        }
    }
    let total: usize = all.iter().map(|(s, k, v)| s.len() + k.len() + v.len() + 4).sum();
    let wanted = |key: &str, value: &str| match &search {
        Some(search) => key.to_lowercase().contains(search) || value.to_lowercase().contains(search),
        None => total <= LONGEST_LISTING || USEFUL.iter().any(|word| key.to_lowercase().contains(word)),
    };
    let mut out = String::new();
    let mut shown = "\0";
    let mut hidden = 0;
    for (in_section, key, value) in &all {
        if !wanted(key, value) {
            hidden += 1;
            continue;
        }
        if out.len() >= LONGEST_LISTING {
            out.push_str("… (cut off; search for a setting by name)\n");
            break;
        }
        if *in_section != shown {
            shown = in_section;
            if !in_section.is_empty() {
                out.push_str(&format!("[{in_section}]\n"));
            }
        }
        out.push_str(&format!("{key} = {value}\n"));
    }
    if hidden > 0 && search.is_none() {
        out.push_str(&format!("({hidden} less common settings not shown; search for one by name.)\n"));
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub section: Option<String>,
    pub key: String,
    pub value: String,
}

/// The file's text with `changes` made, and what each was before.
/// Only the changed lines differ. A new setting needs a section to go in.
pub fn apply(text: &str, style: Style, changes: &[Change]) -> Result<(String, Vec<String>), String> {
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let mut said = Vec::new();
    for change in changes {
        if change.key.is_empty() || change.key.contains([style.separator(), '\r', '\n', '[', ']']) {
            return Err(format!("“{}” isn't a setting's name", change.key));
        }
        if change.value.chars().count() > LONGEST_VALUE || change.value.contains(['\r', '\n']) {
            return Err(format!("That isn't a usable value for {}", change.key));
        }
        let mut section = String::new();
        let mut found: Vec<(usize, String, String)> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if let Some(name) = section_of(line) {
                section = name.to_string();
            } else if let Some((_, key, value)) = parse_line(line, style, "") {
                let in_wanted = change.section.as_deref().is_none_or(|wanted| wanted.eq_ignore_ascii_case(&section));
                if key.eq_ignore_ascii_case(&change.key) && in_wanted {
                    found.push((index, section.clone(), value.to_string()));
                }
            }
        }
        match found.as_slice() {
            [(index, _, old)] => {
                let ending = if lines[*index].ends_with('\r') { "\r" } else { "" };
                let key = lines[*index].split(style.separator()).next().unwrap_or(&change.key).to_string();
                lines[*index] = format!("{key}{}{}{ending}", style.separator(), change.value);
                said.push(format!("{}: {old} → {}", change.key, change.value));
            }
            [] => {
                let Some(wanted) = &change.section else {
                    return Err(format!("{} isn't in the file. Look it up with game_settings, or name the section to add it.", change.key));
                };
                let at = lines.iter().position(|line| section_of(line).is_some_and(|name| name.eq_ignore_ascii_case(wanted))).ok_or_else(|| format!("The file has no section [{wanted}]"))?;
                let ending = if lines[at].ends_with('\r') { "\r" } else { "" };
                lines.insert(at + 1, format!("{}{}{}{ending}", change.key, style.separator(), change.value));
                said.push(format!("{}: added as {}", change.key, change.value));
            }
            several => {
                let sections: Vec<&str> = several.iter().map(|(_, section, _)| section.as_str()).collect();
                return Err(format!("{} is there {} times ({}). Name the section.", change.key, several.len(), sections.join(", ")));
            }
        }
    }
    Ok((lines.join("\n"), said))
}

pub fn read(game: &Game) -> Result<String, String> {
    let bytes = std::fs::read(&game.path).map_err(|e| format!("Couldn't read {}'s settings: {e}", game.name))?;
    Ok(decode(&bytes)?.0)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".nova-backup");
    PathBuf::from(name)
}

/// Makes `changes` in the file. The first time, the file as it was is kept next to it.
pub fn write(game: &Game, changes: &[Change]) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(&game.path).map_err(|e| format!("Couldn't read {}'s settings: {e}", game.name))?;
    let (text, encoding) = decode(&bytes)?;
    let (changed, said) = apply(&text, game.style, changes)?;
    let backup = backup_path(&game.path);
    if !backup.exists() {
        std::fs::write(&backup, &bytes).map_err(|e| format!("Couldn't keep a backup, so nothing changed: {e}"))?;
    }
    std::fs::write(&game.path, encode(&changed, encoding)).map_err(|e| format!("Couldn't write {}'s settings (is the file read-only?): {e}", game.name))?;
    Ok(said)
}

pub fn has_backup(game: &Game) -> bool {
    backup_path(&game.path).is_file()
}

/// Puts the file back as it was before NOVA first changed it.
pub fn restore(game: &Game) -> Result<(), String> {
    std::fs::copy(backup_path(&game.path), &game.path).map(|_| ()).map_err(|e| format!("Couldn't restore {}'s settings: {e}", game.name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const INI: &str = ";METADATA=(Diff=true)\r\n[/Script/FortniteGame.FortGameUserSettings]\r\nbUseVSync=False\r\nFrameRateLimit=60.000000\r\n\r\n[ScalabilityGroups]\r\nsg.ShadowQuality=2\r\nsg.TextureQuality=2\r\n";

    fn change(key: &str, value: &str) -> Change {
        Change { section: None, key: key.into(), value: value.into() }
    }

    fn fake(name: &str, style: Style, by_window: bool) -> Game {
        game(name.into(), PathBuf::from("x"), style, by_window)
    }

    #[test]
    fn reads_what_the_launchers_know_about_their_games() {
        let fortnite = r#"{"DisplayName":"Fortnite","AppName":"Fortnite","CatalogNamespace":"fn","CatalogItemId":"4fe75bbc5a674f4f9b356b5c90567da5","bIsIncompleteInstall":false,"bIsApplication":true,"MainGameAppName":"Fortnite"}"#;
        let game = parse_epic_manifest(fortnite).unwrap();
        assert_eq!(game.link, "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true");
        assert!(game.ready);
        assert!(!parse_epic_manifest(&fortnite.replace(r#""bIsIncompleteInstall":false"#, r#""bIsIncompleteInstall":true"#)).unwrap().ready);
        assert_eq!(parse_epic_manifest(&fortnite.replace(r#""MainGameAppName":"Fortnite""#, r#""MainGameAppName":"Other""#)), None, "an add-on");
        assert_eq!(parse_epic_manifest("kaputt"), None);
        // As the launcher really writes it: no main game, or an empty one.
        assert!(parse_epic_manifest(&fortnite.replace(r#""MainGameAppName":"Fortnite""#, r#""MainGameAppName":"""#)).is_some());
        assert!(parse_epic_manifest(&fortnite.replace(r#","MainGameAppName":"Fortnite""#, "")).is_some());
        assert_eq!(parse_epic_manifest(&fortnite.replace(r#""bIsApplication":true"#, r#""bIsApplication":false"#)), None, "Unreal Engine itself");

        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"StateFlags\"\t\t\"4\"\n}";
        let game = parse_steam_manifest(acf).unwrap();
        assert_eq!((game.name.as_str(), game.link.as_str(), game.ready), ("Counter-Strike 2", "steam://rungameid/730", true));
        assert!(!parse_steam_manifest(&acf.replace("\"4\"", "\"6\"")).unwrap().ready, "needs an update");
        assert_eq!(parse_steam_manifest(&acf.replace("Counter-Strike 2", "Steamworks Common Redistributables")), None);

        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\Games\"\n\t}\n}";
        assert_eq!(steam_library_folders(vdf), [PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\Games")]);
    }

    #[test]
    fn picks_the_game_that_was_asked_for() {
        let game = |name: &str| Installed { name: name.into(), launcher: "Steam", link: String::new(), ready: true };
        let games = [game("Fortnite"), game("Rocket League"), game("Dark Souls II"), game("Dark Souls III")];
        assert_eq!(pick_installed(&games, "fortnite").unwrap().name, "Fortnite");
        assert_eq!(pick_installed(&games, "rocket").unwrap().name, "Rocket League");
        assert_eq!(pick_installed(&games, "dark souls iii").unwrap().name, "Dark Souls III");
        assert!(pick_installed(&games, "dark souls").unwrap_err().contains("could be"));
        assert!(pick_installed(&games, "tetris").unwrap_err().contains("Installed: Fortnite"));
    }

    #[test]
    fn changes_only_the_lines_asked_for() {
        let (changed, said) = apply(INI, Style::Ini, &[change("sg.ShadowQuality", "0"), change("framerateLIMIT", "144.000000")]).unwrap();
        assert_eq!(changed, INI.replace("sg.ShadowQuality=2", "sg.ShadowQuality=0").replace("FrameRateLimit=60.000000", "FrameRateLimit=144.000000"));
        assert_eq!(said, ["sg.ShadowQuality: 2 → 0", "framerateLIMIT: 60.000000 → 144.000000"]);
    }

    #[test]
    fn adds_a_setting_only_where_it_is_told_to() {
        assert!(apply(INI, Style::Ini, &[change("sg.FoliageQuality", "0")]).unwrap_err().contains("isn't in the file"));
        let new = Change { section: Some("ScalabilityGroups".into()), ..change("sg.FoliageQuality", "0") };
        let (changed, _) = apply(INI, Style::Ini, std::slice::from_ref(&new)).unwrap();
        assert!(changed.contains("[ScalabilityGroups]\r\nsg.FoliageQuality=0\r\nsg.ShadowQuality=2"));
        assert!(apply(INI, Style::Ini, &[Change { section: Some("Nope".into()), ..new }]).unwrap_err().contains("no section"));
    }

    #[test]
    fn refuses_what_would_break_the_file() {
        assert!(apply(INI, Style::Ini, &[change("a=b", "1")]).is_err());
        assert!(apply(INI, Style::Ini, &[change("bUseVSync", "True\r\n[Evil]")]).is_err());
        assert!(apply(INI, Style::Ini, &[change("bUseVSync", &"x".repeat(LONGEST_VALUE + 1))]).is_err());
    }

    #[test]
    fn asks_which_section_when_a_key_is_there_twice() {
        let twice = "[A]\nx=1\n[B]\nx=2\n";
        assert!(apply(twice, Style::Ini, &[change("x", "9")]).unwrap_err().contains("A, B"));
        let (changed, _) = apply(twice, Style::Ini, &[Change { section: Some("b".into()), ..change("x", "9") }]).unwrap();
        assert_eq!(changed, "[A]\nx=1\n[B]\nx=9\n");
    }

    #[test]
    fn handles_minecrafts_format() {
        let (changed, said) = apply("version:4790\nrenderDistance:12\n", Style::Colon, &[change("renderDistance", "32")]).unwrap();
        assert_eq!(changed, "version:4790\nrenderDistance:32\n");
        assert_eq!(said, ["renderDistance: 12 → 32"]);
    }

    #[test]
    fn keeps_a_files_encoding() {
        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16] {
            let bytes = encode(INI, encoding);
            assert_eq!(decode(&bytes).unwrap(), (INI.to_string(), encoding));
        }
        assert!(decode(&[0xC0, 0x00, 0xFF]).is_err());
    }

    #[test]
    fn lists_what_matters_in_long_files_and_finds_the_rest() {
        let mut long = String::from("[Stuff]\n");
        for i in 0..3000 {
            long.push_str(&format!("LastSeenThing{i}=2026.11.06\n"));
        }
        long.push_str("[ScalabilityGroups]\nsg.ShadowQuality=2\n");
        let shown = listing(&long, Style::Ini, None);
        assert!(shown.contains("[ScalabilityGroups]\nsg.ShadowQuality = 2") && !shown.contains("LastSeenThing7"));
        assert!(shown.contains("3000 less common"));
        assert_eq!(listing(&long, Style::Ini, Some("LastSeenThing2999")), "[Stuff]\nLastSeenThing2999 = 2026.11.06\n");
        assert!(listing(INI, Style::Ini, None).contains("bUseVSync = False"));
    }

    #[test]
    fn picks_a_game_by_what_people_call_it() {
        let games = [fake("Fortnite", Style::Ini, false), fake("Ride", Style::Ini, false), fake("Rocket League", Style::Ini, false)];
        assert_eq!(pick(&games, "fortnite").unwrap().name, "Fortnite");
        assert_eq!(pick(&games, "in Fortnite Battle Royale").unwrap().name, "Fortnite");
        assert_eq!(pick(&games, "rocket").unwrap().name, "Rocket League");
        assert!(pick(&games, "Halo").unwrap_err().contains("Fortnite, Ride, Rocket League"));
        assert!(pick(&games, "").is_err());
        assert_eq!(game_name("FortniteGame"), "Fortnite");
        assert_eq!(game_name("Game"), "Game");
    }

    #[test]
    fn sees_when_a_game_runs() {
        let fortnite = fake("Fortnite", Style::Ini, false);
        assert!(is_running(&fortnite, &["fortniteclient-win64-shipping".into()], &[]));
        assert!(!is_running(&fortnite, &["epicgameslauncher".into()], &["Fortnite Einstellungen - Opera".into()]));
        let minecraft = fake("Minecraft", Style::Colon, true);
        assert!(is_running(&minecraft, &["javaw".into()], &["Minecraft 1.21.4".into()]));
        assert!(!is_running(&minecraft, &["javaw".into()], &["Minecraft Tipps - Opera".into(), "Notepad".into()]));
    }

    #[test]
    fn writes_keeps_the_first_backup_and_restores_it() {
        let dir = std::env::temp_dir().join(format!("nova-games-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("GameUserSettings.ini");
        std::fs::write(&path, INI).unwrap();
        let game = Game { path: path.clone(), ..fake("Fortnite", Style::Ini, false) };
        assert!(!has_backup(&game));
        write(&game, &[change("sg.ShadowQuality", "0")]).unwrap();
        write(&game, &[change("sg.ShadowQuality", "1")]).unwrap();
        assert!(read(&game).unwrap().contains("sg.ShadowQuality=1"));
        restore(&game).unwrap();
        assert_eq!(read(&game).unwrap(), INI);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Reads this PC's real settings files and changes only a copy of them.
    /// `cargo test -- --ignored real_game_files --nocapture`
    #[test]
    #[ignore]
    fn real_game_files() {
        let games = installed();
        eprintln!("{} games: {}", games.len(), games.iter().map(|g| g.name.as_str()).collect::<Vec<_>>().join(", "));
        for game in &games {
            let bytes = std::fs::read(&game.path).unwrap();
            let (text, encoding) = decode(&bytes).unwrap_or_else(|e| panic!("{}: {e}", game.name));
            assert_eq!(encode(&text, encoding), bytes, "{} must come back byte for byte", game.name);
        }
        let fortnite = pick(&games, "fortnite").unwrap();
        let text = read(&fortnite).unwrap();
        eprintln!("--- as the model sees it\n{}", listing(&text, fortnite.style, None));
        let (changed, said) = apply(&text, fortnite.style, &[change("sg.ShadowQuality", "0"), change("FrameRateLimit", "144.000000")]).unwrap();
        eprintln!("--- {said:?}");
        let before: Vec<&str> = text.split('\n').collect();
        let after: Vec<&str> = changed.split('\n').collect();
        assert_eq!(before.len(), after.len());
        let different = before.iter().zip(&after).filter(|(a, b)| a != b).count();
        assert_eq!(different, 2, "only the two lines differ");
    }

    #[test]
    fn finds_unreal_games_in_their_folders() {
        let dir = std::env::temp_dir().join(format!("nova-games-found-{}", std::process::id()));
        let config = dir.join("FortniteGame").join("Saved").join("Config").join("WindowsClient");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("GameUserSettings.ini"), INI).unwrap();
        std::fs::create_dir_all(dir.join("SomeApp")).unwrap();
        let found = unreal_games(&dir);
        assert_eq!(found.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Fortnite"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
