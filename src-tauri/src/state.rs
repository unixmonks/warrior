use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use warrior_core::locate::{self, Version};
use warrior_core::reminders::{DueItem, ReminderState};
use warrior_core::runner::DEFAULT_TIMEOUT;
use warrior_core::sync::{self, SyncConfig, SyncOutcome};
use warrior_core::{Changes, Runner, RunnerConfig, TaskCommand, TaskStore};

use crate::settings::{self, AppSettings, Files};

/// What the app found when it looked for Taskwarrior.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub checked: bool,
    pub ok: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
    /// task refused to start because there's no .taskrc; the app can create one.
    pub needs_taskrc: bool,
    pub taskrc: Option<String>,
    pub data_dir: Option<String>,
    pub platform: &'static str,
    pub wsl: bool,
    /// The system tray icon is up, so the app can keep running when closed.
    pub tray: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub config: SyncConfig,
    pub auto: bool,
    pub running: bool,
    /// Unix seconds.
    pub last_at: Option<i64>,
    pub last_ok: Option<bool>,
    pub last_message: Option<String>,
    pub needs_join: bool,
    #[serde(skip)]
    pub last_attempt: Option<Instant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    #[serde(flatten)]
    pub changes: Changes,
    #[serde(flatten)]
    pub outcome: SyncOutcome,
}

pub struct Reminders {
    pub index: Vec<DueItem>,
    pub built: Option<Instant>,
    pub state: ReminderState,
}

