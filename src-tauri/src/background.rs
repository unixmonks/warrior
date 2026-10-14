//! Work that happens while the app is open: periodic sync and reminders.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use warrior_core::reminders::{self, Notice};

use crate::state::{publish, run_sync, AppState};

const TICK: Duration = Duration::from_secs(30);
/// Rebuild the reminder list this often even without changes, so a rule
/// with a filter like `due.before:eow` stays current.
const INDEX_MAX_AGE: Duration = Duration::from_secs(15 * 60);
/// Under WSL there's no file watcher; look for outside changes this often.
const WSL_POLL: Duration = Duration::from_secs(60);

pub async fn run(app: AppHandle) {
    let mut first = true;
    let mut last_poll = Instant::now();
    loop {
        let state = app.state::<AppState>();
        let status = state.status();
        if status.ok {
            let settings = state.settings();
            let sync = state.sync_status();
            let interval = Duration::from_secs(u64::from(settings.sync_interval_minutes.max(1)) * 60);
            let due = sync.last_attempt.is_none_or(|t| t.elapsed() >= interval);
            if settings.auto_sync && sync.config.configured() && !sync.running && (first || due) {
                let _ = run_sync(&app, false).await;
            }
            if status.wsl && last_poll.elapsed() >= WSL_POLL {
                last_poll = Instant::now();
                if let Ok(changes) = state.store.refresh().await {
                    publish(&app, &changes);
                }
            }
            if settings.notifications {
                check_reminders(&app).await;
            }
            first = false;
        }
        tokio::time::sleep(TICK).await;
    }
}

async fn check_reminders(app: &AppHandle) {
    let state = app.state::<AppState>();
    let rules = state.settings().rules;
    let mut rem = state.reminders.lock().await;
    let stale = rem.built.is_none_or(|t| t.elapsed() >= INDEX_MAX_AGE);
    if state.take_reminders_dirty() || stale {
        let s = state.store.runner().session().await;
        if let Ok(index) = reminders::build_index(&s, &rules).await {
            rem.index = index;
            rem.built = Some(Instant::now());
        }
    }

    let now = chrono::Utc::now().timestamp();
    let before = rem.state.sent.len();
    let index = std::mem::take(&mut rem.index);
    let mut notices = reminders::due_notices(&index, &rules, &mut rem.state, now);
    rem.index = index;
    let mut changed = rem.state.sent.len() != before;

    let today = chrono::Local::now();
    let digests: Vec<_> = reminders::digests_due(&rules, &rem.state, today).into_iter().cloned().collect();
    for rule in digests {
        let s = state.store.runner().session().await;
        if let Ok(found) = reminders::digest(&s, &rule, now).await {
            notices.extend(found);
        }
        rem.state.digest_days.insert(rule.id.clone(), today.format("%Y-%m-%d").to_string());
        changed = true;
    }

    for n in notices {
        notify(app, &n);
    }
    if changed {
        state.save_reminder_state(&rem.state);
    }
}

pub fn notify(app: &AppHandle, n: &Notice) {
    if let Err(e) = app.notification().builder().title(&n.title).body(&n.body).show() {
        eprintln!("warrior: notification failed: {e}");
    }
}
