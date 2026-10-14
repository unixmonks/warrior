import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { navigate, type Toast } from "./store";

export function Brand() {
  return (
    <a href="/" className="brand" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
      <span className="brand-mark" aria-hidden="true">w&gt;</span>
      <span>warrior</span>
    </a>
  );
}

type Theme = "system" | "light" | "dark";
const THEME_KEY = "warrior:theme";

export function applyStoredTheme() {
  let t: Theme = "system";
  try { t = (localStorage.getItem(THEME_KEY) as Theme) || "system"; } catch { /* storage blocked */ }
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  return t;
}

function isDark(t: Theme) {
  return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => applyStoredTheme());
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
    applyStoredTheme();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark(theme) ? "#121317" : "#f6f6f3");
  }, [theme]);
  const dark = isDark(theme);
  return (
    <button className={className} onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
      {dark ? <Icon.sun /> : <Icon.moon />}<span className="label">{dark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone ?? ""}`}>
          <span>{t.text}</span>
          {t.action && <button onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
