//! Spawning `task`. Always an argv list, never a shell, one command at a time.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex as AsyncMutex, MutexGuard};

use crate::error::{Error, Result};

/// Overrides on every call so output is predictable and nothing waits for
/// input. Hooks stay on: they're part of the user's setup. The user's `bulk`
/// stays too: the app's own changes touch one task at a time, and a command
/// typed into the panel that would change more gets task's yes/no prompt,
/// which reads no from the closed stdin and changes nothing.
const FIXED_RC: &[&str] = &[
    "rc.confirmation=off",
    "rc.recurrence.confirmation=no",
    "rc.color=off",
    "rc.json.array=on",
    "rc.detection=off",
    "rc.defaultwidth=120",
    "rc.news.version=99.0.0",
];

/// What the command panel and changes show: everything except the header
/// lines (which only repeat the overrides above).
const VERBOSE_NORMAL: &str = "rc.verbose=affected,blank,edit,footnote,label,new-id,project,special,sync,recur";
/// For reads the app parses.
const VERBOSE_QUIET: &str = "rc.verbose=nothing";

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// How to start `task`: a program, plus arguments in front (`wsl.exe -e` on
/// Windows when Taskwarrior lives inside WSL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskCommand {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

impl TaskCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), prefix: Vec::new() }
    }
}

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// None when `task` wasn't found; every run then fails with NotFound.
    pub command: Option<TaskCommand>,
    /// Overrides TASKRC. None keeps the environment's (or ~/.taskrc).
    pub taskrc: Option<PathBuf>,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    /// stdout and stderr together, as a terminal would show them.
    pub fn combined(&self) -> String {
        [self.stdout.trim_end(), self.stderr.trim_end()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn error_message(&self) -> String {
        let msg = if self.stderr.trim().is_empty() { self.stdout.trim() } else { self.stderr.trim() };
        if msg.is_empty() {
            format!("task exited with code {}", self.code)
        } else {
            msg.to_string()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verbosity {
    Quiet,
    Normal,
}

pub struct Runner {
    config: RwLock<RunnerConfig>,
    lock: AsyncMutex<()>,
    /// When the last `task` process ended, so the file watcher can tell the
    /// app's own writes from the user's.
    last_exit: Mutex<Option<Instant>>,
}

impl Runner {
    pub fn new(config: RunnerConfig) -> Self {
        Self { config: RwLock::new(config), lock: AsyncMutex::new(()), last_exit: Mutex::new(None) }
    }

    pub fn config(&self) -> RunnerConfig {
        self.config.read().unwrap().clone()
    }

    pub fn set_config(&self, config: RunnerConfig) {
        *self.config.write().unwrap() = config;
    }

    /// Wait for the app's other commands to finish, then run any number of
    /// commands without another of the app's commands in between.
    pub async fn session(&self) -> Session<'_> {
        Session { runner: self, _guard: self.lock.lock().await }
    }

    /// True while a command runs or just after, when changes in the data
    /// directory are almost certainly the app's own.
    pub fn recently_active(&self, within: Duration) -> bool {
        if self.lock.try_lock().is_err() {
            return true;
        }
        matches!(*self.last_exit.lock().unwrap(), Some(t) if t.elapsed() < within)
    }
}

pub struct Session<'a> {
    runner: &'a Runner,
    _guard: MutexGuard<'a, ()>,
}

impl Session<'_> {
    /// Run `task` and return whatever it printed, whatever its exit code.
    pub async fn run<I, S>(&self, args: I, stdin: Option<&str>, verbosity: Verbosity) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let cfg = self.runner.config();
        self.run_with(&cfg, args, stdin, verbosity, cfg.timeout).await
    }

    /// Like `run`, with its own time limit (sync can take longer).
    pub async fn run_timeout<I, S>(&self, args: I, timeout: Duration) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let cfg = self.runner.config();
        self.run_with(&cfg, args, None, Verbosity::Normal, timeout).await
    }

    /// Run with normal output and turn a non-zero exit into an error
    /// carrying task's (or a hook's) message.
    pub async fn must<I, S>(&self, args: I, stdin: Option<&str>) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let out = self.run(args, stdin, Verbosity::Normal).await?;
        if !out.ok() {
            return Err(Error::Task(out.error_message()));
        }
        Ok(out)
    }

    /// A read whose stdout the app parses.
    pub async fn read<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let out = self.run(args, None, Verbosity::Quiet).await?;
        if !out.ok() {
            return Err(Error::Task(out.error_message()));
        }
        Ok(out.stdout)
    }

    /// One configuration value, as `task _get rc.<key>` reports it.
    pub async fn get_config(&self, key: &str) -> Result<String> {
        Ok(self.read(["_get".to_string(), format!("rc.{key}")]).await?.trim().to_string())
    }

    async fn run_with<I, S>(
        &self,
        cfg: &RunnerConfig,
        args: I,
        stdin: Option<&str>,
        verbosity: Verbosity,
        timeout: Duration,
    ) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let command = cfg.command.as_ref().ok_or(Error::NotFound)?;
        let mut cmd = tokio::process::Command::new(&command.program);
        cmd.args(&command.prefix);
        if !command.prefix.is_empty() {
            // Through WSL, the program named after the prefix is `task`.
            cmd.arg("task");
        }
        cmd.args(FIXED_RC);
        cmd.arg(match verbosity {
            Verbosity::Quiet => VERBOSE_QUIET,
            Verbosity::Normal => VERBOSE_NORMAL,
        });
        cmd.args(args.into_iter().map(Into::into));
        if let Some(rc) = &cfg.taskrc {
            cmd.env("TASKRC", rc);
        }
        cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // Don't flash a console window for every command.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound
            } else {
                Error::Spawn(e)
            }
        })?;
        if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
            // A command that doesn't read stdin closes the pipe; that's fine.
            let _ = pipe.write_all(text.as_bytes()).await;
        }
        let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
        *self.runner.last_exit.lock().unwrap() = Some(Instant::now());
        let output = match result {
            Ok(r) => r.map_err(Error::Spawn)?,
            // Dropping the future drops the child, which kills it.
            Err(_) => return Err(Error::Timeout(timeout.as_secs())),
        };
        Ok(Output {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}
