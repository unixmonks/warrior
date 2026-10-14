use serde::{Serialize, Serializer};

/// Every message here is meant to be shown to the user as is.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Something the user typed that can't be passed to `task`.
    #[error("{0}")]
    Input(String),
    /// `task` ran and reported a problem (its own message, or a hook's).
    #[error("{0}")]
    Task(String),
    #[error("task didn't finish within {0} seconds and was stopped. A hook or a sync server may be stuck.")]
    Timeout(u64),
    #[error(
        "warrior couldn't find Taskwarrior's `task` program. Install Taskwarrior 3, or set its location in Settings."
    )]
    NotFound,
    #[error("Couldn't run task: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("task printed something warrior couldn't read: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub(crate) fn input(msg: impl Into<String>) -> Error {
    Error::Input(msg.into())
}

// Tauri sends command errors to the UI as JSON; a plain message is all it needs.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
