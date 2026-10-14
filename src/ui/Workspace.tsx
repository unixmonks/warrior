import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./icons";
import {
  ago, buildView, dayDiff, isOpen, isWaiting, previewTokens, relDate, twDate, viewDefaults, viewPath, viewTitle,
  type Task, type ViewKey,
} from "./lib";
import { navigate, useStore } from "./store";
import { TaskDetail } from "./TaskDetail";
import { Brand, ThemeToggle } from "./common";
import { FilterBar, ReportEditor, useDebounced, useFilterMatches } from "./Filters";
import type { FilterMatch, Report } from "./backend";

const COLLAPSED_KEY = "warrior:sidebar-collapsed";
/** Below this width the sidebar is a drawer (matches styles.css). */
const NARROW = "(max-width: 860px)";

function readCollapsed(): boolean {
  try { return !!localStorage.getItem(COLLAPSED_KEY); } catch { return false; }
}

function nowTw(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

export function Workspace({ view, initialSelected }: { view: ViewKey; initialSelected: string | null }) {
  const store = useStore();
  const { tasks, loaded, mutate, toast, backend } = store;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [cursor, setCursor] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [termOpen, setTermOpen] = useState(false);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // A Taskwarrior filter narrowing whichever view is showing. It stays while
  // moving between views.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [editing, setEditing] = useState<{ report: Report | null; filter?: string } | null>(null);

  const all = useMemo(() => [...tasks.values()], [tasks]);
  // Views depend on the time as well as the tasks: wait dates pass and days
  // end without anything being written.
  const minute = useMinute();

  // Saved views are the user's Taskwarrior reports. .taskrc may change
  // outside the app, so look again when the window comes back.
  const loadReports = useCallback(() => {
    backend.reports.list().then(setReports).catch(() => {});
  }, [backend]);
  useEffect(() => {
    loadReports();
    window.addEventListener("focus", loadReports);
    return () => window.removeEventListener("focus", loadReports);
  }, [loadReports]);

  const filter = useDebounced(filterText.trim(), 300);
  const report = view.kind === "report" ? reports?.find((r) => r.name === view.name) : undefined;
  const matches = useFilterMatches([filter, ...(reports ?? []).map((r) => r.filter)], [tasks, minute]);
  // While a new filter runs, keep showing the last one's results.
  const lastFilterMatch = useRef<FilterMatch | undefined>(undefined);
  const filterMatch = filter ? matches.get(filter) ?? lastFilterMatch.current : undefined;
  if (filter && matches.get(filter)) lastFilterMatch.current = matches.get(filter);
  const filterPending = filterText.trim() !== "" && (filterText.trim() !== filter || !matches.get(filter));

  const pool = useMemo(() => {
    let out = all;
    if (view.kind === "report") {
      const m = report?.filter.trim() ? matches.get(report.filter.trim()) : undefined;
      if (!report) out = [];
      else if (report.filter.trim()) {
        const set = new Set(m && !m.error ? m.uuids : []);
        out = out.filter((t) => set.has(t.uuid));
      }
    }
    if (filter && filterMatch && !filterMatch.error) {
      const set = new Set(filterMatch.uuids);
      out = out.filter((t) => set.has(t.uuid));
    }
    return out;
  }, [all, view, report, matches, filter, filterMatch]);
  const groups = useMemo(() => buildView(pool, view, query, report?.sort), [pool, view, query, report, minute]);
  const reportLoading = view.kind === "report"
    && (!reports || (!!report?.filter.trim() && !matches.get(report.filter.trim())));
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const selectedTask = selected ? tasks.get(selected) ?? null : null;

  // Keep ?t=<uuid> in the URL so a refresh or shared link reopens the task.
  useEffect(() => {
    const url = viewPath(view) + (selected ? `?t=${selected}` : "");
    if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  }, [selected, view]);

  useEffect(() => setNavOpen(false), [view]);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    document.title = `${report?.description ?? viewTitle(view)} · warrior`;
  }, [view, report]);

  const complete = useCallback((t: Task) => {
    const done = t.status === "completed";
    if (!done) {
      setLeaving((s) => new Set(s).add(t.uuid));
      window.setTimeout(() => setLeaving((s) => { const n = new Set(s); n.delete(t.uuid); return n; }), 400);
    }
    void mutate(
      () => backend.action(t.uuid, done ? "restore" : "done"),
      (m) => m.set(t.uuid, done ? { ...t, status: "pending", end: undefined } : { ...t, status: "completed", end: nowTw() }),
    ).then((r) => {
      if (r && !done) {
        toast(`Completed “${t.description.slice(0, 40)}”`, {
          action: { label: "Undo", run: () => void mutate(() => backend.action(t.uuid, "restore")) },
        });
      }
    });
  }, [mutate, toast, backend]);

  // On a phone the sidebar is a drawer; on a wider screen it can be collapsed.
  const toggleNav = useCallback((open?: boolean) => {
    if (window.matchMedia(NARROW).matches) {
      setNavOpen((o) => open ?? !o);
      return;
    }
    setCollapsed((c) => {
      const next = open === undefined ? !c : !open;
      try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : ""); } catch { /* storage blocked */ }
      return next;
    });
  }, []);

  // Keyboard: j/k move, x completes, enter opens, n adds, / searches, : opens the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable]");
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleNav();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setTermOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || termOpen) return;
      const idx = cursor ? flat.findIndex((t) => t.uuid === cursor) : -1;
      const move = (d: number) => {
        const next = flat[Math.max(0, Math.min(flat.length - 1, idx + d))];
        if (next) {
          setCursor(next.uuid);
          if (selected) setSelected(next.uuid);
          document.querySelector(`[data-uuid="${next.uuid}"]`)?.scrollIntoView({ block: "nearest" });
        }
      };
      switch (e.key) {
        case "j": case "ArrowDown": e.preventDefault(); move(1); break;
        case "k": case "ArrowUp": e.preventDefault(); move(-1); break;
        case "Enter": if (cursor) { e.preventDefault(); setSelected(cursor); } break;
        case "x": { const t = cursor && tasks.get(cursor); if (t) complete(t); break; }
        case "n": case "a": e.preventDefault(); addRef.current?.focus(); break;
        case "/": e.preventDefault(); searchRef.current?.focus(); break;
        case "f":
          e.preventDefault();
          setFilterOpen(true);
          window.setTimeout(() => filterRef.current?.focus());
          break;
        case ":": e.preventDefault(); setTermOpen(true); break;
        case "Escape": if (selected) setSelected(null); else setCursor(null); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, flat, selected, tasks, termOpen, complete, toggleNav]);

  const shellClass = ["shell", selectedTask ? "with-detail" : "", navOpen ? "nav-open" : "", collapsed ? "nav-collapsed" : ""].join(" ");
  const total = flat.length;

  return (
    <div className={shellClass}>
      <Sidebar view={view} all={all} minute={minute} onCollapse={() => toggleNav(false)} onSettings={() => navigate("/settings")}
        reports={reports} matches={matches} onEditReport={(r) => setEditing({ report: r })} />
      <div className="backdrop" onClick={() => setNavOpen(false)} />

      <main className="main">
        <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <button className="icon-btn menu-btn" onClick={() => toggleNav(true)} aria-label="Show sidebar" title="Show sidebar (Ctrl+B)"><Icon.menu /></button>
          <label className="search">
            <span className="sr-only">Search tasks</span>
            <Icon.search />
            <input ref={searchRef} type="search" placeholder="Search tasks and notes" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); (e.target as HTMLInputElement).blur(); } }} />
          </label>
          <div className="topbar-actions">
            <SyncPill />
            <button className={`icon-btn ${filterOpen || filter ? "on" : ""}`} aria-pressed={filterOpen}
              onClick={() => { const open = !filterOpen; setFilterOpen(open); if (open) window.setTimeout(() => filterRef.current?.focus()); }}
              aria-label="Filter tasks" title="Filter (f)"><Icon.filter /></button>
            <button className="icon-btn" onClick={() => setTermOpen(true)} aria-label="Open command line" title="Command line (:)"><Icon.terminal /></button>
          </div>
        </header>

        <div className="content">
          <div className="view-head">
            <div>
              <div className="eyebrow">
                {view.kind === "project" ? "project" : view.kind === "tag" ? "tag" : view.kind === "report" ? `task ${view.name}` : "view"}
                {" · "}<b>{loaded ? total : "…"}</b> {total === 1 ? "task" : "tasks"}{filter && filterMatch && !filterMatch.error ? " · filtered" : ""}
              </div>
              <h1>
                {report?.description ?? viewTitle(view)}
                {report && (
                  <button className="icon-btn title-edit" onClick={() => setEditing({ report })} aria-label={`Edit ${report.description}`} title="Edit view"><Icon.edit /></button>
                )}
              </h1>
            </div>
            <div className="hide-mobile muted" style={{ fontSize: 13 }}>
              <kbd>n</kbd> add · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> done · <kbd>:</kbd> command
            </div>
          </div>

          {(filterOpen || filterText) && (
            <FilterBar value={filterText} onChange={setFilterText} onClose={() => setFilterOpen(false)} inputRef={filterRef}
              match={filterMatch} pending={filterPending} tasks={all}
              onSave={() => setEditing({ report: null, filter: filterText.trim() })} />
          )}

          {view.kind !== "completed" && view.kind !== "trash" && (
            <QuickAdd inputRef={addRef} view={view} onAdded={(uuid) => { setFlash(uuid); window.setTimeout(() => setFlash(null), 1600); }} />
          )}

          {!loaded || reportLoading ? (
            <div className="list">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" />)}</div>
          ) : view.kind === "report" && reports && !report ? (
            <div className="empty"><h2>This view no longer exists</h2><p>There's no <code className="inline-code">report.{view.name}</code> in your .taskrc any more.</p></div>
          ) : view.kind === "report" && report && matches.get(report.filter.trim())?.error ? (
            <div className="alert error">This view's filter doesn't work: {matches.get(report.filter.trim())!.error}</div>
          ) : total === 0 ? (
            <Empty view={view} query={query} filtered={!!filter} />
          ) : (
            groups.map((g) => (
              <section key={g.label || "all"}>
                {g.label && (
                  <div className={`group-label ${g.tone ?? ""}`}>
                    {view.kind === "project" ? g.label.slice(view.name.length + 1) || g.label : g.label}
                    <span className="n">{g.tasks.length}</span>
                  </div>
                )}
                <div className="list">
                  {g.tasks.map((t) => (
                    <Row key={t.uuid} task={t} view={view} selected={t.uuid === selected} cursor={t.uuid === cursor}
                      leaving={leaving.has(t.uuid)} flash={t.uuid === flash}
                      onOpen={() => { setSelected(t.uuid); setCursor(t.uuid); }}
                      onCheck={() => complete(t)} />
                  ))}
                </div>
              </section>
            ))
          )}
          {loaded && (view.kind === "completed" || view.kind === "trash") && !store.history.complete && (
            <div className="actions" style={{ justifyContent: "center", paddingTop: 18 }}>
              <button className="btn small" onClick={() => void store.history.load()}>Show older tasks</button>
            </div>
          )}
        </div>
      </main>

      {selectedTask && <TaskDetail key={selectedTask.uuid} task={selectedTask} all={all} onClose={() => setSelected(null)} />}
      {termOpen && <Terminal onClose={() => setTermOpen(false)} />}
      {editing && (
        <ReportEditor report={editing.report} initialFilter={editing.filter} onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            setReports((rs) => [...(rs ?? []).filter((x) => x.name !== r.name), r].sort((a, b) => a.name.localeCompare(b.name)));
            if (!editing.report) { setFilterText(""); setFilterOpen(false); }
            navigate(viewPath({ kind: "report", name: r.name }));
          }}
          onDeleted={(name) => {
            setEditing(null);
            setReports((rs) => (rs ?? []).filter((x) => x.name !== name));
            if (view.kind === "report" && view.name === name) navigate("/");
          }} />
      )}
    </div>
  );
}

