//! What a task from the phone may do. Checked on the PC for every tool call, after
//! `tools::prepare` validated the arguments; the phone's own view is only a display.
//!
//! SECURITY: the match below has no catch-all arm on purpose. A new tool action
//! doesn't compile until someone decides its tier here.

use serde::{Deserialize, Serialize};

use super::protocol::Tier;
use crate::agent::tools::Action;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AllowedKind {
    App,
    Game,
}

/// An app or game the user lets the phone start without a fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedApp {
    pub kind: AllowedKind,
    /// The app catalog id, or the launcher link of a game.
    pub id: String,
    pub name: String,
}

fn allowed(list: &[AllowedApp], kind: AllowedKind, id: &str) -> bool {
    list.iter().any(|entry| entry.kind == kind && entry.id == id)
}

/// Why something is never done from the phone, for the model to pass on.
pub const NEVER_FROM_PHONE: &str = "Not allowed from the phone: this only works at the PC. Tell the user in one short sentence that they can do it at the PC.";

pub fn tier(action: &Action, allowlist: &[AllowedApp]) -> Tier {
    use Action::*;
    match action {
        // Questions, status and looking: free.
        Search(_) | List(_) | SystemInfo | LookAtScreen(_) | ListTasks { .. } | NowPlaying | TaskManager | InstalledPrograms | ListWindows | ListGames
        | GameSettings { .. } | FindJunk | ListInstalledGames | ListTimers | Weather(_) | InternetSpeed | YoutubeSearch(_) | YoutubeChannel(_)
        | YoutubeAbout(_) | ListAudioApps | ListOutputs | ListRoutines | ListWatchers | ListMemory | PcCheck | GameTime | RecentLoad | VirusScanStatus
        | ReadWebpage(_) => Tier::Free,
        // Chosen by the user as free (2026-11-08): music controls, timers, websites.
        Media { .. } | SetTimer { .. } | CancelTimers(_) | OpenUrl(_) => Tier::Free,
        // Calling off a shutdown only makes things safer.
        CancelPower => Tier::Free,
        // "Sag Bescheid, wenn …": only a notice. With a routine attached it would act by itself later.
        StartWatching { input, .. } => {
            if input["routine"].is_string() {
                Tier::Never
            } else {
                Tier::Free
            }
        }
        OpenApp { id, .. } => {
            if allowed(allowlist, AllowedKind::App, id) {
                Tier::Free
            } else {
                Tier::Approve
            }
        }
        StartGame(game) => {
            if allowed(allowlist, AllowedKind::Game, &game.link) {
                Tier::Free
            } else {
                Tier::Approve
            }
        }
        // Changes, private reads and typing into other apps: fingerprint on the phone.
        Open(_) | Reveal(_) | CreateDocument { .. } | CreateFolder(_) | Move { .. } | Rename { .. } | Delete(_) | SearchWeb(_) | AddTask { .. }
        | CompleteTask(_) | AddNote { .. } | AddProject(_) | SpotifySearch(_) | EndProcess { .. } | Window { .. } | ReadWindow(_) | SendInput { .. }
        | UseElement { .. } | SpotifyPlay { .. } | SpotifyPlayFromLibrary(_) | SpotifyLibrary | ChangeGameSettings { .. } | RestoreGameSettings(_)
        | VirusScan(_) | CleanUp { .. } | Uninstall { .. } | Power { .. } | ReadClipboard | CopyToClipboard(_) | YoutubePlay(_) | YoutubeKey(_)
        | SetAudioApp { .. } | SetOutput(_) | RunRoutine(_) | StopWatching(_) | Remember(_) | Forget(_) | Tidy(_) | UndoTidy | ReadFile { .. }
        | BrowserRead(_) | Clip { .. } | SendClip(_) => Tier::Approve,
        // Never from the phone: lasting automation (a setting), changes to the Spotify
        // account, and working websites (buying and signing in can't be ruled out in code).
        SaveRoutine(_) | DeleteRoutine(_) | SpotifyControl(_) | BrowserUse { .. } => Tier::Never,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;
    use crate::agent::auto::Routine;

    fn app(id: &str) -> Action {
        Action::OpenApp { id: id.into(), name: "Spotify".into() }
    }

    #[test]
    fn apps_are_free_only_on_the_allowlist() {
        let list = vec![AllowedApp { kind: AllowedKind::App, id: "spotify".into(), name: "Spotify".into() }];
        assert_eq!(tier(&app("spotify"), &list), Tier::Free);
        assert_eq!(tier(&app("cmd"), &list), Tier::Approve);
        assert_eq!(tier(&app("spotify"), &[]), Tier::Approve);
        // A game with the same id as an allowed app is not allowed.
        let game = vec![AllowedApp { kind: AllowedKind::Game, id: "spotify".into(), name: "x".into() }];
        assert_eq!(tier(&app("spotify"), &game), Tier::Approve);
    }

    #[test]
    fn questions_are_free_and_changes_need_approval() {
        assert_eq!(tier(&Action::SystemInfo, &[]), Tier::Free);
        assert_eq!(tier(&Action::LookAtScreen(crate::capture::Target::Window), &[]), Tier::Free);
        assert_eq!(tier(&Action::OpenUrl("https://example.com".into()), &[]), Tier::Free);
        assert_eq!(tier(&Action::Delete(PathBuf::from("C:/x")), &[]), Tier::Approve);
        assert_eq!(tier(&Action::EndProcess { name: "steam".into(), pids: vec![1], force: false }, &[]), Tier::Approve);
        assert_eq!(tier(&Action::ReadClipboard, &[]), Tier::Approve);
    }

    #[test]
    fn lasting_automation_and_websites_are_never_from_the_phone() {
        assert_eq!(tier(&Action::SaveRoutine(Routine::default()), &[]), Tier::Never);
        assert_eq!(tier(&Action::StartWatching { what: "game_ready".into(), input: json!({ "routine": "Gaming" }) }, &[]), Tier::Never);
        assert_eq!(tier(&Action::StartWatching { what: "game_ready".into(), input: json!({ "game": "Fortnite" }) }, &[]), Tier::Free);
        let window = crate::agent::pc::Target { hwnd: 1, pid: 1, label: "Browser".into() };
        let browse = Action::BrowserUse { target: window, element: "Kaufen".into(), kind: None, index: 0, text: None, submit: true };
        assert_eq!(tier(&browse, &[]), Tier::Never);
    }
}
