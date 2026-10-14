// Taskwarrior filters in the UI: the filter bar that narrows any view, and
// the editor for saved views, which are the user's own Taskwarrior reports.
// `task` evaluates every filter, so they behave as in a terminal.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { FilterMatch, Report } from "./backend";
import { Icon } from "./icons";
import type { Task } from "./lib";
import { useStore } from "./store";

/**
 * What each filter matches, re-run when `version` changes (the task list, or
 * the clock for relative dates). Results for the previous filters stay until
 * new ones arrive, so lists don't flicker.
 */
export function useFilterMatches(filters: string[], version: unknown): Map<string, FilterMatch> {
  const { backend } = useStore();
  const [results, setResults] = useState<Map<string, FilterMatch>>(() => new Map());
  const key = JSON.stringify([...new Set(filters.map((f) => f.trim()).filter(Boolean))].sort());
  const seq = useRef(0);
  useEffect(() => {
    const list: string[] = JSON.parse(key);
    if (!list.length) return;
    const n = ++seq.current;
    const id = window.setTimeout(() => {
      backend.match(list)
        .then((r) => { if (n === seq.current) setResults(new Map(list.map((f, i) => [f, r[i]]))); })
        .catch((e: Error) => {
          if (n === seq.current) setResults(new Map(list.map((f) => [f, { uuids: [], error: e.message }])));
        });
    }, 150);
    return () => window.clearTimeout(id);
  }, [key, version, backend]);
  return results;
}

/** Wait for typing to pause before using a value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

// ---- editing the filter text from the pickers --------------------------------

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** Replace the words `is` matches with `value` (or just remove them). */
function setWord(text: string, is: (w: string) => boolean, value: string | null): string {
  const kept = words(text).filter((w) => !is(w));
  if (value) kept.push(value);
  return kept.length ? kept.join(" ") + " " : "";
}

const isProject = (w: string) => /^project(\.\w+)?:/.test(w);
const isPriority = (w: string) => /^priority(\.\w+)?:/.test(w);
const isDue = (w: string) => /^\+(OVERDUE|TODAY|TOMORROW|WEEK|MONTH)$/.test(w) || /^due(\.\w+)?:/.test(w);

const DUE: [string, string][] = [
  ["+OVERDUE", "Overdue"],
  ["+TODAY", "Due today"],
  ["+TOMORROW", "Due tomorrow"],
  ["+WEEK", "Due this week"],
  ["+MONTH", "Due this month"],
  ["due.any:", "Has a due date"],
  ["due.none:", "No due date"],
];

const EXAMPLES = ["status:pending", "+WEEK", "+OVERDUE", "project:work", "priority:H", "due.before:eom", "-WAITING"];

export function FilterBar({ value, onChange, onClose, match, pending, tasks, onSave, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  match: FilterMatch | undefined;
  pending: boolean;
  tasks: Task[];
  onSave?: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { projects, tags } = useMemo(() => {
    const p = new Set<string>(), t = new Set<string>();
    for (const task of tasks) {
      if (task.status !== "pending") continue;
      if (task.project) p.add(task.project);
      for (const tag of task.tags ?? []) t.add(tag);
    }
    return { projects: [...p].sort(), tags: [...t].sort() };
  }, [tasks]);

  const ws = words(value);
  const project = ws.find(isProject);
  const priority = ws.find(isPriority);
  const due = ws.find(isDue);
  const error = value.trim() && !pending ? match?.error : null;

  return (
    <div className="filter-bar">
      <div className={`filter-input ${error ? "bad" : ""}`}>
        <Icon.filter />
        <input ref={inputRef} value={value} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          placeholder="Taskwarrior filter, e.g. project:work +phone due.before:eow"
          aria-label="Taskwarrior filter"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (value) onChange("");
            else { (e.target as HTMLInputElement).blur(); onClose(); }
          }} />
        <button className="icon-btn" onClick={() => { onChange(""); onClose(); }} aria-label="Clear and close the filter" title="Clear filter"><Icon.close /></button>
      </div>
      <div className="filter-picks">
        <select className="pick" aria-label="Project" value={project ?? ""}
          onChange={(e) => onChange(setWord(value, isProject, e.target.value || null))}>
          <option value="">Any project</option>
          <option value="project:">No project</option>
          {project && project !== "project:" && !projects.includes(project.replace(/^project:/, "")) && <option value={project}>{project}</option>}
          {projects.map((p) => <option key={p} value={`project:${p}`}>{p}</option>)}
        </select>
        <select className="pick" aria-label="Add a tag" value=""
          onChange={(e) => { if (e.target.value && !ws.includes(e.target.value)) onChange(setWord(value, () => false, e.target.value)); }}>
          <option value="">Tag…</option>
          {tags.map((t) => <option key={t} value={`+${t}`}>+{t}</option>)}
        </select>
        <select className="pick" aria-label="Priority" value={priority ?? ""}
          onChange={(e) => onChange(setWord(value, isPriority, e.target.value || null))}>
          <option value="">Any priority</option>
          <option value="priority:H">High</option>
          <option value="priority:M">Medium</option>
          <option value="priority:L">Low</option>
          <option value="priority:">No priority</option>
          {priority && !/^priority:[HML]?$/.test(priority) && <option value={priority}>{priority}</option>}
        </select>
        <select className="pick" aria-label="Due date" value={due ?? ""}
          onChange={(e) => onChange(setWord(value, isDue, e.target.value || null))}>
          <option value="">Any due date</option>
          {DUE.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          {due && !DUE.some(([v]) => v === due) && <option value={due}>{due}</option>}
        </select>
        {onSave && value.trim() && !error && (
          <button className="btn small ghost" onClick={onSave}><Icon.plus /> Save as view</button>
        )}
      </div>
      {error && <div className="filter-error">{error}</div>}
    </div>
  );
}

