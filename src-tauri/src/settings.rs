//! The app's own settings. Everything about Taskwarrior itself (sync server,
//! contexts, UDAs) stays in the user's .taskrc.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use warrior_core::reminders::Rule;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Path to `task`; None finds it on the PATH.
    pub task_path: Option<String>,
    /// A .taskrc other than the default.
    pub taskrc: Option<String>,
    /// Windows: run `task` inside WSL.
    pub use_wsl: bool,
    pub auto_sync: bool,
    pub sync_interval_minutes: u32,
    /// Completed and deleted tasks older than this load on demand.
    pub history_days: u32,
    pub notifications: bool,
    pub rules: Vec<Rule>,
    /// Keep running in the tray when the window is closed, so reminders still arrive.
    pub close_to_tray: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            task_path: None,
            taskrc: None,
            use_wsl: false,
            auto_sync: true,
            sync_interval_minutes: 10,
            history_days: 90,
            notifications: true,
            rules: Rule::default_rules(),
            close_to_tray: false,
        }
    }
}

impl AppSettings {
    /// Settings that decide which `task` and which data the app uses.
    pub fn same_taskwarrior(&self, other: &AppSettings) -> bool {
        self.task_path == other.task_path && self.taskrc == other.taskrc && self.use_wsl == other.use_wsl
    }
}

pub struct Files {
    pub settings: PathBuf,
    pub reminders: PathBuf,
}

impl Files {
    pub fn new(config_dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(config_dir);
        Self { settings: config_dir.join("settings.json"), reminders: config_dir.join("reminders.json") }
    }
}

pub fn load<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Write to a temporary file and rename, so a crash never leaves half a file.
pub fn save<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)
}
