//! Watch Taskwarrior's data directory, so changes made in a terminal (or
//! brought in by a sync elsewhere) show up in the window.

use std::path::PathBuf;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Manager};

use crate::state::{publish, AppState};

/// Wait for writes to settle before re-exporting.
const DEBOUNCE: Duration = Duration::from_millis(500);
/// Changes this soon after the app's own `task` run are its own (exports can
/// write too), and re-exporting for them would loop.
const OWN_WRITES: Duration = Duration::from_millis(1500);

pub fn start(app: AppHandle, dir: PathBuf) -> notify::Result<RecommendedWatcher> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if !ev.kind.is_access() {
                let _ = tx.send(());
            }
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;

    tauri::async_runtime::spawn(async move {
        // Ends when the watcher (and with it the sender) is dropped.
        while rx.recv().await.is_some() {
            loop {
                match tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            let state = app.state::<AppState>();
            if state.store.runner().recently_active(OWN_WRITES) {
                continue;
            }
            if let Ok(changes) = state.store.refresh().await {
                publish(&app, &changes);
            }
        }
    });
    Ok(watcher)
}
