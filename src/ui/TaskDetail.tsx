import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import type { TaskAction, TaskPatch } from "./backend";
import { linkify, longDate, relDate, toLocalInput, twDate, type Task } from "./lib";
import { useStore } from "./store";
import { TaskChips } from "./Workspace";

type Patch = TaskPatch;

export function TaskDetail({ task, all, onClose }: { task: Task; all: Task[]; onClose: () => void }) {
  const { mutate, toast, backend } = useStore();
  const projects = useMemo(() => [...new Set(all.map((t) => t.project).filter(Boolean) as string[])].sort(), [all]);
  const tagsKnown = useMemo(() => [...new Set(all.flatMap((t) => t.tags ?? []))].sort(), [all]);
  const closeRef = useRef<HTMLButtonElement>(null);

  // On phones the panel covers the screen; move focus into it.
  useEffect(() => {
    if (matchMedia("(max-width: 860px)").matches) closeRef.current?.focus();
  }, []);

  const save = (patch: Patch, optimistic?: Partial<Task>) =>
    mutate(
      () => backend.update(task.uuid, patch),
      optimistic ? (m) => m.set(task.uuid, { ...task, ...optimistic }) : undefined,
    );

  const act = async (action: TaskAction) => {
    const r = await mutate(() => backend.action(task.uuid, action));
    if (r && (action === "done" || action === "delete")) {
      toast(action === "done" ? "Task completed" : "Task deleted", {
        action: { label: "Undo", run: () => void mutate(() => backend.action(task.uuid, "restore")) },
      });
      onClose();
    }
  };

  const pending = task.status === "pending" || task.status === "waiting";
  const shortId = task.id ? `#${task.id}` : task.uuid.slice(0, 8);

  return (
    <aside className="detail" aria-label="Task details">
      <div className="detail-head">
        <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close task"><Icon.back /></button>
        <span className="crumb">{task.project ? `${task.project} / ` : ""}{shortId}</span>
        {pending && (
          task.start
            ? <button className="btn small ghost" onClick={() => act("stop")}><Icon.pause />Stop</button>
            : <button className="btn small ghost" onClick={() => act("start")}><Icon.play />Start</button>
        )}
        {pending
          ? <button className="btn small primary" onClick={() => act("done")}>Done</button>
          : <button className="btn small" onClick={() => act("restore")}>Reopen</button>}
      </div>

      <div className="detail-body">
        <Title value={task.description} onSave={(description) => save({ description }, { description })} />
        <div className="status-line row-meta"><TaskChips task={task} /></div>

        <div className="fields">
          <label htmlFor="f-project">Project</label>
          <div className="fval">
            <TextField id="f-project" value={task.project ?? ""} list="projects" placeholder="none"
              onSave={(project) => save({ project }, { project: project || undefined })} />
            <datalist id="projects">{projects.map((p) => <option key={p} value={p} />)}</datalist>
          </div>

          <span className="flabel">Tags</span>
          <div className="fval"><TagEditor tags={task.tags ?? []} known={tagsKnown} onChange={(tags) => save({ tags }, { tags })} /></div>

          <DateRow label="Due" field="due" task={task} onSave={save} />
          <DateRow label="Scheduled" field="scheduled" task={task} onSave={save} />
          <DateRow label="Wait until" field="wait" task={task} onSave={save} />

          <span className="flabel">Priority</span>
          <div className="fval">
            <div className="seg" role="group" aria-label="Priority">
              {["", "L", "M", "H"].map((p) => (
                <button key={p} className={(task.priority ?? "") === p ? "on" : ""} onClick={() => save({ priority: p }, { priority: p || undefined })}>
                  {p || "–"}
                </button>
              ))}
            </div>
          </div>

          <label htmlFor="f-recur">Repeat</label>
          <div className="fval">
            <TextField id="f-recur" value={task.recur ?? ""} list="recur" placeholder={task.due ? "never" : "needs a due date"}
              onSave={(recur) => save({ recur })} />
            <datalist id="recur">{["daily", "weekdays", "weekly", "biweekly", "monthly", "quarterly", "yearly"].map((r) => <option key={r} value={r} />)}</datalist>
          </div>
        </div>

        <Notes task={task} onSave={(annotations) => save({ annotations }, { annotations })} />

        <details>
          <summary className="section-title" style={{ cursor: "pointer" }}>Details</summary>
          <dl className="info-grid">
            <dt>Status</dt><dd>{task.status}</dd>
            {task.id ? <><dt>ID</dt><dd>{task.id}</dd></> : null}
            <dt>UUID</dt><dd>{task.uuid}</dd>
            <dt>Urgency</dt><dd>{task.urgency?.toFixed(2) ?? "–"}</dd>
            <dt>Created</dt><dd>{longDate(twDate(task.entry)!)}</dd>
            {task.modified && <><dt>Modified</dt><dd>{longDate(twDate(task.modified)!)}</dd></>}
            {task.end && <><dt>Ended</dt><dd>{longDate(twDate(task.end)!)}</dd></>}
            {task.parent && <><dt>Recurs from</dt><dd>{task.parent}</dd></>}
          </dl>
        </details>

        {task.status !== "deleted" && (
          <div><button className="btn danger small" onClick={() => act("delete")}><Icon.trash />Delete task</button></div>
        )}
      </div>
    </aside>
  );
}

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

