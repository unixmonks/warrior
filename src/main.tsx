import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./ui/styles.css";
import "./desktop.css";

import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyStoredTheme, Toasts } from "./ui/common";
import { pathView } from "./ui/lib";
import { navigate, usePath, useStore } from "./ui/store";
import { Workspace } from "./ui/Workspace";
import { Settings } from "./Settings";
import { Setup } from "./Setup";
import { DesktopStoreProvider } from "./store";
import { desktop, type TaskStatus } from "./tauri";

applyStoredTheme();

// Links to the web open in the browser, not inside the app window.
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
  if (a && /^(https?|mailto):/.test(a.href) && new URL(a.href).origin !== location.origin) {
    e.preventDefault();
    void openUrl(a.href);
  }
});

// Ctrl/Cmd+, opens Settings, as in most desktop apps.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    navigate("/settings");
  }
});

function App() {
  const [status, setStatus] = useState<TaskStatus | null>(null);

  useEffect(() => {
    // Listen first: the first check may finish before status() answers.
    const un = listen<TaskStatus>("task-status", (e) => setStatus(e.payload));
    desktop.status().then((s) => { if (s.checked) setStatus(s); }).catch(() => {});
    return () => void un.then((f) => f());
  }, []);

  if (!status) return <div style={{ minHeight: "100dvh" }} />;
  if (!status.ok) return <Setup status={status} onStatus={setStatus} />;
  return (
    // A different task or .taskrc is a different task list: start over.
    <DesktopStoreProvider key={`${status.path}|${status.taskrc}|${status.wsl}`}>
      <Routes status={status} />
    </DesktopStoreProvider>
  );
}

function Routes({ status }: { status: TaskStatus }) {
  const path = usePath();
  const { toasts, dismiss } = useStore();
  if (path === "/settings") return <Settings status={status} />;
  const view = pathView(path) ?? { kind: "next" as const };
  const selected = new URLSearchParams(location.search).get("t");
  return (
    <>
      <Workspace view={view} initialSelected={selected} />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