// ---- sidebar ----------------------------------------------------------------

function Sidebar({ view, all, minute, onCollapse, onSettings, reports, matches, onEditReport }: {
  view: ViewKey; all: Task[]; minute: number; onCollapse: () => void; onSettings: () => void;
  reports: Report[] | null; matches: Map<string, FilterMatch>; onEditReport: (r: Report | null) => void;
}) {
  const counts = useMemo(() => {
    const open = all.filter(isOpen);
    const now = new Date();
    return {
      next: open.length,
      today: open.filter((t) => { const d = twDate(t.due), s = twDate(t.scheduled); return (d && dayDiff(d, now) <= 0) || (s && dayDiff(s, now) <= 0); }).length,
      upcoming: open.filter((t) => { const d = twDate(t.due); return d && dayDiff(d, now) <= 7; }).length,
      waiting: all.filter((t) => isWaiting(t)).length,
      projects: projectTree(open),
      tags: tagCounts(open),
    };
  }, [all, minute]);
  const byUuid = useMemo(() => new Map(all.map((t) => [t.uuid, t])), [all]);

  const item = (v: ViewKey, icon: React.ReactNode, label: string, count?: number) => {
    const active = JSON.stringify(v) === JSON.stringify(view);
    return (
      <a href={viewPath(v)} className={`nav-item ${active ? "active" : ""}`} onClick={(e) => { e.preventDefault(); navigate(viewPath(v)); }}>
        {icon}<span className="label">{label}</span>{count ? <span className="count">{count}</span> : null}
      </a>
    );
  };

  return (
    <nav className="sidebar" aria-label="Views">
      <div className="sidebar-head">
        <Brand />
        <button className="icon-btn collapse-btn" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)"><Icon.sidebar /></button>
      </div>
      <div className="nav-group">
        {item({ kind: "next" }, <Icon.next />, "Next", counts.next)}
        {item({ kind: "today" }, <Icon.today />, "Today", counts.today)}
        {item({ kind: "upcoming" }, <Icon.upcoming />, "Upcoming", counts.upcoming)}
        {item({ kind: "waiting" }, <Icon.waiting />, "Waiting", counts.waiting)}
        {item({ kind: "completed" }, <Icon.completed />, "Completed")}
        {item({ kind: "trash" }, <Icon.trash />, "Deleted")}
      </div>
      {reports && (
        <div className="nav-group">
          <div className="nav-label">
            My views
            <button className="nav-add" onClick={() => onEditReport(null)} aria-label="New view" title="New view"><Icon.plus /></button>
          </div>
          {reports.map((r) => {
            const v: ViewKey = { kind: "report", name: r.name };
            const active = view.kind === "report" && view.name === r.name;
            const m = r.filter.trim() ? matches.get(r.filter.trim()) : undefined;
            const n = !r.filter.trim() ? all.filter((t) => t.status !== "recurring").length
              : m && !m.error ? m.uuids.filter((u) => { const t = byUuid.get(u); return t && t.status !== "recurring"; }).length : undefined;
            return (
              <div key={r.name} className="nav-row">
                <a href={viewPath(v)} className={`nav-item ${active ? "active" : ""}`} title={`task ${r.name}: ${r.filter}`}
                  onClick={(e) => { e.preventDefault(); navigate(viewPath(v)); }}>
                  <Icon.filter /><span className="label">{r.description}</span>
                  {m?.error ? <span className="count bad" title={m.error}>!</span> : n ? <span className="count">{n}</span> : null}
                </a>
                <button className="nav-edit" onClick={() => onEditReport(r)} aria-label={`Edit ${r.description}`} title="Edit view"><Icon.edit /></button>
              </div>
            );
          })}
          {reports.length === 0 && (
            <button className="nav-item muted" onClick={() => onEditReport(null)}><Icon.plus /><span className="label">New view</span></button>
          )}
        </div>
      )}
      {counts.projects.length > 0 && (
        <div className="nav-group">
          <div className="nav-label">Projects</div>
          {counts.projects.map(([name, n, depth]) => {
            const v: ViewKey = { kind: "project", name };
            const active = view.kind === "project" && view.name === name;
            return (
              <a key={name} href={viewPath(v)} className={`nav-item ${active ? "active" : ""}`} style={{ paddingLeft: 10 + depth * 16 }}
                onClick={(e) => { e.preventDefault(); navigate(viewPath(v)); }}>
                <span className="hash">{depth ? "·" : "▪"}</span><span className="label">{name.split(".").pop()}</span><span className="count">{n}</span>
              </a>
            );
          })}
        </div>
      )}
      {counts.tags.length > 0 && (
        <div className="nav-group">
          <div className="nav-label">Tags</div>
          {counts.tags.map(([name, n]) => {
            const v: ViewKey = { kind: "tag", name };
            const active = view.kind === "tag" && view.name === name;
            return (
              <a key={name} href={viewPath(v)} className={`nav-item ${active ? "active" : ""}`} onClick={(e) => { e.preventDefault(); navigate(viewPath(v)); }}>
                <span className="hash">+</span><span className="label">{name}</span><span className="count">{n}</span>
              </a>
            );
          })}
        </div>
      )}
      <div className="sidebar-foot">
        <button className="nav-item" onClick={onSettings}><Icon.settings /><span className="label">Settings</span></button>
        <ThemeToggle className="nav-item" />
      </div>
    </nav>
  );
}

