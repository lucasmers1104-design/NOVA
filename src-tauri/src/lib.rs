mod ai;
mod apps;
mod credentials;
mod desktop;
mod files;
mod http;
mod live;
mod media;
mod shell;
mod storage;
mod system;
mod wallpaper;

use std::sync::atomic::Ordering;

use tauri::{Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running instance instead of opening another window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desktop::show_main_window(app)))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Visibility is NOVA's decision (tray / background start), not a restored state.
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(system::SystemMonitor::new())
        .manage(apps::AppCatalog::default())
        .manage(ai::ChatRequests::default())
        .manage(desktop::DesktopState::default())
        .setup(|app| {
            let database = match app.path().app_data_dir() {
                Ok(dir) => match std::fs::create_dir_all(&dir) {
                    Ok(()) => storage::Database::open(dir.join("nova.db")),
                    Err(e) => storage::Database::unavailable(format!("cannot create {}: {e}", dir.display())),
                },
                Err(e) => storage::Database::unavailable(format!("no app data directory: {e}")),
            };
            let close_to_tray = desktop::load_preferences(&database);
            app.state::<desktop::DesktopState>().close_to_tray.store(close_to_tray, Ordering::Relaxed);
            app.manage(database);
            desktop::create_tray(app.handle())?;

            // Launched by "Start with Windows": stay in the tray if the user chose close-to-tray.
            if close_to_tray && std::env::args().any(|arg| arg == desktop::BACKGROUND_FLAG) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let to_tray = window.state::<desktop::DesktopState>().close_to_tray.load(Ordering::Relaxed);
                if window.label() == "main" && to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running NOVA");
}