function Title({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useAutosize(ref, v);
  const commit = () => {
    const t = v.replace(/\s+/g, " ").trim();
    if (!t) setV(value);
    else if (t !== value) onSave(t);
  };
  return (
    <textarea ref={ref} className="title-input" value={v} rows={1} aria-label="Description"
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === "Escape") { setV(value); } }} />
  );
}

function TextField({ id, value, onSave, placeholder, list }: { id: string; value: string; onSave: (v: string) => void; placeholder?: string; list?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value) onSave(v.trim()); };
  return (
    <input id={id} value={v} placeholder={placeholder} list={list} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setV(value); }} />
  );
}

function TagEditor({ tags, known, onChange }: { tags: string[]; known: string[]; onChange: (t: string[]) => void }) {
  const [v, setV] = useState("");
  const add = () => {
    const t = v.trim().replace(/^\+/, "");
    setV("");
    if (t && !tags.includes(t)) onChange([...tags, t]);
  };
  return (
    <div className="tag-edit">
      {tags.map((t) => (
        <span key={t} className="chip tag">+{t}
          <button aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon.close /></button>
        </span>
      ))}
      <input value={v} list="tags" placeholder={tags.length ? "" : "add tag"} aria-label="Add tag" autoCapitalize="off"
        onChange={(e) => setV(e.target.value.replace(/\s/g, ""))} onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !v && tags.length) onChange(tags.slice(0, -1));
        }} />
      <datalist id="tags">{known.filter((k) => !tags.includes(k)).map((k) => <option key={k} value={k} />)}</datalist>
    </div>
  );
}

function DateRow({ label, field, task, onSave }: {
  label: string; field: "due" | "scheduled" | "wait"; task: Task; onSave: (p: Patch, o?: Partial<Task>) => unknown;
}) {
  const current = twDate(task[field]);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const set = (value: string | null) => {
    setEditing(false);
    setText("");
    onSave({ [field]: value });
  };
  const id = `f-${field}`;
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="fval" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input id={id} value={editing ? text : current ? `${relDate(current)}` : ""} placeholder="fri, eow, 2026-11-01"
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            title={current ? longDate(current) : undefined}
            onFocus={() => { setEditing(true); setText(""); }}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (text.trim()) set(text.trim()); else setEditing(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setText(""); (e.target as HTMLInputElement).blur(); } }} />
          <button className="icon-btn" style={{ width: 34, height: 34 }} aria-label={`Pick ${label.toLowerCase()} date`}
            onClick={() => { const p = pickerRef.current; if (p) { try { p.showPicker(); } catch { p.focus(); } } }}>
            <Icon.today />
          </button>
          <input ref={pickerRef} type="datetime-local" tabIndex={-1} aria-hidden="true" value={toLocalInput(current)}
            style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
            onChange={(e) => { if (e.target.value) set(e.target.value); }} />
        </div>
        {editing && <div className="quick-dates">
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => set("today")}>today</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => set("tomorrow")}>tomorrow</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => set("monday")}>mon</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => set("eow")}>eow</button>
          {current && <button onMouseDown={(e) => e.preventDefault()} onClick={() => set(null)}>clear</button>}
        </div>}
      </div>
    </>
  );
}

function NoteText({ text }: { text: string }) {
  return (
    <div className="note-text">
      {linkify(text).map((p, i) => typeof p === "string" ? p : <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{p.href}</a>)}
    </div>
  );
}

function Notes({ task, onSave }: { task: Task; onSave: (a: { entry: string; description: string }[]) => unknown }) {
  const notes = task.annotations ?? [];
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(draftRef, draft);
  useAutosize(editRef, editText);

  const add = () => {
    const d = draft.trim();
    if (!d) return;
    onSave([...notes, { entry: "", description: d }]);
    setDraft("");
  };
  const commitEdit = () => {
    if (editing === null) return;
    const next = notes.map((n, i) => (i === editing ? { ...n, description: editText.trim() } : n)).filter((n) => n.description);
    if (editText.trim() !== notes[editing]?.description) onSave(next);
    setEditing(null);
  };

  return (
    <section>
      <h3 className="section-title">Notes <span className="muted">{notes.length || ""}</span></h3>
      <div className="notes">
        {notes.map((n, i) => (
          <div key={`${n.entry}-${i}`} className="note" onClick={() => { if (editing !== i) { setEditing(i); setEditText(n.description); } }}>
            {editing === i ? (
              <textarea ref={editRef} autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={commitEdit}
                onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit(); }} />
            ) : <NoteText text={n.description} />}
            <div className="note-meta">
              <span>{n.entry ? relDate(twDate(n.entry)!) : "now"}</span>
              <button onClick={(e) => { e.stopPropagation(); onSave(notes.filter((_, j) => j !== i)); }} aria-label="Delete note">delete</button>
            </div>
          </div>
        ))}
        <div className="note-new">
          <textarea ref={draftRef} value={draft} placeholder="Write a note…" rows={2} aria-label="New note"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }} />
          {draft.trim() && (
            <div className="row-between">
              <span className="muted mono" style={{ fontSize: 12 }}>Saved as a Taskwarrior annotation · ⌘↵</span>
              <button className="btn small primary" onClick={add}>Add note</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
