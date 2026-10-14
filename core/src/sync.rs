//! `task sync`, using the sync settings in the user's .taskrc. The app never
//! keeps its own copy of the server details or the encryption secret.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::error::{input, Result};
use crate::locate::Version;
use crate::runner::Session;
use crate::tasks::parse_export;

const SYNC_TIMEOUT: Duration = Duration::from_secs(120);

/// The sync settings found in .taskrc. The secret itself is never returned.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// "server", "local", "gcp", "aws", or "none".
    pub kind: &'static str,
    pub url: Option<String>,
    pub client_id: Option<String>,
    pub has_secret: bool,
    pub local_dir: Option<String>,
    pub bucket: Option<String>,
    pub data_dir: Option<String>,
}

impl SyncConfig {
    pub fn configured(&self) -> bool {
        !matches!(self.kind, "none" | "")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub ok: bool,
    pub message: String,
    /// The server refused to send old history (410 Gone). Joining from an
    /// empty replica fixes it; the UI offers that.
    pub needs_join: bool,
}

/// All settings from `task _show`, as key -> value.
pub async fn show(s: &Session<'_>) -> Result<HashMap<String, String>> {
    let out = s.read(["_show"]).await?;
    Ok(out
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect())
}

pub async fn read_config(s: &Session<'_>) -> Result<SyncConfig> {
    let rc = show(s).await?;
    let get = |k: &str| rc.get(k).filter(|v| !v.is_empty()).cloned();
    let url = get("sync.server.url").or_else(|| get("sync.server.origin"));
    let local_dir = get("sync.local.server_dir");
    let gcp = get("sync.gcp.bucket");
    let aws = get("sync.aws.bucket");
    let kind = if url.is_some() {
        "server"
    } else if local_dir.is_some() {
        "local"
    } else if gcp.is_some() {
        "gcp"
    } else if aws.is_some() {
        "aws"
    } else {
        "none"
    };
    Ok(SyncConfig {
        kind,
        url,
        client_id: get("sync.server.client_id"),
        has_secret: get("sync.encryption_secret").is_some(),
        local_dir,
        bucket: gcp.or(aws),
        data_dir: get("data.location").map(|d| expand_home(&d).display().to_string()),
    })
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(p),
    }
}

fn is_client_id(s: &str) -> bool {
    crate::args::is_uuid(&s.to_ascii_lowercase())
}

/// Write the remote server settings to .taskrc with `task config`, as a user
/// would. Taskwarrior 3.0 calls the URL `sync.server.origin`; 3.1 renamed it.
pub async fn configure_server(
    s: &Session<'_>,
    version: Version,
    url: &str,
    client_id: &str,
    secret: Option<&str>,
) -> Result<()> {
    let url = url.trim().trim_end_matches('/');
    let client_id = client_id.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.contains(char::is_whitespace) {
        return Err(input("The server URL should look like https://sync.example.com"));
    }
    if !is_client_id(client_id) {
        return Err(input("The client ID is a UUID, like 7c1c9b4e-3f2a-4d5e-9b8c-1a2b3c4d5e6f"));
    }
    if let Some(secret) = secret {
        if secret.is_empty() || secret.contains(['\n', '\r']) {
            return Err(input("The encryption secret can't be empty or span lines"));
        }
    }
    let url_key = if version >= Version(3, 1, 0) { "sync.server.url" } else { "sync.server.origin" };
    s.must(["config", url_key, url], None).await?;
    s.must(["config", "sync.server.client_id", client_id], None).await?;
    if let Some(secret) = secret {
        s.must(["config", "sync.encryption_secret", secret], None).await?;
    }
    Ok(())
}

/// Run `task sync` and describe the result. The encryption secret is masked
/// in case a server or hook echoes it.
pub async fn sync(s: &Session<'_>) -> Result<SyncOutcome> {
    let secret = s.get_config("sync.encryption_secret").await.unwrap_or_default();
    let out = s.run_timeout(["sync"], SYNC_TIMEOUT).await?;
    let raw = if out.ok() {
        let text = out.combined();
        if text.is_empty() {
            "Sync successful.".to_string()
        } else {
            text
        }
    } else {
        out.combined()
    };
    let message = if secret.len() >= 4 { raw.replace(&secret, "•••") } else { raw };
    let needs_join = !out.ok() && (message.contains("410") || message.contains("Gone"));
    Ok(SyncOutcome { ok: out.ok(), message: message.trim().to_string(), needs_join })
}

const DB_FILES: &[&str] = &["taskchampion.sqlite3", "taskchampion.sqlite3-wal", "taskchampion.sqlite3-shm"];

/// First sync with a server account that already has history. A replica that
/// already has tasks asks the server for history from the very beginning,
/// which servers that prune old versions answer with 410 Gone. So: move the
/// local database aside, sync into an empty one to download the account, add
/// back local tasks the server doesn't have, and sync again. If the first sync
/// fails, the old database is put back. The old database is kept in a backup
/// folder either way.
pub async fn join(s: &Session<'_>, data_dir: &Path) -> Result<SyncOutcome> {
    let local = parse_export(&s.read(["export"]).await?)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let backup = data_dir.join(format!("warrior-backup-{stamp}"));
    std::fs::create_dir_all(&backup)?;
    let mut moved = Vec::new();
    for f in DB_FILES {
        let from = data_dir.join(f);
        if from.exists() {
            std::fs::copy(&from, backup.join(f))?;
            moved.push(*f);
        }
    }
    for f in &moved {
        std::fs::remove_file(data_dir.join(f))?;
    }

    let pulled = sync(s).await;
    let failed = match &pulled {
        Ok(o) => !o.ok,
        Err(_) => true,
    };
    if failed {
        for f in DB_FILES {
            let _ = std::fs::remove_file(data_dir.join(f));
        }
        for f in &moved {
            std::fs::copy(backup.join(f), data_dir.join(f))?;
        }
        return pulled.map(|o| SyncOutcome { needs_join: false, ..o });
    }

    let on_server: HashSet<String> = parse_export(&s.read(["export"]).await?)?
        .iter()
        .filter_map(|t| t.get("uuid").and_then(Value::as_str).map(String::from))
        .collect();
    let to_upload: Vec<Value> = local
        .into_iter()
        .filter(|t| t.get("uuid").and_then(Value::as_str).is_some_and(|u| !on_server.contains(u)))
        .map(|mut t| {
            if let Some(o) = t.as_object_mut() {
                o.remove("id");
                o.remove("urgency");
            }
            t
        })
        .collect();

    let plural = |n: usize| if n == 1 { "" } else { "s" };
    let mut message =
        format!("Connected. Downloaded {} task{} from the server.", on_server.len(), plural(on_server.len()));
    if !to_upload.is_empty() {
        let n = to_upload.len();
        s.must(["import", "-"], Some(&Value::Array(to_upload).to_string())).await?;
        let pushed = sync(s).await?;
        if pushed.ok {
            message += &format!(" Uploaded {n} task{} that were only on this computer.", plural(n));
        } else {
            message += &format!(" Couldn't upload {n} local task{} yet: {}", plural(n), pushed.message);
        }
    }
    if !moved.is_empty() {
        message += &format!(" Your previous database is backed up in {}.", backup.display());
    } else {
        let _ = std::fs::remove_dir(&backup);
    }
    Ok(SyncOutcome { ok: true, message, needs_join: false })
}