/** [name, count, depth] including parent projects that have no tasks of their own. */
function projectTree(open: Task[]): [string, number, number][] {
  const counts = new Map<string, number>();
  for (const t of open) {
    if (!t.project) continue;
    const parts = t.project.split(".");
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join(".");
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => [n, c, n.split(".").length - 1]);
}

function tagCounts(open: Task[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of open) for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ---- rows -------------------------------------------------------------------

export function TaskChips({ task, showProject = true }: { task: Task; showProject?: boolean }) {
  const due = twDate(task.due);
  const dueDiff = due ? dayDiff(due) : 0;
  const overdue = due ? due.getTime() < Date.now() : false;
  return (
    <>
      {task.start && task.status === "pending" && <span className="chip active">● active</span>}
      {task.priority && <span className={`chip pri-${task.priority}`}>{task.priority === "H" ? "high" : task.priority === "M" ? "medium" : "low"}</span>}
      {due && task.status === "pending" && (
        <span className={`chip due ${overdue ? "over" : dueDiff <= 1 ? "soon" : ""}`}><Icon.clock />{relDate(due)}</span>
      )}
      {task.recur && <span className="chip"><Icon.repeat />{task.recur}</span>}
      {showProject && task.project && <span className="chip project">{task.project}</span>}
      {(task.tags ?? []).map((t) => <span key={t} className="chip tag">+{t}</span>)}
      {isWaiting(task) && task.wait && <span className="chip">waits until {relDate(twDate(task.wait)!)}</span>}
      {task.annotations?.length ? <span className="chip notes"><Icon.note />{task.annotations.length}</span> : null}
    </>
  );
}

function Row({ task, view, selected, cursor, leaving, flash, onOpen, onCheck }: {
  task: Task; view: ViewKey; selected: boolean; cursor: boolean; leaving: boolean; flash: boolean; onOpen: () => void; onCheck: () => void;
}) {
  const { mutate, backend } = useStore();
  const done = task.status === "completed";
  const deleted = task.status === "deleted";
  const cls = ["row", selected && "selected", cursor && "cursor", done && "done", leaving && "leaving"].filter(Boolean).join(" ");
  return (
    <div className={cls} data-uuid={task.uuid} onClick={onOpen} style={flash ? { background: "var(--accent-wash)" } : undefined}>
      {deleted ? <span /> : (
        <button className={`check ${done || leaving ? "on" : ""} ${task.priority ? `pri-${task.priority}` : ""}`}
          aria-label={done ? "Mark as not done" : "Mark as done"} onClick={(e) => { e.stopPropagation(); onCheck(); }}>
          <span><Icon.check /></span>
        </button>
      )}
      <div className="row-body">
        <div className="row-title">{task.description}</div>
        <div className="row-meta">
          <TaskChips task={task} showProject={view.kind !== "project"} />
          {done && task.end && <span className="chip">done {relDate(twDate(task.end)!)}</span>}
        </div>
      </div>
      <div className="row-side">
        {deleted ? (
          <button className="btn small" onClick={(e) => { e.stopPropagation(); void mutate(() => backend.action(task.uuid, "restore")); }}>Restore</button>
        ) : (
          <>
            {task.id ? <span className="row-id" title="Taskwarrior ID">{task.id}</span> : null}
            {isOpen(task) && <span className="urg" title="Urgency">{(task.urgency ?? 0).toFixed(1)}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ view, query, filtered }: { view: ViewKey; query: string; filtered: boolean }) {
  const msg = query ? ["No matches", `Nothing here matches “${query}”.`]
    : filtered ? ["No matches", "Nothing here matches the filter."]
    : view.kind === "report" ? ["Nothing here", "No tasks match this view's filter right now."]
    : view.kind === "today" ? ["Nothing due today", "Tasks due today, overdue, or scheduled for today show up here."]
    : view.kind === "upcoming" ? ["Nothing coming up", "Tasks with a due date in the next 30 days show up here."]
    : view.kind === "waiting" ? ["Nothing waiting", "Add wait:monday to hide a task until then."]
    : view.kind === "completed" ? ["Nothing completed yet", "Finished tasks appear here."]
    : view.kind === "trash" ? ["No deleted tasks", "Deleted tasks can be restored from here."]
    : ["You're all caught up", "Add a task above. Taskwarrior syntax works: project:home +errand due:fri"];
  return (
    <div className="empty">
      <div className="glyph">t&gt;_</div>
      <h2>{msg[0]}</h2>
      <p>{msg[1]}</p>
    </div>
  );
}

// ---- quick add --------------------------------------------------------------

function QuickAdd({ view, inputRef, onAdded }: { view: ViewKey; inputRef: React.RefObject<HTMLInputElement | null>; onAdded: (uuid: string) => void }) {
  const { mutate, backend } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const defaults = viewDefaults(view);
  const tokens = useMemo(() => previewTokens(defaults + text), [defaults, text]);
  const attrs = tokens.filter((t) => t.kind !== "word");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    // Fill in the view's project/tag/due unless the user typed their own.
    const key = defaults.split(/[:+]/)[0] || defaults.trim();
    const typedOwn = defaults.startsWith("+") ? text.includes(defaults.trim()) : text.includes(`${key}:`);
    const line = (typedOwn ? "" : defaults) + text;
    const r = await mutate(() => backend.add(line));
    setBusy(false);
    if (r) {
      setText("");
      if (r.uuid) onAdded(r.uuid);
    }
  };

  return (
    <form className="quick-add" onSubmit={submit}>
      <div className="quick-add-box">
        <span className="prompt" aria-hidden="true">+</span>
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} enterKeyHint="send" autoComplete="off" autoCapitalize="sentences"
          placeholder="Add a task — e.g. Call Sam due:fri +phone" aria-label="New task"
          onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
        <button className="btn primary small" disabled={!text.trim() || busy}>{busy ? "Adding…" : "Add"}</button>
      </div>
      {text && attrs.length > 0 ? (
        <div className="chips">
          {attrs.map((t, i) => (
            <span key={i} className={`chip ${t.kind === "project" ? "project" : t.kind === "tag" ? "tag" : t.kind === "due" ? "due soon" : ""}`}>
              {t.kind === "tag" ? `+${t.value}` : `${t.kind}: ${t.value}`}
            </span>
          ))}
        </div>
      ) : (
        <div className="hint">project:name · +tag · due:tomorrow · priority:H · recur:weekly · wait:mon</div>
      )}
    </form>
  );
}

/** The current minute, changing once a minute. */
function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000));
  useEffect(() => {
    const id = window.setInterval(() => setMinute(Math.floor(Date.now() / 60000)), 15000);
    return () => window.clearInterval(id);
  }, []);
  return minute;
}