pub struct AppState {
    pub store: Arc<TaskStore>,
    files: Files,
    settings: Mutex<AppSettings>,
    status: Mutex<TaskStatus>,
    version: Mutex<Option<Version>>,
    sync: Mutex<SyncStatus>,
    tray: AtomicBool,
    reminders_dirty: AtomicBool,
    pub reminders: tokio::sync::Mutex<Reminders>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl AppState {
    pub fn new(config_dir: &Path) -> Self {
        let files = Files::new(config_dir);
        let settings: AppSettings = settings::load(&files.settings);
        let runner = Arc::new(Runner::new(RunnerConfig { command: None, taskrc: None, timeout: DEFAULT_TIMEOUT }));
        let store = Arc::new(TaskStore::new(runner, Some(settings.history_days)));
        let reminder_state: ReminderState = settings::load(&files.reminders);
        Self {
            store,
            settings: Mutex::new(settings),
            files,
            status: Mutex::new(TaskStatus { platform: std::env::consts::OS, ..Default::default() }),
            version: Mutex::new(None),
            sync: Mutex::new(SyncStatus::default()),
            tray: AtomicBool::new(false),
            reminders_dirty: AtomicBool::new(true),
            reminders: tokio::sync::Mutex::new(Reminders { index: Vec::new(), built: None, state: reminder_state }),
            watcher: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> AppSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn set_settings(&self, s: AppSettings) -> std::io::Result<()> {
        settings::save(&self.files.settings, &s)?;
        *self.settings.lock().unwrap() = s;
        Ok(())
    }

    pub fn save_reminder_state(&self, st: &ReminderState) {
        let _ = settings::save(&self.files.reminders, st);
    }

    pub fn status(&self) -> TaskStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn version(&self) -> Option<Version> {
        *self.version.lock().unwrap()
    }

    pub fn tray(&self) -> bool {
        self.tray.load(Ordering::Relaxed)
    }

    pub fn set_tray(&self, ok: bool) {
        self.tray.store(ok, Ordering::Relaxed)
    }

    pub fn sync_status(&self) -> SyncStatus {
        let mut s = self.sync.lock().unwrap().clone();
        s.auto = self.settings().auto_sync;
        s
    }

    pub fn update_sync(&self, f: impl FnOnce(&mut SyncStatus)) {
        f(&mut self.sync.lock().unwrap())
    }

    /// Reminders need recomputing after tasks or rules change.
    pub fn mark_reminders_dirty(&self) {
        self.reminders_dirty.store(true, Ordering::Relaxed)
    }

    pub fn take_reminders_dirty(&self) -> bool {
        self.reminders_dirty.swap(false, Ordering::Relaxed)
    }
}

/// Tell the window about changed tasks, and recheck reminders.
pub fn publish(app: &AppHandle, changes: &Changes) {
    if changes.is_empty() {
        return;
    }
    let _ = app.emit("tasks-changed", changes);
    app.state::<AppState>().mark_reminders_dirty();
}

pub fn publish_sync(app: &AppHandle) {
    let _ = app.emit("sync-state", app.state::<AppState>().sync_status());
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// The .taskrc `task` will read: the one set in Settings, else TASKRC, else
/// ~/.taskrc, else the XDG location. If none exists, ~/.taskrc.
pub fn taskrc_path(settings: &AppSettings) -> Option<PathBuf> {
    if let Some(p) = settings.taskrc.as_deref().filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("TASKRC") {
        return Some(PathBuf::from(p));
    }
    let home = home()?;
    let classic = home.join(".taskrc");
    if classic.exists() {
        return Some(classic);
    }
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    let xdg = xdg.join("task").join("taskrc");
    Some(if xdg.exists() { xdg } else { classic })
}

/// Find `task`, check its version, read the sync settings and start watching
/// the data directory. Run at start and whenever the related settings change.
pub async fn detect(app: &AppHandle) -> TaskStatus {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let wsl = cfg!(windows) && settings.use_wsl;
    let command = if wsl {
        Some(TaskCommand { program: "wsl.exe".into(), prefix: vec!["-e".into()] })
    } else {
        locate::find_task(settings.task_path.as_deref().filter(|p| !p.is_empty()).map(Path::new)).map(TaskCommand::new)
    };
    let taskrc_override = settings.taskrc.as_deref().filter(|p| !p.is_empty()).map(PathBuf::from);

    let mut status = TaskStatus {
        checked: true,
        platform: std::env::consts::OS,
        wsl,
        tray: state.tray(),
        taskrc: if wsl { None } else { taskrc_path(&settings).map(|p| p.display().to_string()) },
        ..Default::default()
    };
    let mut version = None;
    match &command {
        None if settings.task_path.as_deref().is_some_and(|p| !p.is_empty()) => {
            status.message = Some("There's no program at the path set in Settings.".into());
        }
        None => {
            status.message = Some("Taskwarrior's `task` program isn't installed, or isn't where warrior looks.".into())
        }
        Some(cmd) => {
            status.path = Some(if wsl { "wsl task".into() } else { cmd.program.display().to_string() });
            match locate::task_version(cmd).await {
                Ok(v) if v < locate::MINIMUM => {
                    status.version = Some(v.to_string());
                    status.message = Some(format!("warrior needs Taskwarrior 3.0 or later; this is {v}."));
                }
                Ok(v) => {
                    status.version = Some(v.to_string());
                    version = Some(v);
                    status.ok = true;
                }
                Err(e) => status.message = Some(e),
            }
        }
    }

    state.store.runner().set_config(RunnerConfig {
        command: if status.ok { command } else { None },
        taskrc: taskrc_override,
        timeout: DEFAULT_TIMEOUT,
    });
    state.store.reset();
    *state.version.lock().unwrap() = version;

    if status.ok {
        let s = state.store.runner().session().await;
        match sync::read_config(&s).await {
            Ok(cfg) => {
                status.data_dir = cfg.data_dir.clone();
                state.update_sync(|st| st.config = cfg);
            }
            Err(e) => {
                let msg = e.to_string();
                status.ok = false;
                status.needs_taskrc = msg.contains("without rc file");
                status.message = Some(if status.needs_taskrc {
                    "Taskwarrior needs a configuration file (.taskrc) before it can run.".into()
                } else {
                    msg
                });
            }
        }
    }

    let watcher = match (&status.data_dir, status.ok && !wsl) {
        (Some(dir), true) => crate::watcher::start(app.clone(), PathBuf::from(dir))
            .map_err(|e| eprintln!("warrior: not watching {dir}: {e}"))
            .ok(),
        _ => None,
    };
    *state.watcher.lock().unwrap() = watcher;
    *state.status.lock().unwrap() = status.clone();
    state.mark_reminders_dirty();
    let _ = app.emit("task-status", &status);
    publish_sync(app);
    status
}

/// Run `task sync` and pick up whatever it brought in. Only one at a time.
pub async fn run_sync(app: &AppHandle, join: bool) -> Result<SyncResult, warrior_core::Error> {
    let state = app.state::<AppState>();
    let busy = {
        let mut st = state.sync.lock().unwrap();
        let busy = st.running;
        st.running = true;
        st.last_attempt = Some(Instant::now());
        busy
    };
    if busy {
        return Ok(SyncResult {
            changes: Changes::default(),
            outcome: SyncOutcome { ok: true, message: "A sync is already running.".into(), needs_join: false },
        });
    }
    publish_sync(app);

    let result: Result<SyncResult, warrior_core::Error> = async {
        let s = state.store.runner().session().await;
        let outcome = if join {
            let dir = state
                .status()
                .data_dir
                .ok_or_else(|| warrior_core::Error::Input("Taskwarrior's data directory is unknown".into()))?;
            sync::join(&s, Path::new(&dir)).await?
        } else {
            sync::sync(&s).await?
        };
        let changes = if outcome.ok { state.store.refresh_in(&s).await? } else { Changes::default() };
        Ok(SyncResult { changes, outcome })
    }
    .await;

    state.update_sync(|st| {
        st.running = false;
        st.last_at = Some(chrono::Utc::now().timestamp());
        match &result {
            Ok(r) => {
                st.last_ok = Some(r.outcome.ok);
                st.last_message = Some(r.outcome.message.clone());
                st.needs_join = r.outcome.needs_join;
            }
            Err(e) => {
                st.last_ok = Some(false);
                st.last_message = Some(e.to_string());
            }
        }
    });
    if let Ok(r) = &result {
        publish(app, &r.changes);
    }
    publish_sync(app);
    result
}
