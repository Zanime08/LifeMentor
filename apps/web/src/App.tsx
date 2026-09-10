import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { LifeMentorApp } from '@lifementor/core';
import { AppProvider, useApp } from './state/store';
import { Btn, I, LoadFailure, Spinner, Toasts } from './components/ui';
import { userError } from './lib/errors';
import { todayKey } from './lib/ru';
import { bestEffort } from './lib/load';
/**
 * Screens load on demand (phase-20 perf).
 *
 * Everything used to be one 820 kB script: the packaged Windows/Android clients had to parse and
 * compile all sixteen screens (Settings alone is 800 lines) before the first pixel of the dashboard
 * appeared. Each screen is now its own chunk, fetched when its route is opened — the person who
 * opens «Сегодня» never downloads the Settings form, and the shell (sidebar, top bar, «Открываю
 * вашу базу…») is visible immediately.
 *
 * The first-run path matters most: onboarding arrives as its own chunk instead of riding along with
 * the whole product. In the shells (Tauri, Capacitor) every chunk ships inside the application, so
 * "loading" stays a local file read.
 */
const AuthScreen = lazy(() => import('./screens/Auth').then((m) => ({ default: m.AuthScreen })));
const Onboarding = lazy(() => import('./screens/Onboarding').then((m) => ({ default: m.Onboarding })));
const Dashboard = lazy(() => import('./screens/Dashboard').then((m) => ({ default: m.Dashboard })));
const Mentor = lazy(() => import('./screens/Mentor').then((m) => ({ default: m.Mentor })));
const Today = lazy(() => import('./screens/Today').then((m) => ({ default: m.Today })));
const CalendarScreen = lazy(() => import('./screens/Calendar').then((m) => ({ default: m.CalendarScreen })));
const Goals = lazy(() => import('./screens/Goals').then((m) => ({ default: m.Goals })));
const Learning = lazy(() => import('./screens/Learning').then((m) => ({ default: m.Learning })));
const Projects = lazy(() => import('./screens/Projects').then((m) => ({ default: m.Projects })));
const Skills = lazy(() => import('./screens/Skills').then((m) => ({ default: m.Skills })));
const Knowledge = lazy(() => import('./screens/Knowledge').then((m) => ({ default: m.Knowledge })));
const News = lazy(() => import('./screens/News').then((m) => ({ default: m.News })));
const ProgressScreen = lazy(() => import('./screens/Progress').then((m) => ({ default: m.ProgressScreen })));
const Strategy = lazy(() => import('./screens/Strategy').then((m) => ({ default: m.Strategy })));
const Profile = lazy(() => import('./screens/Profile').then((m) => ({ default: m.Profile })));
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })));

/**
 * A screen chunk that cannot be fetched (no network in the browser build, a damaged application file
 * in the packaged one) rejects the dynamic import, and React's answer to a rejected `lazy` is to
 * tear down the whole tree — a white page with no explanation, the worst failure mode this app can
 * have. The boundary turns it into a sentence and a button. Recovery is a reload on purpose: React
 * caches the rejection, so re-rendering the same lazy component would fail again.
 */
export class ScreenErrorBoundary extends React.Component<{ children: React.ReactNode; what?: string }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: unknown } { return { error }; }
  override componentDidCatch(error: unknown): void {
    console.error('[lifementor] screen crashed:', error);
  }
  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <LoadFailure
        what={this.props.what ?? 'экран'}
        message={userError(this.state.error)}
        onRetry={() => { if (typeof window !== 'undefined') window.location.reload(); }}
      />
    );
  }
}

/**
 * Waits for the route's chunk *inside* the shell's content area: the navigation, the sync state and
 * the bell stay usable while a screen arrives, and the user never sees the app blink to a full-page
 * spinner between two routes.
 */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <ScreenErrorBoundary>
      <Suspense fallback={<Spinner label="Открываю экран…" />}>{children}</Suspense>
    </ScreenErrorBoundary>
  );
}

const NAV: { to: string; label: string; icon: string }[] = [
  { to: '/dashboard', label: 'Главная', icon: I.dashboard },
  { to: '/mentor', label: 'Наставник', icon: I.mentor },
  { to: '/today', label: 'Сегодня', icon: I.today },
  { to: '/calendar', label: 'Календарь', icon: I.calendar },
  { to: '/goals', label: 'Цели', icon: I.goals },
  { to: '/learning', label: 'Обучение', icon: I.learning },
  { to: '/projects', label: 'Проекты', icon: I.projects },
  { to: '/skills', label: 'Навыки', icon: I.skills },
  { to: '/knowledge', label: 'Знания', icon: I.knowledge },
  { to: '/news', label: 'Новости', icon: I.news },
  { to: '/strategy', label: 'Стратегия', icon: I.knowledge },
  { to: '/progress', label: 'Прогресс', icon: I.progress },
  { to: '/profile', label: 'Профиль', icon: I.profile },
  { to: '/settings', label: 'Настройки', icon: I.settings },
];

