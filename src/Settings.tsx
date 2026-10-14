import { getVersion } from "@tauri-apps/api/app";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Brand, ThemeToggle, Toasts } from "./ui/common";
import { Icon } from "./ui/icons";
import { ago } from "./ui/lib";
import { navigate, useStore } from "./ui/store";
import { useDesktopSync } from "./store";
import { desktop, syncConfigured, type AppSettings, type Rule, type TaskStatus } from "./tauri";

export function Settings({ status }: { status: TaskStatus }) {
  useEffect(() => { document.title = "Settings · warrior"; }, []);
  const { toasts, dismiss, toast } = useStore();
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => { desktop.getSettings().then(setSettings).catch((e) => toast((e as Error).message, { tone: "err" })); }, [toast]);

  const save = useCallback(async (patch: Partial<AppSettings>) => {
    if (!settings) return false;
    try {
      setSettings(await desktop.saveSettings({ ...settings, ...patch }));
      return true;
    } catch (e) {
      toast((e as Error).message, { tone: "err" });
      return false;
    }
  }, [settings, toast]);

  return (
    <div className="page">
      <header className="page-header" style={{ maxWidth: 808 }}>
        <Brand />
        <div style={{ display: "flex", gap: 6 }}>
          <ThemeToggle className="icon-btn" />
          <button className="btn small" onClick={() => navigate("/")}><Icon.back />Tasks</button>
        </div>
      </header>
      <main className="settings" style={{ margin: "0 auto", width: "100%" }}>
        <div className="view-head" style={{ paddingTop: 0 }}><h1>Settings</h1></div>
        {settings ? <>
          <SyncCard settings={settings} save={save} />
          <TaskwarriorCard status={status} settings={settings} save={save} />
          <RemindersCard settings={settings} save={save} />
          <AppCard status={status} settings={settings} save={save} />
          <DataCard />
          <AboutCard />
        </> : <section className="card"><div className="muted">Loading…</div></section>}
      </main>
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

type Save = (patch: Partial<AppSettings>) => Promise<boolean>;

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

function ToggleRow({ title, children, on, onChange }: { title: string; children: ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row-between">
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <strong>{title}</strong>
        <div className="muted" style={{ fontSize: 14 }}>{children}</div>
      </div>
      <Switch on={on} label={title} onChange={onChange} />
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

// ---- sync -------------------------------------------------------------------

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const INTERVALS: [number, string][] = [[5, "every 5 minutes"], [10, "every 10 minutes"], [30, "every 30 minutes"], [60, "every hour"]];

function SyncCard({ settings, save }: { settings: AppSettings; save: Save }) {
  const { apply, syncNow, syncing, toast } = useStore();
  const { sync, setSync } = useDesktopSync();
  const c = sync.config;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(c.url ?? "https://taskwarriorsync.com");
  const [clientId, setClientId] = useState(c.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [newAccount, setNewAccount] = useState(false);

  const showForm = editing || c.kind === "none" || c.kind === "";

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await desktop.syncConfigure(url, clientId, secret || null);
      apply(r);
      setResult(r);
      if (r.ok) { setEditing(false); setSecret(""); setNewAccount(false); }
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
      desktop.syncState().then(setSync).catch(() => {});
    }
  };

  const join = async () => {
    setBusy(true);
    try {
      const r = await desktop.syncJoin();
      apply(r);
      setResult(r);
      toast(r.ok ? "Connected to your sync account" : `Sync failed: ${r.message.split("\n")[0]}`, r.ok ? {} : { tone: "err" });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const generate = () => {
    setNewAccount(true);
    setClientId(crypto.randomUUID());
    setSecret(randomSecret());
  };

  const kindLabel = c.kind === "local" ? "a folder" : c.kind === "gcp" ? "Google Cloud Storage" : c.kind === "aws" ? "Amazon S3" : "a sync server";

  return (
    <section className="card">
      <div className="row-between">
        <div>
          <div className="eyebrow accent">Sync</div>
          <h2>Taskwarrior sync</h2>
        </div>
        {syncConfigured(c)
          ? <span className={`badge ${sync.lastOk === false ? "err" : "ok"}`}>{sync.lastOk === false ? "Failing" : "Connected"}</span>
          : <span className="badge off">Off</span>}
      </div>
      <p>
        warrior runs <Code>task sync</Code> with the settings in your .taskrc, so it syncs with the same TaskChampion
        server as your other machines. Changes sync a few seconds after you make them, and in the background while the app is open.
      </p>

      {sync.needsJoin && (
        <div className="alert error">
          <p style={{ margin: "0 0 10px" }}>
            The server has history this computer has never seen and won't send it all (410 Gone). warrior can fix this:
            it backs up your Taskwarrior database, downloads your account into a fresh one, then uploads any tasks that were only on this computer.
          </p>
          <button className="btn small primary" onClick={join} disabled={busy}>{busy ? "Connecting…" : "Download my account and merge"}</button>
        </div>
      )}

      {syncConfigured(c) && !showForm && (
        <>
          <dl className="info-grid" style={{ fontSize: 14 }}>
            {c.kind === "server" ? <>
              <dt>Server</dt><dd>{c.url}</dd>
              <dt>Client ID</dt><dd>{c.clientId ?? "not set"}</dd>
              <dt>Secret</dt><dd>{c.hasSecret ? "set in .taskrc" : "not set"}</dd>
            </> : <>
              <dt>Syncs with</dt><dd>{kindLabel}: {c.localDir ?? c.bucket}</dd>
            </>}
            <dt>Last sync</dt><dd>{sync.running ? "syncing now" : sync.lastAt ? ago(sync.lastAt) : "not yet"}</dd>
          </dl>
          {sync.lastOk === false && sync.lastMessage && !sync.needsJoin && <div className="alert error">{sync.lastMessage}</div>}
          <div className="actions">
            <button className="btn primary" onClick={() => void syncNow()} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</button>
            <button className="btn" onClick={() => setEditing(true)}>{c.kind === "server" ? "Change server" : "Use a sync server instead"}</button>
          </div>
        </>
      )}

      {showForm && (
        <form className="form-stack" onSubmit={connect}>
          <div className="field">
            <label htmlFor="s-url">Server URL</label>
            <input id="s-url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} required autoCapitalize="off" spellCheck={false} />
            <span className="help">
              Any TaskChampion sync server. No server yet? <a href="https://taskwarriorsync.com" target="_blank" rel="noopener">taskwarriorsync.com</a> hosts
              one, or run <a href="https://github.com/GothenburgBitFactory/taskchampion-sync-server" target="_blank" rel="noopener">taskchampion-sync-server</a> yourself.
            </span>
          </div>
          <div className="field">
            <label htmlFor="s-client">Client ID</label>
            <input id="s-client" className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} required placeholder="7c1c9b4e-…" autoCapitalize="off" spellCheck={false} />
            <span className="help">
              From <Code>task _get rc.sync.server.client_id</Code> on a machine that already syncs.{" "}
              First machine on this account?{" "}
              <button type="button" className="link-btn" onClick={generate}>Generate a client ID and secret</button>
            </span>
          </div>
          <div className="field">
            <label htmlFor="s-secret">Encryption secret</label>
            <input id="s-secret" className="mono" type={newAccount ? "text" : "password"} value={secret} onChange={(e) => setSecret(e.target.value)}
              required={!c.hasSecret} placeholder={c.hasSecret ? "Leave blank to keep the one in .taskrc" : ""} autoComplete="off" spellCheck={false} />
            <span className="help">
              Tasks are encrypted with this before they leave your computer. It's saved in your .taskrc like any other Taskwarrior setting.
              {newAccount && <strong> Keep a copy somewhere safe: you'll need it on your other machines, and nobody can recover it.</strong>}
            </span>
          </div>
          {result && <div className={`alert ${result.ok ? "ok" : "error"}`}>{result.message}</div>}
          <div className="actions">
            <button className="btn primary" disabled={busy}>{busy ? "Connecting…" : "Save to .taskrc and sync"}</button>
            {syncConfigured(c) && <button type="button" className="btn" onClick={() => { setEditing(false); setResult(null); }}>Cancel</button>}
          </div>
        </form>
      )}

      {syncConfigured(c) && (
        <>
          <ToggleRow title="Sync automatically" on={settings.autoSync} onChange={(autoSync) => void save({ autoSync })}>
            After each change, and{" "}
            <select aria-label="Background sync interval" value={settings.syncIntervalMinutes} disabled={!settings.autoSync}
              onChange={(e) => void save({ syncIntervalMinutes: Number(e.target.value) })} className="inline-select">
              {INTERVALS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </select>{" "}
            while the app is open.
          </ToggleRow>
          {c.kind === "server" && (
            <details>
              <summary className="section-title" style={{ cursor: "pointer", margin: 0 }}>Setting up another machine</summary>
              <pre className="code" style={{ marginTop: 12 }}>{`task config sync.server.url        ${c.url}
task config sync.server.client_id  ${c.clientId ?? "[client ID]"}
task config sync.encryption_secret [your secret]
task sync`}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}

// ---- taskwarrior ------------------------------------------------------------

function TaskwarriorCard({ status, settings, save }: { status: TaskStatus; settings: AppSettings; save: Save }) {
  const { toast } = useStore();
  const pick = async (what: "taskPath" | "taskrc") => {
    const path = await openDialog({ multiple: false, directory: false, title: what === "taskPath" ? "Choose the task program" : "Choose a .taskrc" });
    if (typeof path === "string" && await save({ [what]: path })) toast(what === "taskPath" ? "Using that task program" : "Using that .taskrc");
  };
  return (
    <section className="card">
      <div>
        <div className="eyebrow accent">Taskwarrior</div>
        <h2>Your task setup</h2>
      </div>
      <p>warrior runs your own <Code>task</Code> with your own .taskrc, so reports, urgency, contexts, UDAs and hooks behave exactly as in your terminal.</p>
      <dl className="info-grid" style={{ fontSize: 14 }}>
        <dt>Program</dt><dd>{status.path ?? "not found"}{status.version ? ` (${status.version})` : ""}</dd>
        {!status.wsl && <><dt>.taskrc</dt><dd>{status.taskrc ?? "default"}</dd></>}
        <dt>Data</dt><dd>{status.dataDir ?? "unknown"}</dd>
      </dl>
      <div className="actions">
        {!status.wsl && <button className="btn small" onClick={() => void pick("taskPath")}>Choose program…</button>}
        {!status.wsl && <button className="btn small" onClick={() => void pick("taskrc")}>Choose .taskrc…</button>}
        {(settings.taskPath || settings.taskrc) && (
          <button className="btn small ghost" onClick={() => void save({ taskPath: null, taskrc: null })}>Use the defaults</button>
        )}
      </div>
      {status.platform === "windows" && (
        <ToggleRow title="Use Taskwarrior inside WSL" on={settings.useWsl} onChange={(useWsl) => void save({ useWsl })}>
          Runs <Code>wsl task</Code>, with your tasks and .taskrc inside WSL. Changes made in a WSL terminal show up within a minute.
        </ToggleRow>
      )}
    </section>
  );
}

// ---- reminders --------------------------------------------------------------

const OFFSETS: [number, string][] = [[0, "when it's due"], [15, "15 minutes before"], [60, "1 hour before"], [180, "3 hours before"], [1440, "1 day before"]];

function hourLabel(h: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, h));
}

function RemindersCard({ settings, save }: { settings: AppSettings; save: Save }) {
  const { toast } = useStore();
  const setRule = (r: Rule) => save({ rules: settings.rules.map((x) => (x.id === r.id ? r : x)) });
  const add = (kind: Rule["kind"]) => {
    const rule: Rule = kind === "due"
      ? { id: crypto.randomUUID(), name: "Due reminder", kind, filter: "", offsetMinutes: 0, digestHour: 8, enabled: true }
      : { id: crypto.randomUUID(), name: "Daily digest", kind, filter: "", offsetMinutes: 0, digestHour: 8, enabled: true };
    void save({ rules: [...settings.rules, rule] });
  };
  return (
    <section className="card">
      <div>
        <div className="eyebrow accent">Reminders</div>
        <h2>Notifications</h2>
      </div>
      <ToggleRow title="Show reminders" on={settings.notifications} onChange={(notifications) => void save({ notifications })}>
        Desktop notifications when tasks come due, while warrior is running. Reminders missed while the computer was off appear when it's back.
      </ToggleRow>
      {settings.notifications && <>
        {settings.rules.map((r) => (
          <RuleEditor key={r.id} rule={r} onChange={setRule} onDelete={() => void save({ rules: settings.rules.filter((x) => x.id !== r.id) })} />
        ))}
        <div className="actions">
          <button className="btn small" onClick={() => add("due")}><Icon.clock />Add due reminder</button>
          <button className="btn small" onClick={() => add("digest")}><Icon.today />Add daily digest</button>
          <button className="btn small ghost" onClick={() => desktop.testNotification().catch((e) => toast((e as Error).message, { tone: "err" }))}>Send a test</button>
        </div>
      </>}
    </section>
  );
}

function RuleEditor({ rule, onChange, onDelete }: { rule: Rule; onChange: (r: Rule) => Promise<boolean>; onDelete: () => void }) {
  const [name, setName] = useState(rule.name);
  const [filter, setFilter] = useState(rule.filter);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);

  const commitFilter = async () => {
    if (filter === rule.filter) return;
    const next = { ...rule, filter: filter.trim() };
    try {
      const n = await desktop.previewRule(next);
      setCheck({ ok: true, text: `Matches ${n} pending task${n === 1 ? "" : "s"}${rule.kind === "due" ? " with a due date" : ""} right now.` });
      await onChange(next);
    } catch (e) {
      setCheck({ ok: false, text: (e as Error).message });
    }
  };

  const summary = rule.kind === "due"
    ? `A notification for each task ${OFFSETS.find(([m]) => m === rule.offsetMinutes)?.[1] ?? `${rule.offsetMinutes} minutes before it's due`}`
    : `One notification at ${hourLabel(rule.digestHour)} with what's due today or overdue`;

  return (
    <div className="rule">
      <div className="rule-head">
        <Switch on={rule.enabled} label="Enabled" onChange={(enabled) => void onChange({ ...rule, enabled })} />
        <div style={{ minWidth: 0 }}>
          <strong>{rule.name}</strong>
          <div className="sub">{summary}</div>
        </div>
      </div>
      <div className="rule-grid">
        <div className="field">
          <label htmlFor={`n-${rule.id}`}>Name</label>
          <input id={`n-${rule.id}`} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== rule.name && void onChange({ ...rule, name: name.trim() })} />
        </div>
        {rule.kind === "due" ? (
          <div className="field">
            <label htmlFor={`o-${rule.id}`}>Notify</label>
            <select id={`o-${rule.id}`} value={rule.offsetMinutes} onChange={(e) => void onChange({ ...rule, offsetMinutes: Number(e.target.value) })}>
              {OFFSETS.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
              {!OFFSETS.some(([m]) => m === rule.offsetMinutes) && <option value={rule.offsetMinutes}>{rule.offsetMinutes} minutes before</option>}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor={`h-${rule.id}`}>At</label>
            <select id={`h-${rule.id}`} value={rule.digestHour} onChange={(e) => void onChange({ ...rule, digestHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor={`f-${rule.id}`}>Only tasks matching (optional)</label>
        <input id={`f-${rule.id}`} className="mono" value={filter} placeholder="any Taskwarrior filter, e.g. project:work or +bill" autoCapitalize="off" spellCheck={false}
          onChange={(e) => { setFilter(e.target.value); setCheck(null); }} onBlur={() => void commitFilter()}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        {check && <span className="help" style={check.ok ? undefined : { color: "var(--danger)" }}>{check.text}</span>}
      </div>
      <div className="actions">
        <button className="btn small ghost" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// ---- app --------------------------------------------------------------------

function AppCard({ status, settings, save }: { status: TaskStatus; settings: AppSettings; save: Save }) {
  const { toast } = useStore();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => { autostartEnabled().then(setAutostart).catch(() => setAutostart(null)); }, []);
  const toggleAutostart = async (on: boolean) => {
    try {
      await (on ? enableAutostart() : disableAutostart());
      setAutostart(on);
    } catch (e) {
      toast((e as Error).message, { tone: "err" });
    }
  };
  return (
    <section className="card">
      <div>
        <div className="eyebrow accent">App</div>
        <h2>Running in the background</h2>
      </div>
      {status.tray ? (
        <ToggleRow title="Keep running when the window is closed" on={settings.closeToTray} onChange={(closeToTray) => void save({ closeToTray })}>
          warrior stays in the system tray, so reminders and background sync keep working. Quit from the tray icon.
        </ToggleRow>
      ) : (
        <p className="muted">Your desktop has no system tray, so warrior quits when its window is closed.</p>
      )}
      {autostart !== null && (
        <ToggleRow title="Start at login" on={autostart} onChange={(on) => void toggleAutostart(on)}>
          {status.tray ? "Starts in the tray, without opening a window." : "Opens warrior when you log in."}
        </ToggleRow>
      )}
    </section>
  );
}

// ---- data -------------------------------------------------------------------

function DataCard() {
  const { toast, mutate } = useStore();
  const exportAll = async () => {
    const path = await saveDialog({ defaultPath: `tasks-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      const n = await desktop.exportTasks(path);
      toast(`Exported ${n} task${n === 1 ? "" : "s"}`);
    } catch (e) {
      toast((e as Error).message, { tone: "err" });
    }
  };
  const importFile = async () => {
    const path = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    const r = await mutate(() => desktop.importTasks(path));
    if (r) toast(r.output.split("\n").filter(Boolean).pop() || "Imported");
  };
  return (
    <section className="card">
      <div>
        <div className="eyebrow accent">Data</div>
        <h2>Import and export</h2>
      </div>
      <p>Export saves every task, including history, as <Code>task export</Code> JSON. Import runs <Code>task import</Code>; tasks with matching UUIDs are updated.</p>
      <div className="actions">
        <button className="btn" onClick={() => void exportAll()}>Export JSON…</button>
        <button className="btn" onClick={() => void importFile()}>Import JSON…</button>
      </div>
    </section>
  );
}

function AboutCard() {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  return (
    <section className="card">
      <div>
        <div className="eyebrow accent">About</div>
        <h2>warrior {version}</h2>
      </div>
      <p>
        A desktop app for <a href="https://taskwarrior.org" target="_blank" rel="noopener">Taskwarrior</a>.
        Not affiliated with the Taskwarrior project.
      </p>
    </section>
  );
}
