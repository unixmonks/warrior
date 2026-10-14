// The app's store: the task list, sync state and the Tauri backend, provided
// to the views in src/ui through StoreContext.

import { listen } from "@tauri-apps/api/event";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Changes } from "./ui/lib";
import { SYNC_DELAY, StoreContext, useTaskList, useToasts, type Me } from "./ui/store";
import { desktop, syncConfigured, tauriBackend, type SyncState } from "./tauri";

/** Re-export on window focus at most this often, to catch anything the watcher missed. */
const FOCUS_REFRESH_MS = 30_000;

const NO_SYNC: SyncState = {
  config: { kind: "none", url: null, clientId: null, hasSecret: false, localDir: null, bucket: null, dataDir: null },
  auto: true, running: false, lastAt: null, lastOk: null, lastMessage: null, needsJoin: false,
};

interface DesktopSync {
  sync: SyncState;
  setSync: (s: SyncState) => void;
}

const DesktopSyncContext = createContext<DesktopSync | null>(null);

/** Sync details for the Settings page (Me has less). */
export function useDesktopSync(): DesktopSync {
  const c = useContext(DesktopSyncContext);
  if (!c) throw new Error("useDesktopSync outside provider");
  return c;
}

export function DesktopStoreProvider({ children }: { children: ReactNode }) {
  const { toasts, toast, dismiss } = useToasts();
  const [sync, setSync] = useState<SyncState>(NO_SYNC);
  const [historyComplete, setHistoryComplete] = useState(false);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const syncTimer = useRef(0);
  const queueRef = useRef(() => {});
  const afterWrite = useCallback(() => queueRef.current(), []);
  const { tasks, loaded, setLoaded, apply, replace, mutate } = useTaskList(toast, afterWrite);

  const load = useCallback(async () => {
    const r = await desktop.list();
    replace(r.tasks);
    setHistoryComplete(r.historyComplete);
  }, [replace]);

  const syncNow = useCallback(async () => {
    window.clearTimeout(syncTimer.current);
    if (!syncConfigured(syncRef.current.config)) return;
    try {
      const r = await desktop.syncNow();
      apply(r);
      if (!r.ok) toast(`Sync failed: ${r.message.split("\n")[0]}`, { tone: "err" });
    } catch (e) {
      toast((e as Error).message, { tone: "err" });
    }
  }, [apply, toast]);

  // Sync a few seconds after a change, so a burst of edits syncs once.
  queueRef.current = () => {
    const s = syncRef.current;
    if (!s.auto || !syncConfigured(s.config)) return;
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => void syncNow(), SYNC_DELAY);
  };

  useEffect(() => {
    const unlisten = [
      listen<Changes>("tasks-changed", (e) => apply(e.payload)),
      listen<SyncState>("sync-state", (e) => setSync(e.payload)),
      listen("tasks-reset", () => void load().catch(() => {})),
    ];
    desktop.syncState().then(setSync).catch(() => {});
    load().catch((e) => {
      setLoaded(true);
      toast((e as Error).message, { tone: "err" });
    });
    let lastRefresh = Date.now();
    const onFocus = () => {
      if (Date.now() - lastRefresh < FOCUS_REFRESH_MS) return;
      lastRefresh = Date.now();
      desktop.refresh().then(apply).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      unlisten.forEach((p) => void p.then((f) => f()));
    };
  }, [apply, load, setLoaded, toast]);

  const me = useMemo<Me>(() => ({
    sync: {
      configured: syncConfigured(sync.config),
      url: sync.config.url ?? sync.config.localDir ?? sync.config.bucket,
      clientId: sync.config.clientId,
      lastSyncAt: sync.lastAt,
      lastSyncOk: sync.lastOk,
      lastSyncMessage: sync.lastMessage,
    },
  }), [sync]);

  const refreshMe = useCallback(async () => setSync(await desktop.syncState()), []);
  const loadHistory = useCallback(async () => {
    try {
      apply(await desktop.loadHistory());
      setHistoryComplete(true);
    } catch (e) {
      toast((e as Error).message, { tone: "err" });
    }
  }, [apply, toast]);

  const value = useMemo(() => ({
    me, refreshMe, tasks, loaded, apply, mutate, syncing: sync.running, syncNow, toast, toasts, dismiss,
    backend: tauriBackend,
    history: { complete: historyComplete, load: loadHistory },
  }), [me, refreshMe, tasks, loaded, apply, mutate, sync.running, syncNow, toast, toasts, dismiss, historyComplete, loadHistory]);

  const desktopSync = useMemo(() => ({ sync, setSync }), [sync]);

  return (
    <StoreContext.Provider value={value}>
      <DesktopSyncContext.Provider value={desktopSync}>{children}</DesktopSyncContext.Provider>
    </StoreContext.Provider>
  );
}