// ---- sync pill ----------------------------------------------------------------

function SyncPill() {
  const { me, syncing, syncNow } = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(id);
  }, []);
  if (!me.sync.configured) {
    return (
      <button className="sync-pill" onClick={() => navigate("/settings")} title="Set up sync">
        <span className="dot" /><span className="label">Sync off</span>
      </button>
    );
  }
  const err = me.sync.lastSyncOk === false;
  return (
    <button className={`sync-pill ${err ? "err" : "ok"}`} onClick={() => void syncNow()} disabled={syncing}
      title={err ? me.sync.lastSyncMessage ?? "Sync failed" : "Sync now"}>
      {syncing ? <span className="spin" style={{ display: "inline-flex" }}><Icon.sync /></span> : <span className="dot" />}
      <span className="label">{syncing ? "Syncing" : err ? "Sync failed" : me.sync.lastSyncAt ? `Synced ${ago(me.sync.lastSyncAt)}` : "Sync"}</span>
    </button>
  );
}

// ---- terminal ---------------------------------------------------------------

interface TermEntry {
  line: string;
  output: string;
  ok: boolean;
}

const HISTORY_KEY = "warrior:term-history";

function Terminal({ onClose }: { onClose: () => void }) {
  const { apply, backend } = useStore();
  const [entries, setEntries] = useState<TermEntry[]>([]);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
  });
  const [hIdx, setHIdx] = useState(-1);
  const outRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inRef.current?.focus(); }, []);
  useEffect(() => { outRef.current?.scrollTo(0, outRef.current.scrollHeight); }, [entries]);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const cmd = line.trim().replace(/^task\s+/, "");
    if (busy) return;
    if (cmd === "clear") { setEntries([]); setLine(""); return; }
    setBusy(true);
    try {
      const r = await backend.command(cmd);
      apply(r);
      setEntries((es) => [...es, { line: cmd || "next", output: r.output || "(no output)", ok: r.ok }]);
    } catch (err) {
      setEntries((es) => [...es, { line: cmd, output: (err as Error).message, ok: false }]);
    }
    const nextHist = [cmd, ...hist.filter((h) => h !== cmd)].slice(0, 50);
    setHist(nextHist);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHist)); } catch { /* private mode */ }
    setHIdx(-1);
    setLine("");
    setBusy(false);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowUp" && hist.length) {
      e.preventDefault();
      const i = Math.min(hist.length - 1, hIdx + 1);
      setHIdx(i);
      setLine(hist[i]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = hIdx - 1;
      setHIdx(Math.max(-1, i));
      setLine(i >= 0 ? hist[i] : "");
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="terminal" role="dialog" aria-label="Taskwarrior command line" onClick={(e) => e.stopPropagation()}>
        <div className="terminal-bar">
          <span className="d" /><span className="d" /><span className="d" />
          <span className="title">task — your taskwarrior</span>
          <button onClick={onClose}>esc</button>
        </div>
        <div className="terminal-out" ref={outRef}>
          {entries.length === 0 && (
            <div className="block t-dim">{`Run Taskwarrior commands against your tasks.
Try: `}<span className="t-hi">next</span>{`, `}<span className="t-hi">projects</span>{`, `}<span className="t-hi">summary</span>{`, `}<span className="t-hi">calendar</span>{`,
     `}<span className="t-hi">3 modify +home due:eow</span>{`, `}<span className="t-hi">project:work done</span>{`
This is your own task and .taskrc. For edit, use a terminal.`}</div>
          )}
          {entries.map((en, i) => (
            <div key={i} className="block">
              <div className="cmd">$ task <b>{en.line}</b></div>
              <div className={en.ok ? "" : "err"}>{en.output}</div>
            </div>
          ))}
        </div>
        <form className="terminal-in" onSubmit={run}>
          <span>$ task</span>
          <input ref={inRef} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onKey} disabled={busy}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Command" placeholder={busy ? "running…" : "next"} />
        </form>
      </div>
    </div>
  );
}
