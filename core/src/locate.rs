//! Finding the user's `task` program and checking its version.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::runner::TaskCommand;

const EXE: &str = if cfg!(windows) { "task.exe" } else { "task" };

/// Where package managers put `task`. Apps started from the macOS Finder or a
/// Linux desktop menu often don't get the shell's PATH, so look here too.
fn common_locations() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/opt/local/bin",
        "/snap/bin",
        "/run/current-system/sw/bin",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(".local/bin"));
        v.push(home.join(".nix-profile/bin"));
        v.push(home.join("bin"));
    }
    v
}

/// The `task` to use: the one set in Settings if any, else the first on the
/// PATH, else a common install location.
pub fn find_task(custom: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = custom {
        return p.is_file().then(|| p.to_path_buf());
    }
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    path_dirs.into_iter().chain(common_locations()).map(|d| d.join(EXE)).find(|p| p.is_file())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Version(pub u32, pub u32, pub u32);

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

pub const MINIMUM: Version = Version(3, 0, 0);

/// "3.4.2" (or "task 3.4.2 ...") to a version.
pub fn parse_version(text: &str) -> Option<Version> {
    text.split_whitespace().find_map(|word| {
        let mut parts = word.trim_start_matches('v').split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>());
        let patch = patch.and_then(|p| p.parse().ok()).unwrap_or(0);
        Some(Version(major, minor, patch))
    })
}

/// Run `task --version`. Plain, with no overrides: older versions don't know
/// some of the settings the runner passes.
pub async fn task_version(cmd: &TaskCommand) -> Result<Version, String> {
    let mut c = tokio::process::Command::new(&cmd.program);
    c.args(&cmd.prefix);
    if !cmd.prefix.is_empty() {
        c.arg("task");
    }
    c.arg("--version").stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000);
    let out = tokio::time::timeout(Duration::from_secs(10), c.output())
        .await
        .map_err(|_| "task --version didn't answer".to_string())?
        .map_err(|e| format!("Couldn't run {}: {e}", cmd.program.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    parse_version(&text).ok_or_else(|| format!("Couldn't read the version from task --version: {}", text.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("3.4.2\n"), Some(Version(3, 4, 2)));
        assert_eq!(parse_version("task 2.6.2 built for linux"), Some(Version(2, 6, 2)));
        assert_eq!(parse_version("3.1.0-rc1"), Some(Version(3, 1, 0)));
        assert_eq!(parse_version("nope"), None);
        assert!(Version(2, 6, 2) < MINIMUM);
        assert!(Version(3, 0, 0) >= MINIMUM);
    }
}
