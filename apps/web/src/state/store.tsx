import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { LifeMentorApp, AuthState, SyncStatusView, Notification } from '@lifementor/core';
import { bootstrapApp, resetAppPromise, SERVER_URL } from '../core/app';
import { pollPendingNotifications } from '../push';

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'ok' | 'warn' }

interface AppState {
  app: LifeMentorApp | null;
  loading: boolean;
  loadError: string | null;
  /** bump to refetch screen data after any local mutation */
  version: number;
  refresh: () => void;
  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  online: boolean;
  auth: AuthState | null;
  syncStatus: SyncStatusView | null;
  notifications: Notification[];
  unreadCount: number;
  /** run a local mutation, bump data version, surface errors */
  mutate: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | null>;
  /** full app reset (wipes local DB) and re-bootstrap */
  hardReset: () => Promise<void>;
  serverUrl: string;
}

const Ctx = createContext<AppState>(null as never);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [app, setApp] = useState<LifeMentorApp | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatusView | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [resetTick, setResetTick] = useState(0);
  const toastId = useRef(1);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = toastId.current++;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  // ── bootstrap ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    bootstrapApp()
      .then((a) => { if (!cancelled) { setApp(a); setLoading(false); } })
      .catch((error) => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [resetTick]);

  // ── online status ─────────────────────────────────────────────────
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOffline();
    const off = () => setOnline(false);
    function setOffline() { setOnline(false); }
    window.addEventListener('online', up);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', off); void down; };
  }, []);

  // ── periodic background updates (auth state, sync, inbox) ─────────
  useEffect(() => {
    if (!app) return;
    let stop = false;
    const tick = async () => {
      try {
        const [a, s, inbox] = await Promise.all([
          app.services.auth.state(),
          app.services.sync ? app.services.sync.status() : Promise.resolve(null),
          app.services.notifications.inbox(30),
        ]);
        if (stop) return;
        setAuth(a);
        setSyncStatus(s);
        setNotifications(inbox);
      } catch { /* background only */ }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 20_000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [app, version]);

  // ── server push: polling fallback (docs/08 §5) ─────────────────────
  // The service worker handles Web Push while the tab is closed; while the tab is open we
  // pull whatever the queue still holds — on every foreground and every minute. A no-op when
  // signed out (no token) or offline (the queue retries on the next foreground).
  useEffect(() => {
    if (!app) return;
    let stop = false;
    const poll = async () => {
      try {
        const { shown } = await pollPendingNotifications(app);
        if (!stop && shown > 0) setVersion((v) => v + 1); // new inbox items → refresh UI
      } catch { /* offline or not signed in — retry on the next foreground */ }
    };
    void poll();
    window.addEventListener('focus', poll);
    const timer = window.setInterval(poll, 60_000);
    return () => { stop = true; window.removeEventListener('focus', poll); window.clearInterval(timer); };
  }, [app]);

  // ── FCM (Android shell, docs/08 §5 / docs/11 §8) ──────────────────────
  // The native half of push: register the device's FCM token with the server and pull the
  // queue the moment a message arrives in the foreground. The shell module (and the
  // Capacitor plugins inside it) is loaded only inside the Android webview.
  const onFcmArrival = useCallback(async () => {
    try {
      if (!app) return;
      const { shown } = await pollPendingNotifications(app);
      if (shown > 0) setVersion((v) => v + 1);
    } catch { /* offline — the 60s poll retries */ }
  }, [app]);

  useEffect(() => {
    const g = globalThis as Record<string, unknown>;
    if (!app || g.Capacitor === undefined) return;
    void import('../shells/fcm')
      .then((m) => m.initFcm(app, () => void onFcmArrival()))
      .catch(() => undefined);
  }, [app, auth?.authenticated, onFcmArrival]);

  const mutate = useCallback(async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | null> => {
    try {
      const result = await fn();
      setVersion((v) => v + 1);
      if (okText) toast(okText, 'ok');
      return result;
    } catch (error) {
      const message = error && typeof error === 'object' && 'userMessage' in error
        ? String((error as { userMessage: unknown }).userMessage)
        : error instanceof Error ? error.message : String(error);
      toast(message, 'error');
      return null;
    }
  }, [toast]);

  const hardReset = useCallback(async () => {
    await resetAppPromise();
    // wipe durable local storage so the next bootstrap starts clean
    try {
      const req = indexedDB.deleteDatabase('lifementor');
      req.onblocked = () => { /* ignore */ };
      req.onerror = () => { /* ignore */ };
      const breq = indexedDB.deleteDatabase('lifementor-backups');
      breq.onblocked = () => { /* ignore */ };
      breq.onerror = () => { /* ignore */ };
      sessionStorage.clear();
      localStorage.clear();
    } catch { /* ignore */ }
    setResetTick((t) => t + 1);
  }, []);

  const value = useMemo<AppState>(() => ({
    app, loading, loadError, version, refresh, toasts, toast, dismissToast, online, auth, syncStatus,
    notifications,
    unreadCount: notifications.filter((n) => !n.read_at).length,
    mutate, hardReset, serverUrl: SERVER_URL,
  }), [app, loading, loadError, version, refresh, toasts, toast, dismissToast, online, auth, syncStatus, notifications, mutate, hardReset]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  return useContext(Ctx);
}

/** Convenience: app is guaranteed loaded (Gate renders it only when ready). */
export function useLoadedApp(): LifeMentorApp {
  const { app } = useApp();
  if (!app) throw new Error('LifeMentorApp is not ready yet');
  return app;
}
