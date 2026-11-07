mod agent;
mod ai;
mod apps;
mod assistant;
mod capture;
mod credentials;
mod desktop;
mod documents;
mod files;
mod finder;
mod http;
mod live;
mod media;
mod shell;
pub mod speech;
mod storage;
mod system;
mod backdrop;
mod online_voice;
mod scan;
mod tts;
mod turnlog;
mod updates;
mod voice;
pub mod wake;
mod wallpaper;

use std::sync::atomic::Ordering;

use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_window_state::StateFlags;

/// `nova.exe --speech-probe <task>`: measures one speech model (see `speech::probe`).
pub fn speech_probe(request: &str) -> i32 {
    speech::probe::run(request)
}

pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running instance instead of opening another window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main_window(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility is NOVA's decision (tray / background start), not a restored state.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                // The assistant windows are placed by NOVA, relative to the screen they're on.
                .with_denylist(&[assistant::DOT_LABEL, assistant::PANEL_LABEL])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        assistant::on_shortcut(app);
                    }
                })
                .build(),
        )
        .manage(assistant::AssistantState::default())
        .manage(agent::AgentState::default())
        .manage(finder::FinderState::default())
        .manage(voice::VoiceState::default())
        .manage(tts::TtsState::default())
        .manage(scan::ScanState::default())
        .manage(speech::SpeechState::default())
        .manage(wake::WakeState::default())
        .manage(system::SystemMonitor::new())
        .manage(apps::AppCatalog::default())
        .manage(ai::ChatRequests::default())
        .manage(desktop::DesktopState::default())
        .manage(updates::PendingUpdate::default())
        .setup(|app| {
            let database = match app.path().app_data_dir() {
                Ok(dir) => match std::fs::create_dir_all(&dir) {
                    Ok(()) => storage::Database::open(dir.join("nova.db")),
                    Err(e) => storage::Database::unavailable(format!("cannot create {}: {e}", dir.display())),
                },
                Err(e) => storage::Database::unavailable(format!("no app data directory: {e}")),
            };
            let close_to_tray = desktop::load_preferences(&database);
            let assistant_prefs = assistant::load_prefs(&database);
            agent::init(app.handle(), agent::load_prefs(&database));
            let finder_prefs = finder::load_prefs(&database);
            let wake_prefs = wake::load_prefs(&database);
            let speech_prefs = speech::load_prefs(&database);
            app.state::<desktop::DesktopState>().close_to_tray.store(close_to_tray, Ordering::Relaxed);
            app.manage(database);
            desktop::create_tray(app.handle())?;
            app.handle().on_menu_event(assistant::on_menu_event);

            // Launched by "Start with Windows": stay in the background if the user chose
            // close-to-tray or the background assistant.
            let background_start = std::env::args().any(|arg| arg == desktop::BACKGROUND_FLAG);
            if background_start && (close_to_tray || assistant_prefs.background || assistant_prefs.enabled) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                    desktop::set_page_visible(&window, false);
                }
            }
            assistant::init(app.handle(), assistant_prefs);
            finder::init(app.handle(), finder_prefs);
            speech::init(app.handle(), speech_prefs);
            wake::init(app.handle(), wake_prefs);
            capture::watch_foreground();
            agent::auto::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                let app = window.app_handle();
                let to_tray = window.state::<desktop::DesktopState>().close_to_tray.load(Ordering::Relaxed);
                api.prevent_close();
                if to_tray || assistant::runs_in_background(app) {
                    let _ = window.hide();
                    if let Some(main) = app.get_webview_window("main") {
                        desktop::set_page_visible(&main, false);
                    }
                } else {
                    // Quit for real: the assistant windows would otherwise keep NOVA alive.
                    app.exit(0);
                }
            }
            // Minimized: stop rendering and polling until it's restored.
            ("main", WindowEvent::Resized(_)) => {
                if let (Ok(minimized), Some(main)) = (window.is_minimized(), window.app_handle().get_webview_window("main")) {
                    desktop::set_page_visible(&main, !minimized);
                }
            }
            (assistant::PANEL_LABEL, WindowEvent::CloseRequested { api, .. }) => {
                // Alt+F4 on the panel collapses it; the window is reused.
                api.prevent_close();
                assistant::request_collapse(window.app_handle());
            }
            // Nothing would bring the dot back; it goes away through its settings.
            (assistant::DOT_LABEL, WindowEvent::CloseRequested { api, .. }) => api.prevent_close(),
            (assistant::DOT_LABEL, WindowEvent::Moved(position)) => assistant::on_dot_moved(window.app_handle(), *position),
            (assistant::PANEL_LABEL, WindowEvent::Moved(position)) => assistant::on_panel_moved(window.app_handle(), *position),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            system::system_info,
            system::system_snapshot,
            system::system_processes,
            system::system_network_interfaces,
            system::system_temperatures,
            system::storage_volumes,
            storage::storage_status,
            storage::settings_get,
            storage::settings_set,
            storage::settings_delete,
            storage::dashboard_layouts_list,
            storage::dashboard_layout_save,
            storage::dashboard_layout_delete,
            storage::productivity_load,
            storage::project_save,
            storage::task_save,
            storage::note_save,
            storage::productivity_delete,
            storage::ai_conversations_list,
            storage::ai_conversation_messages,
            storage::ai_conversation_rename,
            storage::ai_conversation_delete,
            wallpaper::wallpaper_info,
            wallpaper::wallpaper_image,
            apps::apps_list,
            apps::app_icon,
            apps::app_launch,
            apps::app_shortcut_add,
            apps::app_shortcut_remove,
            media::media_state,
            media::media_artwork,
            media::media_control,
            media::media_volume,
            media::media_volume_set,
            media::media_seek,
            media::media_mixer,
            media::media_mixer_set,
            media::media_outputs,
            media::media_output_set,
            media::media_lyrics,
            agent::everyday::media_sleep,
            agent::media_play,
            agent::auto::media_played,
            agent::auto::media_played_clear,
            agent::auto::automation_list,
            agent::auto::automation_run,
            agent::auto::automation_delete_routine,
            agent::auto::automation_delete_watcher,
            agent::memory::memory_list,
            agent::memory::memory_add,
            agent::memory::memory_delete,
            ai::ai_key_status,
            ai::ai_key_set,
            ai::ai_key_delete,
            ai::ai_models,
            ai::ai_chat,
            ai::ai_chat_cancel,
            live::weather_search,
            live::weather_forecast,
            live::news_fetch,
            live::open_url,
            files::files_known_folders,
            files::files_recent,
            files::files_list,
            files::files_search,
            files::files_open,
            files::files_reveal,
            desktop::desktop_set_close_to_tray,
            desktop::autostart_get,
            desktop::autostart_set,
            updates::update_check,
            updates::update_install,
            assistant::assistant_status,
            assistant::assistant_configure,
            assistant::assistant_reset_position,
            assistant::assistant_toggle,
            assistant::assistant_collapse,
            assistant::assistant_panel_hidden,
            assistant::assistant_dot_ready,
            assistant::assistant_panel_ready,
            assistant::assistant_dot_menu,
            assistant::assistant_open_main,
            assistant::assistant_appearance,
            agent::assistant_send,
            agent::assistant_prewarm,
            agent::assistant_cancel,
            agent::assistant_confirm,
            agent::assistant_reset,
            agent::assistant_capture_targets,
            agent::assistant_capture,
            agent::assistant_attach_file,
            agent::assistant_clear_attachments,
            agent::assistant_open_path,
            agent::assistant_agent_status,
            agent::assistant_agent_configure,
            agent::assistant_actions,
            agent::assistant_clear_history,
            finder::finder_status,
            finder::finder_pick_folder,
            finder::finder_add_standard_folders,
            finder::finder_add_all_drives,
            assistant::assistant_panel_pin,
            assistant::assistant_panel_unmove,
            agent::everyday::assistant_timer_cancel,
            agent::everyday::assistant_power_cancel,
            finder::finder_remove_folder,
            finder::finder_set_content,
            finder::finder_reindex,
            finder::finder_search,
            voice::voice_listen,
            voice::voice_prepare,
            voice::voice_stop,
            voice::voice_open_settings,
            tts::tts_status,
            tts::tts_install,
            tts::tts_speak,
            tts::tts_cancel,
            online_voice::online_voice_keys,
            online_voice::elevenlabs_key_set,
            online_voice::elevenlabs_key_delete,
            online_voice::elevenlabs_voices_list,
            scan::scan_status,
            scan::scan_cancel,
            scan::scan_open_security,
            backdrop::backdrop_image_pick,
            backdrop::backdrop_image_load,
            assistant::assistant_headless_done,
            wake::wake_status,
            wake::wake_configure,
            wake::wake_test,
            wake::wake_set_speaking,
            turnlog::voice_report_turn,
            speech::speech_status,
            speech::speech_configure,
            speech::speech_install,
            speech::speech_remove,
            speech::speech_warm,
            speech::speech_benchmark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NOVA");
}

