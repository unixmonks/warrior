//! Local reminders: "when due" or "N minutes before", and a daily digest.
//! Which tasks a rule covers is decided by `task` with the rule's filter; when
//! to notify is decided here.

use std::collections::HashMap;

use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::args::{grouped, parse_filter};
use crate::error::Result;
use crate::runner::Session;
use crate::tasks::{parse_export, tw_epoch};

/// Reminders missed while the computer was off are still shown, unless they
/// are older than this.
const MISSED_WINDOW: i64 = 3 * 86400;
/// More reminders than this at once become one summary notification.
const MAX_SEPARATE: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    Due,
    Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub kind: RuleKind,
    /// Any Taskwarrior filter; empty means all pending tasks with a due date.
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub offset_minutes: i64,
    #[serde(default = "default_hour")]
    pub digest_hour: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn default_hour() -> u32 {
    8
}
fn yes() -> bool {
    true
}

impl Rule {
    pub fn default_rules() -> Vec<Rule> {
        vec![
            Rule {
                id: "due".into(),
                name: "Due reminder".into(),
                kind: RuleKind::Due,
                filter: String::new(),
                offset_minutes: 0,
                digest_hour: 8,
                enabled: true,
            },
            Rule {
                id: "digest".into(),
                name: "Morning digest".into(),
                kind: RuleKind::Digest,
                filter: String::new(),
                offset_minutes: 0,
                digest_hour: 8,
                enabled: false,
            },
        ]
    }
}

/// What has been shown already, saved between runs.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderState {
    /// "rule|uuid|due" -> when the reminder was shown.
    #[serde(default)]
    pub sent: HashMap<String, i64>,
    /// rule id -> the local date its digest was last shown.
    #[serde(default)]
    pub digest_days: HashMap<String, String>,
}

/// A task a due rule covers.
#[derive(Debug, Clone)]
pub struct DueItem {
    pub rule_id: String,
    pub uuid: String,
    pub description: String,
    pub project: Option<String>,
    pub due: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// `task _commands`, for checking filters.
pub async fn commands(s: &Session<'_>) -> Result<Vec<String>> {
    Ok(s.read(["_commands"]).await?.lines().map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()).collect())
}

/// Ask `task` which tasks each enabled due rule covers.
pub async fn build_index(s: &Session<'_>, rules: &[Rule]) -> Result<Vec<DueItem>> {
    let cmds = commands(s).await?;
    let mut out = Vec::new();
    for rule in rules.iter().filter(|r| r.enabled && r.kind == RuleKind::Due) {
        let Ok(filter) = parse_filter(&rule.filter, &cmds) else { continue };
        let mut args = grouped(filter);
        args.extend(["status:pending", "due.any:", "export"].map(String::from));
        let Ok(stdout) = s.read(args).await else { continue };
        for t in parse_export(&stdout)? {
            let (Some(uuid), Some(due)) = (str_field(&t, "uuid"), str_field(&t, "due").and_then(|d| tw_epoch(&d)))
            else {
                continue;
            };
            out.push(DueItem {
                rule_id: rule.id.clone(),
                uuid,
                description: str_field(&t, "description").unwrap_or_default(),
                project: str_field(&t, "project"),
                due,
            });
        }
    }
    Ok(out)
}

/// How many tasks a rule's filter matches, to check it while editing.
pub async fn preview(s: &Session<'_>, rule: &Rule) -> Result<usize> {
    let cmds = commands(s).await?;
    let mut args = grouped(parse_filter(&rule.filter, &cmds)?);
    args.push("status:pending".into());
    if rule.kind == RuleKind::Due {
        args.push("due.any:".into());
    }
    args.push("export".into());
    Ok(parse_export(&s.read(args).await?)?.len())
}

fn str_field(t: &Value, k: &str) -> Option<String> {
    t.get(k).and_then(Value::as_str).map(String::from)
}

fn time_label(epoch: i64) -> String {
    match Local.timestamp_opt(epoch, 0).single() {
        Some(d) if d.date_naive() == Local::now().date_naive() => d.format("%H:%M").to_string(),
        Some(d) => d.format("%a %-d %b %H:%M").to_string(),
        None => String::new(),
    }
}

/// The due reminders to show now. Marks them as shown in `state`.
pub fn due_notices(index: &[DueItem], rules: &[Rule], state: &mut ReminderState, now: i64) -> Vec<Notice> {
    let offsets: HashMap<&str, i64> = rules
        .iter()
        .filter(|r| r.enabled && r.kind == RuleKind::Due)
        .map(|r| (r.id.as_str(), r.offset_minutes))
        .collect();
    let mut ready: Vec<&DueItem> = Vec::new();
    for item in index {
        let Some(offset) = offsets.get(item.rule_id.as_str()) else { continue };
        let at = item.due - offset * 60;
        let key = format!("{}|{}|{}", item.rule_id, item.uuid, item.due);
        if at <= now && now - at <= MISSED_WINDOW && !state.sent.contains_key(&key) {
            state.sent.insert(key, now);
            // Two rules covering the same task remind once.
            if !ready.iter().any(|r| r.uuid == item.uuid) {
                ready.push(item);
            }
        }
    }
    // Forget reminders for dates long past.
    state.sent.retain(|_, sent| now - *sent < 30 * 86400);

    ready.sort_by_key(|i| i.due);
    if ready.len() > MAX_SEPARATE {
        let body = ready.iter().take(4).map(|i| format!("• {}", i.description)).collect::<Vec<_>>().join("\n");
        return vec![Notice { title: format!("{} tasks need attention", ready.len()), body }];
    }
    ready
        .into_iter()
        .map(|i| {
            let when = if i.due <= now {
                format!("Due {}", time_label(i.due))
            } else {
                format!("Due at {}", time_label(i.due))
            };
            let body = match &i.project {
                Some(p) => format!("{when} · {p}"),
                None => when,
            };
            Notice { title: i.description.clone(), body }
        })
        .collect()
}

