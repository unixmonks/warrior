//! The part of warrior that talks to Taskwarrior.
//!
//! Every read and every change goes through the user's own `task` program,
//! spawned with an argv list (never a shell). Nothing here reimplements
//! Taskwarrior: dates, filters, urgency and recurrence all come from `task`.

pub mod args;
pub mod error;
pub mod locate;
pub mod reminders;
pub mod reports;
pub mod runner;
pub mod sync;
pub mod tasks;

pub use error::{Error, Result};
pub use runner::{Runner, RunnerConfig, Session, TaskCommand};
pub use tasks::{Changes, TaskAction, TaskPatch, TaskStore};
