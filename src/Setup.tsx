// Shown until warrior can run Taskwarrior 3: install instructions, or a
// way to point at the right `task` or .taskrc.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Brand, ThemeToggle } from "./ui/common";
import { desktop, type TaskStatus } from "./tauri";

const INSTALL: Record<string, [string, string][]> = {
  macos: [["Homebrew", "brew install task"], ["MacPorts", "sudo port install taskwarrior"]],
  linux: [
    ["Debian, Ubuntu", "sudo apt install taskwarrior"],
    ["Fedora", "sudo dnf install task"],
    ["Arch", "sudo pacman -S task"],
    ["openSUSE", "sudo zypper install taskwarrior"],
    ["Void", "sudo xbps-install task"],
    ["Homebrew", "brew install task"],
  ],
  windows: [
    ["1. Install WSL (PowerShell, as administrator)", "wsl --install"],
    ["2. Inside WSL", "sudo apt install taskwarrior"],
  ],
};

export function Setup({ status, onStatus }: { status: TaskStatus; onStatus: (s: TaskStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<TaskStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      onStatus(s);
      if (!s.ok && s.message) setError(s.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (what: "taskPath" | "taskrc") => {
    const path = await openDialog({ multiple: false, directory: false, title: what === "taskPath" ? "Choose the task program" : "Choose a .taskrc" });
    if (typeof path !== "string") return;
    await run(async () => {
      const settings = await desktop.getSettings();
      await desktop.saveSettings({ ...settings, [what]: path });
      return desktop.status();
    });
  };

  const useWsl = () => run(async () => {
    const settings = await desktop.getSettings();
    await desktop.saveSettings({ ...settings, useWsl: true });
    return desktop.status();
  });

  const tooOld = !!status.version && !status.ok && !status.needsTaskrc;
  const steps = INSTALL[status.platform] ?? INSTALL.linux;

  return (
    <div className="page">
      <header className="page-header" style={{ maxWidth: 808 }}>
        <Brand />
        <ThemeToggle className="icon-btn" />
      </header>
      <main className="settings" style={{ margin: "0 auto", width: "100%" }}>
        <div className="view-head" style={{ paddingTop: 0 }}>
          <div>
            <div className="eyebrow">first, taskwarrior</div>
            <h1>{status.needsTaskrc ? "Create a Taskwarrior config" : tooOld ? "Taskwarrior needs an update" : "Install Taskwarrior"}</h1>
          </div>
        </div>

        {status.needsTaskrc ? (
          <section className="card">
            <p>
              Taskwarrior is installed ({status.version}), but it won't start without a configuration file. warrior can create an empty one at{" "}
              <code className="inline-code">{status.taskrc}</code>. Taskwarrior's defaults apply until you change it, and your tasks will live in{" "}
              <code className="inline-code">~/.task</code>.
            </p>
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={() => void run(desktop.createTaskrc)}>Create .taskrc</button>
              <button className="btn" disabled={busy} onClick={() => void choose("taskrc")}>Use another .taskrc…</button>
            </div>
          </section>
        ) : (
          <section className="card">
            <p>
              warrior is a window onto Taskwarrior: every change goes through the <code className="inline-code">task</code> program
              on this computer, using your own settings. It needs Taskwarrior 3.0 or later.
            </p>
            {tooOld && <div className="alert error">Found Taskwarrior {status.version} at {status.path}. Version 3 changed how tasks are stored and synced; upgrade to use warrior.</div>}
            <div className="form-stack" style={{ gap: 10 }}>
              {steps.map(([label, cmd]) => (
                <div key={label} className="field">
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
                  <pre className="code" style={{ padding: "10px 14px" }}>{cmd}</pre>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 14 }}>
              Some distributions still ship Taskwarrior 2. Check with <code className="inline-code">task --version</code>, and see{" "}
              <a href="https://taskwarrior.org/download/" target="_blank" rel="noopener">taskwarrior.org/download</a> for other options.
            </p>
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={() => void run(desktop.recheck)}>{busy ? "Checking…" : "I've installed it"}</button>
              {status.platform === "windows"
                ? <button className="btn" disabled={busy} onClick={() => void useWsl()}>Use Taskwarrior in WSL</button>
                : <button className="btn" disabled={busy} onClick={() => void choose("taskPath")}>It's somewhere else…</button>}
            </div>
          </section>
        )}
        {error && <div className="alert error">{error}</div>}
      </main>
    </div>
  );
}
