// What the task views need from the local `task` program. The views only use
// this interface; src/tauri.ts implements it with the app's Rust commands.

import type { Changes } from "./lib";

export type TaskAction = "done" | "delete" | "start" | "stop" | "restore";

export type TaskPatch = Partial<{
  description: string;
  annotations: { entry: string; description: string }[];
  project: string;
  tags: string[];
  due: string | null;
  scheduled: string | null;
  wait: string | null;
  until: string | null;
  priority: string;
  recur: string;
}>;

export interface CommandResult extends Changes {
  output: string;
  ok: boolean;
}

/** What one Taskwarrior filter matched: task UUIDs of any status, or why it couldn't run. */
export interface FilterMatch {
  uuids: string[];
  error: string | null;
}

/** A Taskwarrior custom report (report.<name>.* in .taskrc), shown as a view. */
export interface Report {
  /** The word after `task`, e.g. thisweek. */
  name: string;
  /** The report's description, shown as the view's name. */
  description: string;
  filter: string;
  /** Taskwarrior sort order, e.g. due+,urgency- */
  sort: string;
}

export interface ReportInput {
  /** The report to change, or null to make one. */
  name: string | null;
  description: string;
  filter: string;
  sort: string;
}

export interface Backend {
  add(line: string): Promise<Changes & { uuid: string | null }>;
  update(uuid: string, patch: TaskPatch): Promise<Changes>;
  action(uuid: string, action: TaskAction): Promise<Changes>;
  /** The command panel. */
  command(line: string): Promise<CommandResult>;
  /** Run Taskwarrior filters. */
  match(filters: string[]): Promise<FilterMatch[]>;
  /** The user's custom reports. */
  reports: {
    list(): Promise<Report[]>;
    save(report: ReportInput): Promise<Report>;
    remove(name: string): Promise<void>;
  };
}
