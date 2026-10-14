use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::show_main;

/// The libraries tauri's tray uses on Linux, in the order it tries them. It
/// panics if none loads, so check first.
#[cfg(target_os = "linux")]
fn tray_library_present() -> bool {
    ["libayatana-appindicator3.so.1", "libappindicator3.so.1", "libayatana-appindicator3.so", "libappindicator3.so"]
        .iter()
        // SAFETY: these are plain C libraries with no load-time side effects
        // beyond their own initialisers; the handle is dropped straight away.
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
}

#[cfg(not(target_os = "linux"))]
fn tray_library_present() -> bool {
    true
}

pub fn create(app: &AppHandle) -> Result<(), String> {
    if !tray_library_present() {
        return Err("libayatana-appindicator3 isn't installed".into());
    }
    build(app).map_err(|e| e.to_string())
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open warrior", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit warrior", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &sync, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("warrior")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "sync" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::state::run_sync(&app, false).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
