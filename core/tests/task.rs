//! Runs against the real `task` on this machine with a throwaway .taskrc and
//! data directory. Skipped when Taskwarrior 3 isn't installed.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use warrior_core::reminders::{self, Rule, RuleKind};
use warrior_core::runner::DEFAULT_TIMEOUT;
use warrior_core::{locate, sync, Runner, RunnerConfig, TaskAction, TaskCommand, TaskPatch, TaskStore};

struct Env {
    _dir: tempfile::TempDir,
    store: TaskStore,
}

async fn setup() -> Option<Env> {
    let program = locate::find_task(None)?;
    let cmd = TaskCommand::new(program);
    if locate::task_version(&cmd).await.ok()? < locate::MINIMUM {
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let rc = dir.path().join("taskrc");
    std::fs::write(&rc, format!("data.location={}\nnews.version=99.0.0\n", data.display())).unwrap();
    let runner = Arc::new(Runner::new(RunnerConfig { command: Some(cmd), taskrc: Some(rc), timeout: DEFAULT_TIMEOUT }));
    Some(Env { _dir: dir, store: TaskStore::new(runner, Some(90)) })
}

macro_rules! env_or_skip {
    () => {
        match setup().await {
            Some(e) => e,
            None => {
                eprintln!("skipping: Taskwarrior 3 not installed");
                return;
            }
        }
    };
}

fn field<'a>(t: &'a Value, k: &str) -> Option<&'a str> {
    t.get(k).and_then(Value::as_str)
}

