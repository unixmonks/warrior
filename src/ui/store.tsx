import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Backend } from "./backend";
import type { Changes, Task } from "./lib";

/** What the sync button shows. */
export interface Me {
  sync: {
    configured: boolean;
    url: string | null;
    clientId: string | null;
    lastSyncAt: number | null;
    lastSyncOk: boolean | null;
    lastSyncMessage: string | null;
  };
}

export interface Toast {
  id: number;
  text: string;
  tone?: "err";
  action?: { label: string; run: () => void };
}

interface Store {
  me: Me;
  refreshMe: () => Promise<void>;
  tasks: Map<string, Task>;
  loaded: boolean;
  apply: (c: Changes) => void;
  /** Run a mutation; changes are applied, errors toasted, and a sync queued. */
  mutate: <T extends Changes>(fn: () => Promise<T>, optimistic?: (t: Map<string, Task>) => void) => Promise<T | null>;
  syncing: boolean;
  syncNow: () => Promise<void>;
  toast: (text: string, opts?: Omit<Toast, "id" | "text">) => void;
  toasts: Toast[];
  dismiss: (id: number) => void;
  /** Where reads and changes go: the local `task`. */
  backend: Backend;
  /** Older completed and deleted tasks that load on demand. */
  history: { complete: boolean; load: () => Promise<void> };
}

/** Filled by the app's store (src/store.tsx). */
export const StoreContext = createContext<Store | null>(null);
const Ctx = StoreContext;

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
}

export const SYNC_DELAY = 3000;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback((text: string, opts: Omit<Toast, "id" | "text"> = {}) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text, ...opts }]);
    window.setTimeout(() => dismiss(id), opts.action ? 6000 : 4000);
  }, [dismiss]);
  return { toasts, toast, dismiss };
}

/**
 * The task list and the way changes are applied to it: optimistic update,
 * the backend's answer applied on top, rolled back and toasted on failure.
 */
export function useTaskList(toast: Store["toast"], afterWrite: () => void) {
  const [tasks, setTasks] = useState<Map<string, Task>>(new Map());
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((c: Changes) => {
    if (!c.changed.length && !c.removed.length) return;
    setTasks((prev) => {
      const next = new Map(prev);
      for (const t of c.changed) next.set(t.uuid, t);
      for (const u of c.removed) next.delete(u);
      return next;
    });
  }, []);

  const replace = useCallback((all: Task[]) => {
    setTasks(new Map(all.map((t) => [t.uuid, t])));
    setLoaded(true);
  }, []);

  const mutate = useCallback(async <T extends Changes>(fn: () => Promise<T>, optimistic?: (t: Map<string, Task>) => void) => {
    let snapshot: Map<string, Task> | null = null;
    if (optimistic) {
      setTasks((prev) => {
        snapshot = prev;
        const next = new Map(prev);
        optimistic(next);
        return next;
      });
    }
    try {
      const r = await fn();
      apply(r);
      afterWrite();
      return r;
    } catch (e) {
      if (snapshot) setTasks(snapshot);
      toast((e as Error).message, { tone: "err" });
      return null;
    }
  }, [apply, afterWrite, toast]);

  return { tasks, loaded, setLoaded, apply, replace, mutate };
}

// ---- tiny router ----------------------------------------------------------

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event("warrior:navigate"));
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    window.addEventListener("warrior:navigate", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("warrior:navigate", on);
    };
  }, []);
  return path;
}