// ---- saved views (Taskwarrior reports) ----------------------------------------

const SORTS: [string, string][] = [
  ["urgency-", "Urgency"],
  ["due+,urgency-", "Due date"],
  ["scheduled+,urgency-", "Scheduled date"],
  ["entry-", "Newest first"],
  ["project+,urgency-", "Project"],
  ["description+", "Description"],
];

export function ReportEditor({ report, initialFilter, onClose, onSaved, onDeleted }: {
  /** The report to edit, or null for a new one. */
  report: Report | null;
  initialFilter?: string;
  onClose: () => void;
  onSaved: (r: Report) => void;
  onDeleted: (name: string) => void;
}) {
  const { backend, toast } = useStore();
  const [description, setDescription] = useState(report?.description ?? "");
  const [filter, setFilter] = useState(report?.filter ?? initialFilter ?? "status:pending ");
  const [sort, setSort] = useState(report?.sort ?? "urgency-");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const typed = useDebounced(filter.trim(), 300);
  const preview = useFilterMatches([typed], null).get(typed);
  const sorts = SORTS.some(([v]) => v === sort) ? SORTS : [...SORTS, [sort, sort ? `Custom: ${sort}` : "Taskwarrior's default"] as [string, string]];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await backend.reports.save({ name: report?.name ?? null, description, filter, sort }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!report) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    try {
      await backend.reports.remove(report.name);
      onDeleted(report.name);
      toast(`Removed ${report.description}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const addExample = (w: string) => { if (!words(filter).includes(w)) setFilter(setWord(filter, () => false, w)); };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog" role="dialog" aria-label={report ? "Edit view" : "New view"} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{report ? "Edit view" : "New view"}</h2>
        <div className="form-stack">
          <div className="field">
            <label htmlFor="rv-name">Name</label>
            <input id="rv-name" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="This Week" autoFocus={!report} maxLength={60} />
          </div>
          <div className="field">
            <label htmlFor="rv-filter">Filter</label>
            <input id="rv-filter" className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus={!!report} />
            <div className="filter-examples">
              {EXAMPLES.map((w) => <button type="button" key={w} className="chip" onClick={() => addExample(w)}>{w}</button>)}
            </div>
            <div className={`help ${preview?.error ? "bad" : ""}`}>
              {!typed ? "No filter: every task, including finished ones."
                : preview?.error ? preview.error
                : preview ? `Matches ${preview.uuids.length} ${preview.uuids.length === 1 ? "task" : "tasks"}. Without status:pending, finished and deleted tasks are included.`
                : "Checking…"}
            </div>
          </div>
          <div className="field">
            <label htmlFor="rv-sort">Sort by</label>
            <select id="rv-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              {sorts.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </div>
          <p className="help" style={{ margin: 0 }}>
            {report
              ? <>Saved in your .taskrc as a Taskwarrior report. In a terminal: <code className="inline-code">task {report.name}</code></>
              : "Saved in your .taskrc as a Taskwarrior report, so it works in a terminal too."}
          </p>
          {error && <div className="alert error">{error}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy || !description.trim()}>{report ? "Save" : "Add view"}</button>
            <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            {report && (
              <button className="btn danger" type="button" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void remove()}>
                {confirmDelete ? "Remove from .taskrc?" : "Delete"}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
