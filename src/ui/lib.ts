// Taskwarrior date helpers and the view definitions.

export interface Task {
  uuid: string;
  id?: number;
  description: string;
  status: "pending" | "completed" | "deleted" | "waiting" | "recurring";
  entry: string;
  modified?: string;
  end?: string;
  start?: string;
  due?: string;
  scheduled?: string;
  wait?: string;
  until?: string;
  project?: string;
  tags?: string[];
  priority?: string;
  recur?: string;
  parent?: string;
  depends?: string[];
  annotations?: { entry: string; description: string }[];
  urgency?: number;
}

export interface Changes {
  changed: Task[];
  removed: string[];
}

// ---- dates ----------------------------------------------------------------

/** Taskwarrior's 20261011T000000Z. */
export function twDate(s?: string): Date | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function dayDiff(d: Date, from = new Date()): number {
  return Math.round((startOfDay(d).getTime() - startOfDay(from).getTime()) / 86400000);
}

function hasTime(d: Date) {
  return !(d.getHours() === 0 && d.getMinutes() === 0) && !(d.getHours() === 23 && d.getMinutes() === 59);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** "Today 5:00 PM", "Tomorrow", "Fri", "Oct 21", "3d overdue". */
export function relDate(d: Date): string {
  const diff = dayDiff(d);
  const t = hasTime(d) ? ` ${timeFmt.format(d)}` : "";
  if (diff === 0) return `Today${t}`;
  if (diff === 1) return `Tomorrow${t}`;
  if (diff === -1) return `Yesterday${t}`;
  if (diff < -1) return `${-diff}d ago`;
  if (diff < 7) return `${weekdayFmt.format(d)}${t}`;
  return shortFmt.format(d) + (d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "");
}

export function longDate(d: Date): string {
  return longFmt.format(d);
}

export function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Value for <input type="datetime-local">. */
export function toLocalInput(d: Date | null): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- views ----------------------------------------------------------------

export type ViewKey =
  | { kind: "next" } | { kind: "today" } | { kind: "upcoming" } | { kind: "waiting" }
  | { kind: "completed" } | { kind: "trash" } | { kind: "project"; name: string } | { kind: "tag"; name: string }
  /** A Taskwarrior custom report; the caller passes only the tasks its filter matches. */
  | { kind: "report"; name: string };

export function isWaiting(t: Task, now = Date.now()): boolean {
  const w = twDate(t.wait);
  return t.status === "waiting" || (t.status === "pending" && !!w && w.getTime() > now);
}

export function isOpen(t: Task): boolean {
  return t.status === "pending" && !isWaiting(t);
}

export function byUrgency(a: Task, b: Task) {
  return (b.urgency ?? 0) - (a.urgency ?? 0) || a.entry.localeCompare(b.entry);
}

function byDue(a: Task, b: Task) {
  return (a.due ?? "99999999").localeCompare(b.due ?? "99999999") || byUrgency(a, b);
}

export interface Group {
  label: string;
  tone?: "over";
  tasks: Task[];
}

export function matchesSearch(t: Task, q: string): boolean {
  if (!q) return true;
  const hay = [t.description, t.project, ...(t.tags ?? []).map((x) => "+" + x), ...(t.annotations ?? []).map((a) => a.description)]
    .join("\n").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Sort like Taskwarrior's report.<name>.sort, e.g. "due+,urgency-". Tasks
 * without a value go last. "/" (a break between groups) is ignored.
 */
export function sortBySpec(tasks: Task[], spec: string): Task[] {
  const keys = spec.split(",").map((k) => k.trim().replace(/\/$/, "")).filter(Boolean)
    .map((k) => ({ field: k.replace(/[+-]$/, ""), dir: k.endsWith("-") ? -1 : 1 }));
  if (!keys.length) return [...tasks].sort(byUrgency);
  const value = (t: Task, f: string): string | number | undefined => {
    const v = (t as unknown as Record<string, unknown>)[f];
    if (typeof v === "number" || typeof v === "string") return v;
    if (Array.isArray(v)) return v.join(" ");
    return undefined;
  };
  return [...tasks].sort((a, b) => {
    for (const { field, dir } of keys) {
      const x = value(a, field), y = value(b, field);
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      if (c) return c * dir;
    }
    return 0;
  });
}

export function buildView(all: Task[], view: ViewKey, q: string, sort = ""): Group[] {
  const now = new Date();
  const tasks = all.filter((t) => t.status !== "recurring" && matchesSearch(t, q));
  switch (view.kind) {
    case "next":
      return [{ label: "", tasks: tasks.filter(isOpen).sort(byUrgency) }];
    case "today": {
      const open = tasks.filter(isOpen);
      const over = open.filter((t) => { const d = twDate(t.due); return d && dayDiff(d, now) < 0; }).sort(byDue);
      const today = open.filter((t) => {
        const d = twDate(t.due), s = twDate(t.scheduled);
        return (d && dayDiff(d, now) === 0) || (s && dayDiff(s, now) <= 0 && !(d && dayDiff(d, now) < 0));
      }).sort(byDue);
      const active = open.filter((t) => t.start && !over.includes(t) && !today.includes(t)).sort(byUrgency);
      return [
        { label: "Overdue", tone: "over" as const, tasks: over },
        { label: "Today", tasks: today },
        { label: "In progress", tasks: active },
      ].filter((g) => g.tasks.length);
    }
    case "upcoming": {
      const groups = new Map<string, Group>();
      tasks.filter(isOpen).filter((t) => t.due).sort(byDue).forEach((t) => {
        const d = twDate(t.due)!;
        const diff = dayDiff(d, now);
        if (diff > 30) return;
        const label = diff < 0 ? "Overdue" : diff === 0 ? "Today" : diff === 1 ? "Tomorrow"
          : diff < 7 ? new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(d)
          : "Later this month";
        if (!groups.has(label)) groups.set(label, { label, tone: diff < 0 ? "over" : undefined, tasks: [] });
        groups.get(label)!.tasks.push(t);
      });
      return [...groups.values()];
    }
    case "waiting":
      return [{ label: "", tasks: tasks.filter((t) => isWaiting(t)).sort((a, b) => (a.wait ?? "").localeCompare(b.wait ?? "")) }];
    case "completed":
      return [{ label: "", tasks: tasks.filter((t) => t.status === "completed").sort((a, b) => (b.end ?? "").localeCompare(a.end ?? "")).slice(0, 300) }];
    case "trash":
      return [{ label: "", tasks: tasks.filter((t) => t.status === "deleted").sort((a, b) => (b.end ?? b.modified ?? "").localeCompare(a.end ?? a.modified ?? "")).slice(0, 300) }];
    case "project": {
      const inProject = tasks.filter((t) => isOpen(t) && t.project && (t.project === view.name || t.project.startsWith(view.name + ".")));
      const subs = new Map<string, Task[]>();
      for (const t of inProject.sort(byUrgency)) {
        const key = t.project === view.name ? "" : t.project!;
        subs.set(key, [...(subs.get(key) ?? []), t]);
      }
      return [...subs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, ts]) => ({ label, tasks: ts }));
    }
    case "tag":
      return [{ label: "", tasks: tasks.filter((t) => isOpen(t) && t.tags?.includes(view.name)).sort(byUrgency) }];
    case "report":
      return [{ label: "", tasks: sortBySpec(tasks, sort) }];
  }
}

