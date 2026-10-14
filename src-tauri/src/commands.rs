//! What the window can ask for. Each change returns the tasks it changed, so
//! the UI updates without reloading everything.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use warrior_core::reminders::{self, Notice, Rule};
use warrior_core::reports::{self, FilterMatch, Report, ReportInput};
use warrior_core::sync;
use warrior_core::tasks::{Added, CommandResult};
use warrior_core::{Changes, Error, TaskAction, TaskPatch};

use crate::settings::AppSettings;
use crate::state::{self, publish, publish_sync, AppState, SyncResult, SyncStatus, TaskStatus};

type Result<T> = std::result::Result<T, Error>;

#[tauri::command]
pub fn app_status(state: State<'_, AppState>) -> TaskStatus {
    state.status()
}

#[tauri::command]
pub async fn recheck_task(app: AppHandle) -> TaskStatus {
    state::detect(&app).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    tasks: Vec<Value>,
    history_complete: bool,
}

#[tauri::command]
pub async fn list_tasks(state: State<'_, AppState>) -> Result<TaskList> {
    let tasks = state.store.list().await?;
    Ok(TaskList { tasks, history_complete: state.store.history_complete() })
}

/// Re-export, e.g. when the window regains focus.
#[tauri::command]
pub async fn refresh_tasks(app: AppHandle, state: State<'_, AppState>) -> Result<Changes> {
    let changes = state.store.refresh().await?;
    publish(&app, &changes);
    Ok(changes)
}

#[tauri::command]
pub async fn load_history(state: State<'_, AppState>) -> Result<Changes> {
    state.store.load_history().await
}

#[tauri::command]
pub async fn add_task(state: State<'_, AppState>, line: String) -> Result<Added> {
    let r = state.store.add(&line).await?;
    state.mark_reminders_dirty();
    Ok(r)
}

#[tauri::command]
pub async fn update_task(state: State<'_, AppState>, uuid: String, patch: TaskPatch) -> Result<Changes> {
    let r = state.store.update(&uuid, patch).await?;
    state.mark_reminders_dirty();
    Ok(r)
}

#[tauri::command]
pub async fn task_action(state: State<'_, AppState>, uuid: String, action: TaskAction) -> Result<Changes> {
    let r = state.store.action(&uuid, action).await?;
    state.mark_reminders_dirty();
    Ok(r)
}

#[tauri::command]
pub async fn run_command(state: State<'_, AppState>, line: String) -> Result<CommandResult> {
    let r = state.store.command(&line).await?;
    state.mark_reminders_dirty();
    Ok(r)
}

#[tauri::command]
pub fn sync_state(state: State<'_, AppState>) -> SyncStatus {
    state.sync_status()
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncResult> {
    state::run_sync(&app, false).await
}

/// Connect to a remote sync server: write its settings to .taskrc with
/// `task config`, then sync.
#[tauri::command]
pub async fn sync_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    client_id: String,
    secret: Option<String>,
) -> Result<SyncResult> {
    let version = state.version().ok_or(Error::NotFound)?;
    {
        let s = state.store.runner().session().await;
        let current = sync::read_config(&s).await?;
        let secret = secret.as_deref().filter(|s| !s.is_empty());
        if secret.is_none() && !current.has_secret {
            return Err(Error::Input("Enter the encryption secret".into()));
        }
        sync::configure_server(&s, version, &url, &client_id, secret).await?;
        let cfg = sync::read_config(&s).await?;
        state.update_sync(|st| {
            st.config = cfg;
            st.needs_join = false;
        });
    }
    publish_sync(&app);
    state::run_sync(&app, false).await
}

/// The fix for "410 Gone" on first sync; see warrior_core::sync::join.
#[tauri::command]
pub async fn sync_join(app: AppHandle) -> Result<SyncResult> {
    state::run_sync(&app, true).await
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings()
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings> {
    let before = state.settings();
    state.set_settings(settings.clone())?;
    if !settings.same_taskwarrior(&before) {
        state::detect(&app).await;
        let _ = app.emit("tasks-reset", ());
    }
    if settings.rules != before.rules || settings.notifications != before.notifications {
        state.mark_reminders_dirty();
    }
    if settings.auto_sync != before.auto_sync {
        publish_sync(&app);
    }
    Ok(settings)
}

/// How many tasks a reminder rule matches right now. Fails on a bad filter.
#[tauri::command]
pub async fn preview_rule(state: State<'_, AppState>, rule: Rule) -> Result<usize> {
    let s = state.store.runner().session().await;
    reminders::preview(&s, &rule).await
}

/// The user's own Taskwarrior reports, shown as views in the sidebar.
#[tauri::command]
pub async fn list_reports(state: State<'_, AppState>) -> Result<Vec<Report>> {
    let s = state.store.runner().session().await;
    reports::list(&s).await
}

#[tauri::command]
pub async fn save_report(state: State<'_, AppState>, report: ReportInput) -> Result<Report> {
    let s = state.store.runner().session().await;
    reports::save(&s, report).await
}

#[tauri::command]
pub async fn delete_report(state: State<'_, AppState>, name: String) -> Result<()> {
    let s = state.store.runner().session().await;
    reports::delete(&s, &name).await
}

/// The tasks each Taskwarrior filter matches, for the filter bar and reports.
#[tauri::command]
pub async fn match_filters(state: State<'_, AppState>, filters: Vec<String>) -> Result<Vec<FilterMatch>> {
    let s = state.store.runner().session().await;
    reports::matches(&s, &filters).await
}

#[tauri::command]
pub fn test_notification(app: AppHandle) {
    crate::background::notify(
        &app,
        &Notice {
            title: "Reminders are on".into(),
            body: "warrior will remind you like this when tasks come due.".into(),
        },
    );
}

/// Every task, including all history, as `task export` writes it.
#[tauri::command]
pub async fn export_tasks(state: State<'_, AppState>, path: String) -> Result<usize> {
    let json = state.store.export_all().await?;
    let count = warrior_core::tasks::parse_export(&json)?.len();
    std::fs::write(&path, json)?;
    Ok(count)
}

#[tauri::command]
pub async fn import_tasks(state: State<'_, AppState>, path: String) -> Result<CommandResult> {
    let text = std::fs::read_to_string(&path)?;
    let r = state.store.import_json(&text).await?;
    state.mark_reminders_dirty();
    Ok(r)
}

/// Create an empty .taskrc where Taskwarrior looks for one, so it can run.
#[tauri::command]
pub async fn create_taskrc(app: AppHandle, state: State<'_, AppState>) -> Result<TaskStatus> {
    let path =
        state::taskrc_path(&state.settings()).ok_or_else(|| Error::Input("Couldn't find your home folder".into()))?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, "# Taskwarrior settings. See `man taskrc`.\n# Created by warrior.\n")?;
    }
    Ok(state::detect(&app).await)
}
