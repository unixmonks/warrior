//! warrior: a window onto the user's own Taskwarrior.

mod background;
mod commands;
mod settings;
mod state;
mod tray;
mod watcher;

use tauri::{Manager, WindowEvent};

use crate::state::AppState;

/// Passed by the login item so the app starts in the tray.
const HIDDEN_ARG: &str = "--hidden";

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // First, so a second launch focuses the running app instead of starting another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::new(&config_dir));
            let handle = app.handle().clone();

            let tray_ok = match tray::create(&handle) {
                Ok(()) => true,
                Err(e) => {
                    // Some Linux desktops have no tray; the app works without it.
                    eprintln!("warrior: no system tray: {e}");
                    false
                }
            };
            app.state::<AppState>().set_tray(tray_ok);

            let hidden = tray_ok && std::env::args().any(|a| a == HIDDEN_ARG);
            if !hidden {
                show_main(&handle);
            }

            tauri::async_runtime::spawn(async move {
                state::detect(&handle).await;
                background::run(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if state.tray() && state.settings().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::recheck_task,
            commands::create_taskrc,
            commands::list_tasks,
            commands::refresh_tasks,
            commands::load_history,
            commands::add_task,
            commands::update_task,
            commands::task_action,
            commands::run_command,
            commands::sync_state,
            commands::sync_now,
            commands::sync_configure,
            commands::sync_join,
            commands::get_settings,
            commands::save_settings,
            commands::preview_rule,
            commands::list_reports,
            commands::save_report,
            commands::delete_report,
            commands::match_filters,
            commands::test_notification,
            commands::export_tasks,
            commands::import_tasks,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting warrior")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
            }
        });
}