/// Digest rules whose hour has come today and that haven't been shown today.
pub fn digests_due<'a>(rules: &'a [Rule], state: &ReminderState, now: DateTime<Local>) -> Vec<&'a Rule> {
    let today = now.format("%Y-%m-%d").to_string();
    rules
        .iter()
        .filter(|r| r.enabled && r.kind == RuleKind::Digest)
        .filter(|r| chrono::Timelike::hour(&now) >= r.digest_hour)
        .filter(|r| state.digest_days.get(&r.id) != Some(&today))
        .collect()
}

/// Build one digest: what's due today or overdue under the rule's filter.
/// Returns None when there's nothing to say.
pub async fn digest(s: &Session<'_>, rule: &Rule, now: i64) -> Result<Option<Notice>> {
    let cmds = commands(s).await?;
    let mut args = grouped(parse_filter(&rule.filter, &cmds)?);
    args.extend(["status:pending", "due.before:tomorrow", "export"].map(String::from));
    let mut tasks: Vec<(i64, String)> = parse_export(&s.read(args).await?)?
        .iter()
        .filter_map(|t| Some((tw_epoch(&str_field(t, "due")?)?, str_field(t, "description")?)))
        .collect();
    if tasks.is_empty() {
        return Ok(None);
    }
    tasks.sort();
    // Overdue means due before today, as in the app's Today view.
    let today_start = Local
        .timestamp_opt(now, 0)
        .single()
        .and_then(|n| n.date_naive().and_hms_opt(0, 0, 0))
        .and_then(|d| d.and_local_timezone(Local).earliest())
        .map_or(now, |d| d.timestamp());
    let overdue = tasks.iter().filter(|(d, _)| *d < today_start).count();
    let today = tasks.len() - overdue;
    let mut parts = Vec::new();
    if today > 0 {
        parts.push(format!("{today} due today"));
    }
    if overdue > 0 {
        parts.push(format!("{overdue} overdue"));
    }
    let list = tasks.iter().take(4).map(|(_, d)| format!("• {d}")).collect::<Vec<_>>().join("\n");
    Ok(Some(Notice { title: format!("{}: {}", rule.name, parts.join(", ")), body: list }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(uuid: &str, due: i64) -> DueItem {
        DueItem { rule_id: "due".into(), uuid: uuid.into(), description: format!("task {uuid}"), project: None, due }
    }

    #[test]
    fn reminds_once_when_due() {
        let rules = Rule::default_rules();
        let mut st = ReminderState::default();
        let idx = vec![item("a", 1_000_000), item("b", 1_000_600)];
        assert!(due_notices(&idx, &rules, &mut st, 999_000).is_empty());
        let n = due_notices(&idx, &rules, &mut st, 1_000_010);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].title, "task a");
        assert!(due_notices(&idx, &rules, &mut st, 1_000_020).is_empty());
        assert_eq!(due_notices(&idx, &rules, &mut st, 1_000_700).len(), 1);
    }

    #[test]
    fn offsets_and_old_reminders() {
        let mut rules = Rule::default_rules();
        rules[0].offset_minutes = 15;
        let mut st = ReminderState::default();
        let idx = vec![item("a", 10_000_000), item("old", 1_000)];
        let n = due_notices(&idx, &rules, &mut st, 10_000_000 - 15 * 60);
        assert_eq!(n.len(), 1, "fires 15 minutes early, skips the one missed long ago");
    }

    #[test]
    fn many_become_one() {
        let rules = Rule::default_rules();
        let mut st = ReminderState::default();
        let idx: Vec<_> = (0..6).map(|i| item(&format!("t{i}"), 5_000 + i)).collect();
        let n = due_notices(&idx, &rules, &mut st, 6_000);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].title, "6 tasks need attention");
    }

    #[test]
    fn digest_once_a_day_after_its_hour() {
        let mut rules = Rule::default_rules();
        rules[1].enabled = true;
        let mut st = ReminderState::default();
        let early = Local.with_ymd_and_hms(2026, 10, 8, 7, 0, 0).unwrap();
        let later = Local.with_ymd_and_hms(2026, 10, 8, 9, 0, 0).unwrap();
        assert!(digests_due(&rules, &st, early).is_empty());
        assert_eq!(digests_due(&rules, &st, later).len(), 1);
        st.digest_days.insert("digest".into(), "2026-10-08".into());
        assert!(digests_due(&rules, &st, later).is_empty());
    }
}