const TITLES: Record<string, string> = {
  '/dashboard': 'Главная', '/mentor': 'Наставник', '/today': 'Сегодня', '/calendar': 'Календарь',
  '/goals': 'Цели', '/learning': 'Обучение', '/projects': 'Проекты', '/skills': 'Навыки',
  '/knowledge': 'Карта знаний', '/news': 'Новости', '/strategy': 'Стратегия', '/progress': 'Прогресс', '/profile': 'Мой профиль', '/settings': 'Настройки',
};

function useOnboardingDone(app: LifeMentorApp | null, version: number): boolean | null {
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    if (!app) return;
    let stop = false;
    app.services.settings.get('flags').then((f) => { if (!stop) setDone(f.onboarding_completed); }).catch(() => { if (!stop) setDone(true); });
    return () => { stop = true; };
  }, [app, version]);
  return done;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { app, online, auth, syncStatus, unreadCount, version } = useApp();
  const [inboxOpen, setInboxOpen] = useState(false);
  const done = useOnboardingDone(app, version);
  const navigate = useNavigate();
  const location = useLocation();

  // Remember where the user was (req. 13). One `app_state` row, written on navigation only, never
  // synced and never audited — it is device-local state, not data.
  useEffect(() => {
    if (!app || !TITLES[location.pathname]) return;
    bestEffort(app.services.recovery.setLastRoute(location.pathname), 'remember last screen');
  }, [app, location.pathname]);

  // Onboarding gate: until the user model is confirmed the app shows only the wizard.
  if (app && done === false && !location.pathname.startsWith('/onboarding') && !location.pathname.startsWith('/auth')) {
    return <Navigate to="/onboarding" replace />;
  }

  const title = TITLES[location.pathname] ?? 'LifeMentor';
  const syncPending = syncStatus ? (syncStatus.pending ?? 0) : 0;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LM</div>
          <div>
            <div className="brand-name">LifeMentor</div>
            <div className="brand-sub">личная ОС развития</div>
          </div>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-ico">{n.icon}</span>
            <span className="nav-label">{n.label}</span>
            {n.to === '/dashboard' && unreadCount > 0 && <span className="nav-badge">{unreadCount}</span>}
            {n.to === '/today' && syncPending > 0 && <span className="nav-badge soft">{syncPending}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <div><span className={`dot ${online ? 'ok' : 'warn'}`} /><span className="foot-text">{online ? 'Сеть: есть' : 'Офлайн-режим'}</span></div>
          <div style={{ marginTop: 4 }}><span className={`dot ${auth?.authenticated ? 'ok' : 'off'}`} /><span className="foot-text">{auth?.authenticated ? auth.email : 'Без аккаунта'}</span></div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="page-title">{title}</span>
          <div className="spacer" />
          {app?.ai.isOffline && <span className="tag gold" title="Облачный ИИ недоступен — работает встроенный движок">офлайн-ИИ</span>}
          {syncStatus && syncStatus.pending > 0 && <span className="tag p1">синхронизация: {syncStatus.pending} в очереди</span>}
          <div className="bell" style={{ position: 'relative' }}>
            <Btn kind="ghost" onClick={() => setInboxOpen((v) => !v)} aria-label="Уведомления">
              {I.bell}<span className="sr-only">Уведомления</span>
            </Btn>
            {unreadCount > 0 && <span className="bell-count">{unreadCount}</span>}
            {inboxOpen && <NotificationPopover onClose={() => setInboxOpen(false)} onOpenApp={() => navigate('/settings')} />}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      <Toasts />
    </div>
  );
}