#[tokio::test(flavor = "multi_thread")]
async fn add_edit_complete_undo() {
    let env = env_or_skip!();
    let s = &env.store;
    assert!(s.list().await.unwrap().is_empty());

    let added = s.add("Call Sam project:home +phone due:tomorrow").await.unwrap();
    let uuid = added.uuid.clone().expect("new uuid");
    assert_eq!(added.changes.changed.len(), 1);
    let t = &added.changes.changed[0];
    assert_eq!(field(t, "description"), Some("Call Sam"));
    assert_eq!(field(t, "project"), Some("home"));
    assert!(t.get("due").is_some());

    // Description and notes with characters the command line would mangle.
    let patch: TaskPatch = serde_json::from_value(serde_json::json!({
        "description": "Call Sam -- re: \"the plan\" project:nope",
        "annotations": [{ "entry": "", "description": "line one\nline two; rm -rf /" }],
        "tags": ["phone", "urgent"],
        "due": null,
        "priority": "H",
    }))
    .unwrap();
    let ch = s.update(&uuid, patch).await.unwrap();
    let t = ch.changed.iter().find(|t| field(t, "uuid") == Some(&uuid)).unwrap();
    assert_eq!(field(t, "description"), Some("Call Sam -- re: \"the plan\" project:nope"));
    assert_eq!(field(t, "project"), Some("home"));
    assert_eq!(field(t, "priority"), Some("H"));
    assert!(t.get("due").is_none());
    assert_eq!(t["annotations"][0]["description"], "line one\nline two; rm -rf /");
    let tags: Vec<&str> = t["tags"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(tags.contains(&"urgent") && tags.contains(&"phone"));

    let ch = s.action(&uuid, TaskAction::Done).await.unwrap();
    assert_eq!(field(&ch.changed[0], "status"), Some("completed"));
    let ch = s.action(&uuid, TaskAction::Restore).await.unwrap();
    assert_eq!(field(&ch.changed[0], "status"), Some("pending"));

    let undone = s.undo().await.unwrap();
    assert!(undone.ok);
    assert_eq!(field(&undone.changes.changed[0], "status"), Some("completed"));
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_waiting_tasks() {
    let env = env_or_skip!();
    let s = &env.store;
    s.add("Renew passport wait:+3d").await.unwrap();
    s.add("Today's thing").await.unwrap();
    s.refresh().await.unwrap();
    assert_eq!(s.list().await.unwrap().len(), 2);
    assert!(s
        .list()
        .await
        .unwrap()
        .iter()
        .any(|t| field(t, "description") == Some("Renew passport") && t.get("wait").is_some()));
}

#[tokio::test(flavor = "multi_thread")]
async fn command_panel_and_import() {
    let env = env_or_skip!();
    let s = &env.store;
    let r = s.command("add from the panel +x").await.unwrap();
    assert!(r.ok, "{}", r.output);
    assert_eq!(r.changes.changed.len(), 1);
    let r = s.command("task count").await.unwrap();
    assert_eq!(r.output.trim(), "1");
    assert!(r.changes.is_empty());
    let r = s.command("1 edit").await.unwrap();
    assert!(!r.ok && r.output.contains("terminal"));
    s.add("second").await.unwrap();
    s.add("third").await.unwrap();
    let r = s.command("status:pending delete").await.unwrap();
    assert!(!r.ok && r.output.contains("only a terminal"), "{}", r.output);
    assert_eq!(s.list().await.unwrap().iter().filter(|t| field(t, "status") == Some("pending")).count(), 3);
    s.command("/second|third/ delete").await.unwrap();
    let r = s.command("nosuchcommand_xyz").await.unwrap();
    assert!(r.changes.is_empty());

    let json = r#"[{"uuid":"11111111-2222-4333-8444-555555555555","description":"imported","status":"pending","entry":"20260101T000000Z","myuda":"kept"}]"#;
    let r = s.import_json(json).await.unwrap();
    assert!(r.ok);
    let all = s.list().await.unwrap();
    assert_eq!(all.iter().filter(|t| field(t, "status") == Some("pending")).count(), 2);
    let exported = s.export_all().await.unwrap();
    assert!(exported.contains("imported"));
}

#[tokio::test(flavor = "multi_thread")]
async fn hook_errors_reach_the_user() {
    let env = env_or_skip!();
    let s = &env.store;
    let err = s.action("6703cd38-95cd-442b-8d9e-4aa2bec2f1a2", TaskAction::Done).await;
    // No such task: task exits non-zero; the message is shown, not swallowed.
    assert!(err.is_err());
    assert!(s.update("not-a-uuid", TaskPatch::default()).await.is_err());
    assert!(s.add("   ").await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_settings_and_reminder_filters() {
    let env = env_or_skip!();
    let runner = env.store.runner().clone();
    let version = locate::task_version(runner.config().command.as_ref().unwrap()).await.unwrap();
    {
        let sess = runner.session().await;
        let cfg = sync::read_config(&sess).await.unwrap();
        assert_eq!(cfg.kind, "none");
        assert!(cfg.data_dir.is_some());
        assert!(sync::configure_server(&sess, version, "not a url", "x", None).await.is_err());
        sync::configure_server(
            &sess,
            version,
            "https://sync.example.invalid/",
            "7c1c9b4e-3f2a-4d5e-9b8c-1a2b3c4d5e6f",
            Some("s3cret-value"),
        )
        .await
        .unwrap();
        let cfg = sync::read_config(&sess).await.unwrap();
        assert_eq!(cfg.kind, "server");
        assert_eq!(cfg.url.as_deref(), Some("https://sync.example.invalid"));
        assert!(cfg.has_secret);
        // The server doesn't exist; the failure is reported, not thrown.
        let out = sync::sync(&sess).await.unwrap();
        assert!(!out.ok);
        assert!(!out.message.contains("s3cret-value"));
    }

    env.store.add("Pay rent due:today").await.unwrap();
    env.store.add("No date").await.unwrap();
    let sess = runner.session().await;
    let rules = Rule::default_rules();
    let idx = reminders::build_index(&sess, &rules).await.unwrap();
    assert_eq!(idx.len(), 1);
    assert_eq!(idx[0].description, "Pay rent");
    let mut bad = rules[0].clone();
    bad.filter = "project:x delete".into();
    assert!(reminders::preview(&sess, &bad).await.is_err());
    let digest = Rule { kind: RuleKind::Digest, ..rules[1].clone() };
    let notice = reminders::digest(&sess, &digest, chrono::Utc::now().timestamp()).await.unwrap().unwrap();
    assert!(notice.body.contains("Pay rent"));
}

#[tokio::test(flavor = "multi_thread")]
async fn join_restores_on_failure() {
    let env = env_or_skip!();
    env.store.add("keep me").await.unwrap();
    let runner = env.store.runner().clone();
    let sess = runner.session().await;
    let cfg = sync::read_config(&sess).await.unwrap();
    let data_dir = cfg.data_dir.unwrap();
    // No sync configured, so the first sync fails and the database comes back.
    let out = sync::join(&sess, Path::new(&data_dir)).await.unwrap();
    assert!(!out.ok);
    drop(sess);
    env.store.reset();
    let all = env.store.list().await.unwrap();
    assert_eq!(all.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_are_saved_views() {
    use warrior_core::reports::{self, ReportInput};
    let env = env_or_skip!();
    env.store.add("This week due:today").await.unwrap();
    env.store.add("Someday").await.unwrap();
    let s = env.store.runner().session().await;
    assert!(reports::list(&s).await.unwrap().is_empty(), "built-in reports are left out");

    let input = |name: Option<&str>, description: &str, filter: &str| ReportInput {
        name: name.map(String::from),
        description: description.into(),
        filter: filter.into(),
        sort: "due+".into(),
    };
    let r = reports::save(&s, input(None, "This Week", "status:pending +WEEK")).await.unwrap();
    assert_eq!((r.name.as_str(), r.description.as_str()), ("thisweek", "This Week"));
    // It's a real report: `task thisweek` works in a terminal.
    let out = s.run(["thisweek"], None, warrior_core::runner::Verbosity::Quiet).await.unwrap();
    assert!(out.ok() && out.stdout.contains("This week"), "{}", out.combined());
    // A name that's already a command gets a number.
    assert_eq!(reports::save(&s, input(None, "Next", "+x")).await.unwrap().name, "next2");

    let m =
        reports::matches(&s, &[r.filter.clone(), "due.before:blorp".into(), "project:x delete".into()]).await.unwrap();
    assert_eq!(m[0].uuids.len(), 1);
    assert!(m[1].error.is_some());
    assert!(m[2].error.as_deref().unwrap().contains("command"));

    let renamed = reports::save(&s, input(Some("thisweek"), "Week", "+WEEK")).await.unwrap();
    assert_eq!((renamed.name.as_str(), renamed.filter.as_str()), ("thisweek", "+WEEK"));
    assert!(reports::save(&s, input(None, "Bad", "project:x delete")).await.is_err());

    reports::delete(&s, "thisweek").await.unwrap();
    reports::delete(&s, "next2").await.unwrap();
    assert!(reports::list(&s).await.unwrap().is_empty());
    assert!(s.get_config("report.thisweek.columns").await.unwrap().is_empty());
}
