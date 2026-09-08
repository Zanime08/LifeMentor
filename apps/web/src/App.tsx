import React, { useEffect, useMemo, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { LifeMentorApp } from '@lifementor/core';
import { AppProvider, useApp } from './state/store';
import { Btn, I, Toasts } from './components/ui';
import { todayKey } from './lib/ru';
import { AuthScreen } from './screens/Auth';
import { Onboarding } from './screens/Onboarding';
import { Dashboard } from './screens/Dashboard';
import { Mentor } from './screens/Mentor';
import { Today } from './screens/Today';
import { CalendarScreen } from './screens/Calendar';
import { Goals } from './screens/Goals';
import { Learning } from './screens/Learning';
import { Projects } from './screens/Projects';
import { Skills } from './screens/Skills';
import { Knowledge } from './screens/Knowledge';
import { News } from './screens/News';
import { ProgressScreen } from './screens/Progress';
import { Profile } from './screens/Profile';
import { Settings } from './screens/Settings';

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
  { to: '/progress', label: 'Прогресс', icon: I.progress },
  { to: '/profile', label: 'Профиль', icon: I.profile },
  { to: '/settings', label: 'Настройки', icon: I.settings },
];

const TITLES: Record<string, string> = {
  '/dashboard': 'Главная', '/mentor': 'Наставник', '/today': 'Сегодня', '/calendar': 'Календарь',
  '/goals': 'Цели', '/learning': 'Обучение', '/projects': 'Проекты', '/skills': 'Навыки',
  '/knowledge': 'Карта знаний', '/news': 'Новости', '/progress': 'Прогресс', '/profile': 'Мой профиль', '/settings': 'Настройки',
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
        <Btn kind="ghost" size="xs" onClick={onClose}>{I.x}</Btn>
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

function Router() {
  const { app } = useApp();
  const done = useOnboardingDone(app, 0);
  return (
    <Gate>
      <Routes>
        <Route path="/" element={<Navigate to={done === false ? '/onboarding' : '/dashboard'} replace />} />
        <Route path="/auth" element={<AuthScreen />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/dashboard" element={<Shell><Dashboard /></Shell>} />
        <Route path="/mentor" element={<Shell><Mentor /></Shell>} />
        <Route path="/today" element={<Shell><Today /></Shell>} />
        <Route path="/calendar" element={<Shell><CalendarScreen /></Shell>} />
        <Route path="/goals" element={<Shell><Goals /></Shell>} />
        <Route path="/learning" element={<Shell><Learning /></Shell>} />
        <Route path="/projects" element={<Shell><Projects /></Shell>} />
        <Route path="/skills" element={<Shell><Skills /></Shell>} />
        <Route path="/knowledge" element={<Shell><Knowledge /></Shell>} />
        <Route path="/news" element={<Shell><News /></Shell>} />
        <Route path="/progress" element={<Shell><ProgressScreen /></Shell>} />
        <Route path="/profile" element={<Shell><Profile /></Shell>} />
        <Route path="/settings" element={<Shell><Settings /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
