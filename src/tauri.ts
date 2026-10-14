// The desktop app's Rust side, as typed functions. Names and shapes match
// src-tauri/src/commands.rs.

import { invoke } from "@tauri-apps/api/core";
import type { Backend, CommandResult, FilterMatch, Report, ReportInput } from "./ui/backend";
import type { Changes, Task } from "./ui/lib";

export interface TaskStatus {
  checked: boolean;
  ok: boolean;
  path: string | null;
  version: string | null;
  message: string | null;
  needsTaskrc: boolean;
  taskrc: string | null;
  dataDir: string | null;
  platform: string;
  wsl: boolean;
  tray: boolean;
}

export interface SyncConfig {
  kind: "server" | "local" | "gcp" | "aws" | "none" | "";
  url: string | null;
  clientId: string | null;
  hasSecret: boolean;
  localDir: string | null;
  bucket: string | null;
  dataDir: string | null;
}

export interface SyncState {
  config: SyncConfig;
  auto: boolean;
  running: boolean;
  /** Unix seconds. */
  lastAt: number | null;
  lastOk: boolean | null;
  lastMessage: string | null;
  needsJoin: boolean;
}

export interface SyncResult extends Changes {
  ok: boolean;
  message: string;
  needsJoin: boolean;
}

export interface Rule {
  id: string;
  name: string;
  kind: "due" | "digest";
  filter: string;
  offsetMinutes: number;
  digestHour: number;
  enabled: boolean;
}

export interface AppSettings {
  taskPath: string | null;
  taskrc: string | null;
  useWsl: boolean;
  autoSync: boolean;
  syncIntervalMinutes: number;
  historyDays: number;
  notifications: boolean;
  rules: Rule[];
  closeToTray: boolean;
}

export function syncConfigured(c: SyncConfig): boolean {
  return c.kind !== "none" && c.kind !== "";
}

/** Rust errors arrive as plain strings; the shared UI expects Error objects. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : (e as Error)?.message ?? String(e));
  }
}

export const desktop = {
  status: () => call<TaskStatus>("app_status"),
  recheck: () => call<TaskStatus>("recheck_task"),
  createTaskrc: () => call<TaskStatus>("create_taskrc"),
  list: () => call<{ tasks: Task[]; historyComplete: boolean }>("list_tasks"),
  refresh: () => call<Changes>("refresh_tasks"),
  loadHistory: () => call<Changes>("load_history"),
  syncState: () => call<SyncState>("sync_state"),
  syncNow: () => call<SyncResult>("sync_now"),
  syncConfigure: (url: string, clientId: string, secret: string | null) =>
    call<SyncResult>("sync_configure", { url, clientId, secret }),
  syncJoin: () => call<SyncResult>("sync_join"),
  getSettings: () => call<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) => call<AppSettings>("save_settings", { settings }),
  previewRule: (rule: Rule) => call<number>("preview_rule", { rule }),
  testNotification: () => call<void>("test_notification"),
  exportTasks: (path: string) => call<number>("export_tasks", { path }),
  importTasks: (path: string) => call<CommandResult>("import_tasks", { path }),
};

export const tauriBackend: Backend = {
  add: (line) => call("add_task", { line }),
  update: (uuid, patch) => call("update_task", { uuid, patch }),
  action: (uuid, action) => call("task_action", { uuid, action }),
  command: (line) => call("run_command", { line }),
  match: (filters) => call<FilterMatch[]>("match_filters", { filters }),
  reports: {
    list: () => call<Report[]>("list_reports"),
    save: (report: ReportInput) => call<Report>("save_report", { report }),
    remove: (name) => call<void>("delete_report", { name }),
  },
};
