# How warrior works

warrior is a graphical front end for the Taskwarrior 3 `task` program already installed on your computer. Every read and every change goes through `task`, against your own data and `.taskrc`. Nothing about how Taskwarrior behaves is reimplemented: filters, urgency, dates, recurrence, contexts, UDAs, reports and hooks all come from your own setup.

## Architecture

```
┌──────────────────────────── your computer ─────────────────────────────┐
│                                                                        │
│  ┌──────────────────────── warrior (Tauri 2) ───────────────────────┐  │
│  │                                                                  │  │
│  │  UI (React, src/)                                                │  │
│  │      │  Tauri commands (invoke)                                  │  │
│  │      ▼                                                           │  │
│  │  Rust (core/, src-tauri/)                                        │  │
│  │   • task runner: spawns `task` with an argv list, never a shell  │  │
│  │   • task cache: the last `task export`, refreshed on change      │  │
│  │   • file watcher on the data directory                           │  │
│  │   • background sync and local notifications                      │  │
│  └───────────────┬──────────────────────────────────────────────────┘  │
│                  │ argv                                                │
│                  ▼                                                     │
│        `task` (Taskwarrior 3)                                          │
│                  │                                                     │
│                  ▼                                                     │
│        ~/.task (data) + ~/.taskrc (config, hooks, sync settings)       │
└──────────────────┼─────────────────────────────────────────────────────┘
                   │ task sync
                   ▼
   TaskChampion sync server, folder or cloud bucket
   ▲
   └── your other machines
```

Tauri builds for macOS, Windows and Linux from one codebase, with small installers that use the system web view. `core/` has no GUI dependencies, so it builds and tests anywhere.

## Running `task`

From `core/src/runner.rs`:

- **Always an argv list, never a shell.** What you type can't become shell syntax.
- **Fixed overrides on every call** so output is predictable and nothing waits for input: `rc.confirmation=off`, `rc.recurrence.confirmation=no`, `rc.color=off`, `rc.json.array=on`, `rc.detection=off`, `rc.verbose=…`. stdin is closed unless a command needs an answer (`undo` gets `yes`).
- **Your `bulk` setting applies.** A command that would change more tasks than `bulk` allows asks for confirmation. With stdin closed the answer is no, so nothing changes, and the app says to run it in a terminal.
- **One command at a time** from the app, so its own changes never race each other. Concurrency with a terminal is handled by `task` itself, as it is between two terminals.
- **Timeouts** (30 s) with a clear error if a hook or sync hangs.
- **Hooks run**, because they're part of your setup. If a hook rejects a change, the app shows its message.

### Reading tasks

- `task export` gives every task as JSON, including `urgency`, which the app sorts by exactly as `task next` would.
- The app keeps the last export in memory. It refreshes it after its own commands and when the file watcher sees the data directory change (you ran `task` in a terminal, or a sync came in).
- It exports pending, waiting and recurring tasks plus recently completed and deleted ones (90 days by default), and loads older history on demand.
- Views (Next, Today, Upcoming, Waiting, Completed, Deleted) are built from that export.
- **Saved views are Taskwarrior custom reports**: `report.<name>.description`, `.filter` and `.sort` in `.taskrc`, written with `task config`. `task <name>` shows the same list in a terminal, and reports you wrote by hand appear in the sidebar. Taskwarrior's built-in reports are left out.
- **The filter bar** narrows any view with a `task` filter. `task` runs the filter (`( filter ) _unique uuid`), so it behaves exactly as in a terminal.

### Changing tasks

| Change | Command |
| --- | --- |
| Quick add | `task add <words>` (Taskwarrior's own parsing, so `project:home due:fri +errand` just works) |
| Fields (project, tags, dates, priority, recurrence) | `task <uuid> modify …` |
| Description and notes | `task import -` with the task's JSON, so any text is safe and annotations can be edited in place |
| Done, delete, start, stop, restore | `task <uuid> done` etc. |
| Undo | `task undo` |

Dates typed in the app (`eow`, `monday`, `2026-11-01T09:00`) are passed to `task` unchanged.

### Command panel

`:` opens a panel that runs any `task` command and shows the output. It's your own machine and your own `task`, so nothing is blocked. Interactive commands such as `edit` need a terminal, and the panel says so.

### Finding `task`

- The app uses the path set in Settings, else the first `task` on the `PATH`, else common install locations (Homebrew, `/usr/local/bin`, `/usr/bin`, Nix, Snap, `~/.local/bin`). Apps started from the Finder or a desktop menu often don't get the shell's `PATH`.
- It needs Taskwarrior 3.0 or later, and explains how to install or upgrade otherwise.
- It respects `TASKRC` and `TASKDATA`, and Settings can point it at a different `.taskrc`.
- On Windows it can run `task` inside WSL (`wsl task …`).

## Sync

- The app runs `task sync` with the sync settings already in `.taskrc`, so existing setups need nothing.
- Settings can write a TaskChampion server's URL, client ID and encryption secret with `task config`, and can generate a new client ID and secret for a first machine. Folder, Google Cloud Storage and Amazon S3 sync set up in `.taskrc` work too.
- It syncs a few seconds after a change, and in the background at an interval set in Settings.
- Joining an existing sync account from a `.task` that already has tasks can fail with "410 Gone" on servers that prune old history. The app detects that and offers the fix: back up the data directory, start from an empty one, sync to pull the account down, then `task import` the local-only tasks and sync again.

## Notifications

- Reminder rules use any `task` filter: "when due" or "N minutes before", and a daily digest at a chosen hour. No server or email is involved.
- The app can stay in the system tray and start at login. Reminders missed while the computer was off appear when it's back.