#[cfg(test)]
mod tests {
    /// The command names between two markers in a source file, without paths.
    fn names_between<'a>(source: &'a str, start: &str, end: &str) -> Vec<&'a str> {
        let list = source.split_once(start).expect("start marker").1.split_once(end).expect("end marker").0;
        list.split(',').map(|item| item.trim().trim_matches('"')).map(|item| item.rsplit("::").next().unwrap_or(item)).filter(|item| !item.is_empty()).collect()
    }

    /// Tauri refuses a command that isn't declared and allowed for a window, but
    /// only in the real app: tests and the browser preview never get that far.
    #[test]
    fn every_command_is_declared_and_allowed_for_a_window() {
        let lib = include_str!("lib.rs");
        let build = include_str!("../build.rs");
        let main = include_str!("../capabilities/default.json");
        let assistant = include_str!("../capabilities/assistant.json");
        // Split here so this test doesn't find its own markers first.
        let handlers = names_between(lib, concat!("generate_handler", "!["), "])");
        let declared = names_between(build, "commands(&[", "])");
        assert!(handlers.len() > 100, "found only {}", handlers.len());
        for command in &handlers {
            assert!(declared.contains(command), "{command} is missing from build.rs");
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            assert!(main.contains(&permission) || assistant.contains(&permission), "{command} is allowed in no capability file");
        }
        for command in &declared {
            assert!(handlers.contains(command), "build.rs declares {command}, which doesn't exist");
        }
    }
}