export function viewTitle(v: ViewKey): string {
  switch (v.kind) {
    case "next": return "Next";
    case "today": return "Today";
    case "upcoming": return "Upcoming";
    case "waiting": return "Waiting";
    case "completed": return "Completed";
    case "trash": return "Deleted";
    case "project": return v.name;
    case "tag": return "+" + v.name;
    case "report": return v.name;
  }
}

/** The text to prefill quick-add with so new tasks land in the current view. */
export function viewDefaults(v: ViewKey): string {
  if (v.kind === "project") return `project:${v.name} `;
  if (v.kind === "tag") return `+${v.name} `;
  if (v.kind === "today") return "due:today ";
  return "";
}

export function viewPath(v: ViewKey): string {
  switch (v.kind) {
    case "next": return "/";
    case "project": return `/project/${encodeURIComponent(v.name)}`;
    case "tag": return `/tag/${encodeURIComponent(v.name)}`;
    case "report": return `/report/${encodeURIComponent(v.name)}`;
    default: return `/${v.kind}`;
  }
}

export function pathView(path: string): ViewKey | null {
  const [, a, b] = path.split("/");
  if (!a) return { kind: "next" };
  if (a === "project" && b) return { kind: "project", name: decodeURIComponent(b) };
  if (a === "tag" && b) return { kind: "tag", name: decodeURIComponent(b) };
  if (a === "report" && b) return { kind: "report", name: decodeURIComponent(b) };
  if (["today", "upcoming", "waiting", "completed", "trash"].includes(a)) return { kind: a } as ViewKey;
  return null;
}

// ---- quick add preview ----------------------------------------------------

export interface Token {
  kind: "project" | "tag" | "due" | "scheduled" | "wait" | "priority" | "recur" | "until" | "word";
  value: string;
}

const ATTRS: Record<string, Token["kind"]> = {
  project: "project", pro: "project", proj: "project", due: "due", scheduled: "scheduled", sched: "scheduled",
  wait: "wait", priority: "priority", pri: "priority", recur: "recur", until: "until",
};

/** What Taskwarrior will make of the quick-add text, for the preview chips. */
export function previewTokens(line: string): Token[] {
  const out: Token[] = [];
  let literal = false;
  for (const w of line.trim().split(/\s+/).filter(Boolean)) {
    if (literal) { out.push({ kind: "word", value: w }); continue; }
    if (w === "--") { literal = true; continue; }
    const m = /^([a-z]+):(.+)$/.exec(w);
    if (m && ATTRS[m[1]]) { out.push({ kind: ATTRS[m[1]], value: m[2] }); continue; }
    if (/^\+[^\s+]+$/.test(w)) { out.push({ kind: "tag", value: w.slice(1) }); continue; }
    out.push({ kind: "word", value: w });
  }
  return out;
}

export function linkify(text: string): (string | { href: string })[] {
  const parts: (string | { href: string })[] = [];
  const re = /https?:\/\/[^\s<>"')]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push({ href: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