function NotificationPopover({ onClose, onOpenApp }: { onClose: () => void; onOpenApp: () => void }) {
  const { app, notifications, mutate } = useApp();
  return (
    <div className="popover">
      <div className="row" style={{ padding: '6px 10px 10px' }}>
        <b className="small">Уведомления</b>
        <div style={{ flex: 1 }} />
        <Btn kind="ghost" size="xs" onClick={onClose} aria-label="Закрыть">{I.x}</Btn>
      </div>
      {notifications.length === 0 && <div className="small muted" style={{ padding: '14px 10px' }}>Пока тихо. Уведомления появляются, когда есть что сообщить — без спама.</div>}
      {notifications.slice(0, 12).map((n) => (
        <div key={n.id} className={`pop-item ${n.read_at ? '' : 'unread'}`}>
          <div className="row" style={{ gap: 8 }}>
            <div className="grow">
              <b>{n.title}</b>
              <div className="muted xsmall">{new Date(n.scheduled_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              <div className="small mt-sm">{n.body}</div>
            </div>
            {!n.read_at && app && (
              <Btn kind="ghost" size="xs" onClick={() => void mutate(() => app.services.notifications.markRead(n.id))}>✓</Btn>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { app, loading, loadError, hardReset, toast } = useApp();
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="brand-mark" style={{ width: 46, height: 46, fontSize: 18 }}>LM</div>
        <div className="row" style={{ gap: 10 }}><span className="spin" /><span className="muted small">Открываю вашу базу…</span></div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="loading-screen" style={{ textAlign: 'center', maxWidth: 460 }}>
        <h2>Не удалось запустить локальную базу</h2>
        <p className="muted small mt-sm">{loadError}</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <Btn kind="primary" onClick={() => void hardReset().then(() => toast('Локальная база сброшена — пробую снова', 'warn'))}>Сбросить и повторить</Btn>
        </div>
      </div>
    );
  }
  if (!app) return null;
  return <>{children}</>;
}

/**
 * The `/` route (req. 13): an unfinished onboarding always wins, otherwise the app returns to the
 * screen the user was last on instead of dumping them on the dashboard every launch.
 */
function StartRoute({ done }: { done: boolean | null }) {
  const { app } = useApp();
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (done === null) return; // still reading the flags row
    if (done === false || !app) { setTarget('/onboarding'); return; }
    let stop = false;
    app.services.recovery.lastRoute()
      .then((route) => { if (!stop) setTarget(route && TITLES[route] ? route : '/dashboard'); })
      .catch(() => { if (!stop) setTarget('/dashboard'); });
    return () => { stop = true; };
  }, [app, done]);
  if (!target) {
    return (
      <div className="loading-screen">
        <div className="brand-mark" style={{ width: 46, height: 46, fontSize: 18 }}>LM</div>
        <div className="row" style={{ gap: 10 }}><span className="spin" /><span className="muted small">Открываю вашу базу…</span></div>
      </div>
    );
  }
  return <Navigate to={target} replace />;
}

function Router() {
  const { app } = useApp();
  const done = useOnboardingDone(app, 0);
  return (
    <Gate>
      {/* Backstop: a crash in the shell itself must not leave a white page either. */}
      <ScreenErrorBoundary what="приложение">
      <Routes>
        <Route path="/" element={<StartRoute done={done} />} />
        <Route path="/auth" element={<Screen><AuthScreen /></Screen>} />
        <Route path="/onboarding" element={<Screen><Onboarding /></Screen>} />
        <Route path="/dashboard" element={<Shell><Screen><Dashboard /></Screen></Shell>} />
        <Route path="/mentor" element={<Shell><Screen><Mentor /></Screen></Shell>} />
        <Route path="/today" element={<Shell><Screen><Today /></Screen></Shell>} />
        <Route path="/calendar" element={<Shell><Screen><CalendarScreen /></Screen></Shell>} />
        <Route path="/goals" element={<Shell><Screen><Goals /></Screen></Shell>} />
        <Route path="/learning" element={<Shell><Screen><Learning /></Screen></Shell>} />
        <Route path="/projects" element={<Shell><Screen><Projects /></Screen></Shell>} />
        <Route path="/skills" element={<Shell><Screen><Skills /></Screen></Shell>} />
        <Route path="/knowledge" element={<Shell><Screen><Knowledge /></Screen></Shell>} />
        <Route path="/news" element={<Shell><Screen><News /></Screen></Shell>} />
        <Route path="/progress" element={<Shell><Screen><ProgressScreen /></Screen></Shell>} />
        <Route path="/strategy" element={<Shell><Screen><Strategy /></Screen></Shell>} />
        <Route path="/profile" element={<Shell><Screen><Profile /></Screen></Shell>} />
        <Route path="/settings" element={<Shell><Screen><Settings /></Screen></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </ScreenErrorBoundary>
    </Gate>
  );
}

export default function App() {
  return (
    <AppProvider>
      <HashRouter>
        <Router />
      </HashRouter>
    </AppProvider>
  );
}

export function TodayKey() { return todayKey(); }
