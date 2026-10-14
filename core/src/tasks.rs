//! The app's copy of the task list (the last `task export`) and the changes
//! the UI makes. Tasks stay as JSON values so UDAs and any fields this app
//! doesn't know about survive a round trip through `task import`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{Duration as ChronoDuration, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::{assert_uuid, date_value, priority_value, project_value, recur_value, tag_value, tokenize};
use crate::error::{input, Error, Result};
use crate::runner::{Runner, Session, Verbosity};

/// What changed since the UI's copy: whole tasks that are new or different,
/// and the UUIDs of tasks that are gone.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Changes {
    pub changed: Vec<Value>,
    pub removed: Vec<String>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty()
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct Annotation {
    #[serde(default)]
    pub entry: String,
    pub description: String,
}

/// Edits from the task panel. Absent fields are left alone; a date set to
/// null is cleared.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct TaskPatch {
    pub description: Option<String>,
    pub annotations: Option<Vec<Annotation>>,
    pub project: Option<String>,
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub due: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub scheduled: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub wait: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub until: Option<Option<String>>,
    pub priority: Option<String>,
    pub recur: Option<String>,
}

/// Tells "field: null" (clear it) apart from a missing field (leave it).
fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskAction {
    Done,
    Delete,
    Start,
    Stop,
    Restore,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandResult {
    #[serde(flatten)]
    pub changes: Changes,
    pub output: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Added {
    #[serde(flatten)]
    pub changes: Changes,
    pub uuid: Option<String>,
}

#[derive(Default)]
struct Cache {
    /// uuid -> (signature, task)
    tasks: HashMap<String, (String, Value)>,
    loaded: bool,
}

pub struct TaskStore {
    runner: Arc<Runner>,
    cache: Mutex<Cache>,
    /// Completed and deleted tasks older than this many days aren't exported
    /// until the user asks for them. None loads everything.
    history_days: Mutex<Option<u32>>,
}

impl TaskStore {
    pub fn new(runner: Arc<Runner>, history_days: Option<u32>) -> Self {
        Self { runner, cache: Mutex::new(Cache::default()), history_days: Mutex::new(history_days) }
    }

    pub fn runner(&self) -> &Arc<Runner> {
        &self.runner
    }

    pub fn history_complete(&self) -> bool {
        self.history_days.lock().unwrap().is_none()
    }

    /// Forget everything, e.g. after switching to a different .taskrc.
    pub fn reset(&self) {
        *self.cache.lock().unwrap() = Cache::default();
    }

    /// Every cached task, exporting first if nothing has been loaded yet.
    pub async fn list(&self) -> Result<Vec<Value>> {
        if !self.cache.lock().unwrap().loaded {
            let s = self.runner.session().await;
            self.refresh_in(&s).await?;
        }
        Ok(self.snapshot())
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.cache.lock().unwrap().tasks.values().map(|(_, t)| t.clone()).collect()
    }

    /// Re-export and report what differs from the cache.
    pub async fn refresh(&self) -> Result<Changes> {
        let s = self.runner.session().await;
        self.refresh_in(&s).await
    }

    /// Export older completed and deleted tasks too.
    pub async fn load_history(&self) -> Result<Changes> {
        *self.history_days.lock().unwrap() = None;
        self.refresh().await
    }

    pub async fn refresh_in(&self, s: &Session<'_>) -> Result<Changes> {
        let mut args: Vec<String> = Vec::new();
        if let Some(days) = *self.history_days.lock().unwrap() {
            let since = (Local::now() - ChronoDuration::days(days as i64)).format("%Y-%m-%d").to_string();
            // A waiting task is stored as pending, but `status:pending` leaves
            // it out; it only matches `status:waiting`.
            let end = format!("end.after:{since}");
            args.extend(
                ["(", "status:pending", "or", "status:waiting", "or", "status:recurring", "or", &end, ")"]
                    .map(String::from),
            );
        }
        args.push("export".into());
        let tasks = parse_export(&s.read(args).await?)?;

        let mut cache = self.cache.lock().unwrap();
        let mut old = std::mem::take(&mut cache.tasks);
        let mut changes = Changes::default();
        for mut t in tasks {
            let Some(uuid) = t.get("uuid").and_then(Value::as_str).map(String::from) else { continue };
            // Urgency drifts as tasks age; rounding keeps every export from
            // looking like a change to every task.
            if let Some(u) = t.get("urgency").and_then(Value::as_f64) {
                t["urgency"] = serde_json::json!((u * 10.0).round() / 10.0);
            }
            let sig = t.to_string();
            let same = old.remove(&uuid).is_some_and(|(prev, _)| prev == sig);
            if !same {
                changes.changed.push(t.clone());
            }
            cache.tasks.insert(uuid, (sig, t));
        }
        changes.removed = old.into_keys().collect();
        cache.loaded = true;
        Ok(changes)
    }

    fn cached(&self, uuid: &str) -> Option<Value> {
        self.cache.lock().unwrap().tasks.get(uuid).map(|(_, t)| t.clone())
    }

    /// Quick add: `task add <words>`, parsed by Taskwarrior itself, so
    /// `project:home due:fri +errand` works as it does in a terminal.
    pub async fn add(&self, line: &str) -> Result<Added> {
        let words = tokenize(line)?;
        if words.is_empty() {
            return Err(input("Type something to add"));
        }
        let s = self.runner.session().await;
        s.must(std::iter::once("add".to_string()).chain(words), None).await?;
        let latest = parse_export(&s.read(["+LATEST", "export"]).await?)?;
        let uuid = latest.last().and_then(|t| t.get("uuid")).and_then(Value::as_str).map(String::from);
        let changes = self.refresh_in(&s).await?;
        Ok(Added { changes, uuid })
    }

    pub async fn update(&self, uuid: &str, patch: TaskPatch) -> Result<Changes> {
        assert_uuid(uuid)?;
        let current = self.cached(uuid).ok_or_else(|| input("That task no longer exists"))?;

        let mut mods: Vec<String> = Vec::new();
        if let Some(p) = &patch.project {
            mods.push(format!("project:{}", project_value(p)?));
        }
        if let Some(p) = &patch.priority {
            mods.push(format!("priority:{}", priority_value(p)?));
        }
        if let Some(r) = &patch.recur {
            mods.push(format!("recur:{}", recur_value(r)?));
        }
        for (field, value) in
            [("due", &patch.due), ("scheduled", &patch.scheduled), ("wait", &patch.wait), ("until", &patch.until)]
        {
            match value {
                Some(Some(v)) if !v.trim().is_empty() => mods.push(format!("{field}:{}", date_value(v)?)),
                Some(_) => mods.push(format!("{field}:")),
                None => {}
            }
        }
        if let Some(tags) = &patch.tags {
            let next = tags.iter().map(|t| tag_value(t)).collect::<Result<Vec<_>>>()?;
            let prev: Vec<String> = current
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                .unwrap_or_default();
            mods.extend(next.iter().filter(|t| !prev.contains(t)).map(|t| format!("+{t}")));
            mods.extend(prev.iter().filter(|t| !next.contains(t)).map(|t| format!("-{t}")));
        }
        if patch.description.as_ref().is_some_and(|d| d.trim().is_empty()) {
            return Err(input("A task needs a description"));
        }
        let rewrite = patch.description.is_some() || patch.annotations.is_some();

        let s = self.runner.session().await;
        if !mods.is_empty() {
            s.must([uuid.to_string(), "modify".into()].into_iter().chain(mods), None).await?;
        }
        if rewrite {
            // Description and notes can hold any text, so they go through
            // `task import` as JSON rather than through the command-line parser.
            let mut task = parse_export(&s.read([uuid, "export"]).await?)?
                .into_iter()
                .next()
                .ok_or_else(|| input("That task no longer exists"))?;
            let obj = task.as_object_mut().ok_or_else(|| input("That task no longer exists"))?;
            if let Some(d) = &patch.description {
                obj.insert("description".into(), Value::String(d.trim().to_string()));
            }
            if let Some(notes) = &patch.annotations {
                let notes: Vec<Value> = notes
                    .iter()
                    .filter(|a| !a.description.trim().is_empty())
                    .map(|a| {
                        let entry = if a.entry.is_empty() { tw_now() } else { a.entry.clone() };
                        serde_json::json!({ "entry": entry, "description": a.description })
                    })
                    .collect();
                if notes.is_empty() {
                    obj.remove("annotations");
                } else {
                    obj.insert("annotations".into(), Value::Array(notes));
                }
            }
            obj.remove("id");
            obj.remove("urgency");
            s.must(["import", "-"], Some(&Value::Array(vec![task]).to_string())).await?;
        }
        self.refresh_in(&s).await
    }

    pub async fn annotate(&self, uuid: &str, text: &str) -> Result<Changes> {
        assert_uuid(uuid)?;
        if text.trim().is_empty() {
            return Err(input("Note is empty"));
        }
        let s = self.runner.session().await;
        s.must([uuid, "annotate", "--", text], None).await?;
        self.refresh_in(&s).await
    }

    pub async fn action(&self, uuid: &str, action: TaskAction) -> Result<Changes> {
        assert_uuid(uuid)?;
        let args: Vec<&str> = match action {
            TaskAction::Done => vec![uuid, "done"],
            TaskAction::Delete => vec![uuid, "delete"],
            TaskAction::Start => vec![uuid, "start"],
            TaskAction::Stop => vec![uuid, "stop"],
            TaskAction::Restore => vec![uuid, "modify", "status:pending", "end:"],
        };
        let s = self.runner.session().await;
        s.must(args, None).await?;
        self.refresh_in(&s).await
    }

    pub async fn undo(&self) -> Result<CommandResult> {
        let s = self.runner.session().await;
        let out = s.must(["undo"], Some("yes\n")).await?;
        let changes = self.refresh_in(&s).await?;
        Ok(CommandResult { changes, output: out.combined(), ok: true })
    }

    /// The command panel: any `task` command, output returned as text.
    pub async fn command(&self, line: &str) -> Result<CommandResult> {
        let mut args = tokenize(line.trim())?;
        if args.first().map(String::as_str) == Some("task") {
            args.remove(0);
        }
        if let Some(word) = args.iter().take_while(|a| *a != "--").find(|a| *a == "edit" || *a == "execute") {
            return Ok(CommandResult {
                changes: Changes::default(),
                output: format!("`task {word}` needs a terminal. Run it there; warrior picks up the changes."),
                ok: false,
            });
        }
        let s = self.runner.session().await;
        let undo = args.iter().any(|a| a == "undo");
        let out = s.run(args, undo.then_some("yes\n"), Verbosity::Normal).await?;
        // Any command might have changed something.
        let changes = self.refresh_in(&s).await?;
        let mut output = out.combined();
        if !out.ok() && output.contains("(yes/no") {
            output += "\n\nThat needs a yes or no, which only a terminal can answer, so nothing was changed. Run it there; warrior picks up the changes.";
        }
        Ok(CommandResult {
            changes,
            output: if output.is_empty() { "(no output)".into() } else { output },
            ok: out.ok(),
        })
    }

    /// Import the output of `task export` (a JSON array, or one object per line).
    pub async fn import_json(&self, text: &str) -> Result<CommandResult> {
        let trimmed = text.trim();
        let tasks: Vec<Value> = if trimmed.starts_with('[') {
            serde_json::from_str(trimmed).map_err(|_| input("That file isn't valid JSON"))?
        } else {
            trimmed
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(serde_json::from_str)
                .collect::<std::result::Result<_, _>>()
                .map_err(|_| input("That file isn't valid JSON"))?
        };
        if tasks.is_empty() {
            return Err(input("That file has no tasks in it"));
        }
        let s = self.runner.session().await;
        let out = s.must(["import", "-"], Some(&Value::Array(tasks).to_string())).await?;
        let changes = self.refresh_in(&s).await?;
        Ok(CommandResult { changes, output: out.combined(), ok: true })
    }

    /// Every task, including all history, as `task export` prints it.
    pub async fn export_all(&self) -> Result<String> {
        let s = self.runner.session().await;
        s.read(["export"]).await
    }
}

pub fn parse_export(stdout: &str) -> Result<Vec<Value>> {
    let t = stdout.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(t)? {
        Value::Array(a) => Ok(a),
        _ => Err(Error::Task("task export didn't print a list".into())),
    }
}

/// Now in Taskwarrior's format: 20261011T093000Z.
pub fn tw_now() -> String {
    Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

/// Taskwarrior's 20261011T093000Z as Unix seconds.
pub fn tw_epoch(s: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%SZ").ok().map(|d| d.and_utc().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_tells_null_from_missing() {
        let p: TaskPatch = serde_json::from_str(r#"{"due": null, "project": "x"}"#).unwrap();
        assert_eq!(p.due, Some(None));
        assert_eq!(p.scheduled, None);
        let p: TaskPatch = serde_json::from_str(r#"{"wait": "mon"}"#).unwrap();
        assert_eq!(p.wait, Some(Some("mon".into())));
    }

    #[test]
    fn reads_tw_dates() {
        assert_eq!(tw_epoch("19700101T000100Z"), Some(60));
        assert_eq!(tw_epoch("garbage"), None);
    }
}
