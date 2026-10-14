//! Saved views are Taskwarrior custom reports: `report.<name>.filter` and
//! friends in the user's .taskrc. A report made in the app also works as
//! `task <name>` in a terminal, and one written by hand shows up in the app.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::args::{grouped, is_uuid, parse_filter};
use crate::error::{input, Result};
use crate::reminders::commands;
use crate::runner::Session;

/// The reports Taskwarrior 3 defines itself (`task _show` with an empty
/// .taskrc). They're the terminal's, not the user's, so they stay out of the
/// sidebar.
const BUILT_IN: &[&str] = &[
    "active",
    "all",
    "blocked",
    "blocking",
    "completed",
    "list",
    "long",
    "ls",
    "minimal",
    "newest",
    "next",
    "oldest",
    "overdue",
    "ready",
    "recurring",
    "timesheet",
    "unblocked",
    "waiting",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The word after `task`, e.g. `thisweek`.
    pub name: String,
    /// What the sidebar shows; Taskwarrior's `description`.
    pub description: String,
    pub filter: String,
    /// Taskwarrior's sort spec, e.g. `due+,urgency-`.
    pub sort: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportInput {
    /// The report to change; None makes a new one named after `description`.
    pub name: Option<String>,
    pub description: String,
    pub filter: String,
    pub sort: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FilterMatch {
    pub uuids: Vec<String>,
    pub error: Option<String>,
}

/// The user's own reports, in name order.
pub async fn list(s: &Session<'_>) -> Result<Vec<Report>> {
    Ok(parse_show(&s.read(["_show"]).await?))
}

fn parse_show(show: &str) -> Vec<Report> {
    let mut reports: BTreeMap<String, Report> = BTreeMap::new();
    for line in show.lines() {
        let Some(rest) = line.strip_prefix("report.") else { continue };
        let Some((key, value)) = rest.split_once('=') else { continue };
        let Some((name, attr)) = key.rsplit_once('.') else { continue };
        if BUILT_IN.contains(&name) {
            continue;
        }
        let r =
            reports.entry(name.to_string()).or_insert_with(|| Report { name: name.to_string(), ..Default::default() });
        match attr {
            "description" => r.description = value.to_string(),
            "filter" => r.filter = value.to_string(),
            "sort" => r.sort = value.to_string(),
            _ => {}
        }
    }
    reports
        .into_values()
        .map(|mut r| {
            if r.description.is_empty() {
                r.description = r.name.clone();
            }
            r
        })
        .collect()
}

/// A report name from a display name: "This Week" -> "thisweek". It must not
/// clash with a command or another report, so add a number if it would.
fn report_name(description: &str, taken: impl Fn(&str) -> bool) -> String {
    let mut base: String =
        description.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    if base.len() < 2 || base.starts_with(|c: char| c.is_ascii_digit()) {
        base = format!("view{base}");
    }
    if !taken(&base) {
        return base;
    }
    (2..).map(|n| format!("{base}{n}")).find(|n| !taken(n)).unwrap()
}

/// Create or change a report with `task config`, as the user would.
pub async fn save(s: &Session<'_>, r: ReportInput) -> Result<Report> {
    let description = r.description.trim();
    if description.is_empty() {
        return Err(input("Give the view a name"));
    }
    if description.contains(['\n', '\r']) {
        return Err(input("The name must be one line"));
    }
    let filter = r.filter.trim();
    if filter.contains(['\n', '\r']) {
        return Err(input("The filter must be one line"));
    }
    let cmds = commands(s).await?;
    parse_filter(filter, &cmds)?;
    let sort = r.sort.trim();
    if !sort.chars().all(|c| c.is_ascii_alphanumeric() || "+-/,._".contains(c)) {
        return Err(input("That isn't a Taskwarrior sort order"));
    }

    let existing = list(s).await?;
    let name = match r.name {
        Some(name) => {
            if !existing.iter().any(|e| e.name == name) {
                return Err(input("That view no longer exists"));
            }
            name
        }
        None => {
            let name = report_name(description, |n| {
                cmds.iter().any(|c| c == n) || existing.iter().any(|e| e.name == n) || BUILT_IN.contains(&n)
            });
            // A new report needs columns for `task <name>` to work in a
            // terminal; borrow the user's `list` layout.
            let columns = s.get_config("report.list.columns").await?;
            let labels = s.get_config("report.list.labels").await?;
            if !columns.is_empty() {
                s.must(["config".into(), format!("report.{name}.columns"), columns], None).await?;
            }
            if !labels.is_empty() {
                s.must(["config".into(), format!("report.{name}.labels"), labels], None).await?;
            }
            name
        }
    };
    s.must(["config".into(), format!("report.{name}.description"), description.to_string()], None).await?;
    s.must(["config".into(), format!("report.{name}.filter"), filter.to_string()], None).await?;
    if sort.is_empty() {
        s.must(["config".into(), format!("report.{name}.sort")], None).await?;
    } else {
        s.must(["config".into(), format!("report.{name}.sort"), sort.to_string()], None).await?;
    }
    list(s).await?.into_iter().find(|e| e.name == name).ok_or_else(|| input("The view wasn't saved"))
}

/// Remove every `report.<name>.*` setting.
pub async fn delete(s: &Session<'_>, name: &str) -> Result<()> {
    if BUILT_IN.contains(&name) {
        return Err(input("That's one of Taskwarrior's own reports"));
    }
    let prefix = format!("report.{name}.");
    let keys: Vec<String> = s
        .read(["_show"])
        .await?
        .lines()
        .filter_map(|l| l.split_once('=').map(|(k, _)| k))
        .filter(|k| k.strip_prefix(&prefix).is_some_and(|attr| !attr.contains('.')))
        .map(String::from)
        .collect();
    if keys.is_empty() {
        return Err(input("That view no longer exists"));
    }
    for key in keys {
        s.must(["config".to_string(), key], None).await?;
    }
    Ok(())
}

/// The UUIDs each filter matches, across all tasks of any status. A filter
/// that's invalid, or that names a command, gets an error instead.
pub async fn matches(s: &Session<'_>, filters: &[String]) -> Result<Vec<FilterMatch>> {
    let cmds = commands(s).await?;
    let mut out = Vec::with_capacity(filters.len());
    for filter in filters {
        let m = match parse_filter(filter, &cmds) {
            Err(e) => FilterMatch { uuids: Vec::new(), error: Some(e.to_string()) },
            Ok(args) => {
                let mut args = grouped(args);
                args.extend(["_unique".to_string(), "uuid".to_string()]);
                match s.read(args).await {
                    Ok(stdout) => FilterMatch {
                        uuids: stdout.lines().map(str::trim).filter(|l| is_uuid(l)).map(String::from).collect(),
                        error: None,
                    },
                    Err(e) => FilterMatch { uuids: Vec::new(), error: Some(e.to_string()) },
                }
            }
        };
        out.push(m);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_user_reports_only() {
        let show = "report.next.filter=status:pending -WAITING limit:page\n\
                    report.thisweek.description=This Week\n\
                    report.thisweek.filter=status:pending +WEEK\n\
                    report.thisweek.sort=due+\n\
                    report.bare.filter=project:x\n\
                    report.a.b.filter=odd\n\
                    rc.x=1\n";
        let r = parse_show(show);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].name, "a.b");
        assert_eq!(
            r[1],
            Report { name: "bare".into(), description: "bare".into(), filter: "project:x".into(), sort: "".into() }
        );
        assert_eq!(r[2].description, "This Week");
        assert_eq!(r[2].sort, "due+");
    }

    #[test]
    fn names_reports() {
        let free = |_: &str| false;
        assert_eq!(report_name("This Week", free), "thisweek");
        assert_eq!(report_name("Work: urgent!", free), "workurgent");
        assert_eq!(report_name("Été", free), "viewt");
        assert_eq!(report_name("2026", free), "view2026");
        assert_eq!(report_name("Projects", |n| n == "projects" || n == "projects2"), "projects3");
    }
}
