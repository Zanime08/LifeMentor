import React, { useEffect, useState } from 'react';
import type { DailySnapshot, DayMetrics, WeeklyReview } from '@lifementor/core';
import { Btn, Card, Empty, PageHead, Spinner, Tag, BarChart } from '../components/ui';
import { useApp } from '../state/store';
import { fmtDay, fmtDayShort, fmtMinutes, timeAgo } from '../lib/ru';

export function ProgressScreen() {
  const { app, version, mutate, toast, toastError } = useApp();
  const [series, setSeries] = useState<DayMetrics[] | null>(null);
  const [streak, setStreak] = useState(0);
  const [achievements, setAchievements] = useState<import('@lifementor/core').Achievement[]>([]);
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([]);
  const [weekly, setWeekly] = useState<WeeklyReview[]>([]);
  const [openSnap, setOpenSnap] = useState<DailySnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    (async () => {
      try {
        const [s, st, a, sn, w] = await Promise.all([
          app.services.progress.series(14),
          app.services.progress.streak(),
          app.services.progress.achievements(),
          app.services.snapshots.list(30),
          app.services.weeklyReviews.latest(8),
        ]);
        if (!stop) { setSeries(s); setStreak(st); setAchievements(a); setSnapshots(sn); setWeekly(w); }
      } catch (e) { console.error(e); }
    })();
    return () => { stop = true; };
  }, [app, version]);

  if (!series) return <Spinner label="Считаю прогресс…" />;

  const chartData = series.map((d) => ({ label: d.day.slice(8), value: d.tasks_completed, value2: d.planned_minutes > 0 ? Math.min(100, d.completion_rate) : 0 }));

  const runWeekly = async () => {
    if (!app) return;
    setBusy('weekly');
    try {
      const review = await app.services.weeklyReviews.create();
      toast('Еженедельный разбор готов: что вышло, что тормозило, что делать дальше.', 'ok');
      setWeekly((w) => [review, ...w]);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  const runSnapshot = async () => {
    if (!app) return;
    setBusy('snapshot');
    try {
      const r = await app.services.snapshots.ensureUpToDate();
      toast(r.skipped ? 'Снепшот на сегодня уже создан.' : 'Снепшот дня создан (автоматически создаётся и в конце дня).', 'ok');
      setSnapshots(await app.services.snapshots.list(30));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHead title="Прогресс" sub="Метрики, снепшоты дней и разборы. Без бессмысленных XP — только то, что можно проверить."
        actions={
          <>
            <Btn size="sm" onClick={() => void runSnapshot()} disabled={busy !== null}>{busy === 'snapshot' ? 'Создаю…' : 'Снепшот дня'}</Btn>
            <Btn kind="primary" size="sm" onClick={() => void runWeekly()} disabled={busy !== null}>{busy === 'weekly' ? 'Считаю…' : 'Еженедельный разбор'}</Btn>
          </>
        } />

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', alignItems: 'start' }}>
        <div className="stack">
          <div className="grid cols-3">
            <Card><h2 style={{ fontSize: 26 }}>{streak}</h2><div className="card-sub">дней подряд с выполненной задачей</div></Card>
            <Card><h2 style={{ fontSize: 26 }}>{series.reduce((a, d) => a + d.tasks_completed, 0)}</h2><div className="card-sub">задач за 14 дней</div></Card>
            <Card><h2 style={{ fontSize: 26 }}>{fmtMinutes(series.reduce((a, d) => a + d.focus_minutes, 0))}</h2><div className="card-sub">времени фокуса за 14 дней</div></Card>
          </div>

          <Card title="Выполнение задач (14 дней)" sub="Зелёное — выполнено; серое — % выполнения плана">
            <BarChart data={chartData} height={130} alt="выполнение задач по дням" />
          </Card>

          <Card title="Еженедельные разборы" sub="Искать закономерности, а не пересказывать статистику">
            {weekly.length === 0 && <div className="small muted">Ещё не было разборов. Нажмите «Еженедельный разбор».</div>}
            {weekly.map((w) => (
              <div key={w.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="li-main">
                  <div className="li-title">Неделя с {fmtDay(w.week_start)}</div>
                  <div className="li-sub">создан {timeAgo(w.created_at)}</div>
                  {w.went_well && <div className="small mt-sm"><b>Вышло:</b> {w.went_well}</div>}
                  {w.went_wrong && <div className="small"><b>Не вышло:</b> {w.went_wrong}</div>}
                  {w.blockers && <div className="small"><b>Тормозит:</b> {w.blockers}</div>}
                  {w.next_week && <div className="small"><b>Следующая неделя:</b> {w.next_week}</div>}
                </div>
              </div>
            ))}
          </Card>
        </div>

        <div className="stack">
          <Card title="Достижения" sub="За конкретные повторяемые паттерны, не за активность как таковую">
            {achievements.length === 0 && <div className="small muted">Пока нет. Достижения появляются за серии, вехи и стабильность.</div>}
            {achievements.map((a) => (
              <div key={a.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
                <Tag tone="gold">🏆</Tag>
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>{a.title}</div>
                  <div className="xsmall muted">{a.detail}</div>
                </div>
              </div>
            ))}
          </Card>

          <Card title="Снепшоты дней" sub="Автоматический срез: что сделано, что перенесено, что изменилось"
            action={<Btn kind="ghost" size="xs" onClick={() => void runSnapshot()} disabled={busy !== null}>+ сейчас</Btn>}>
            {snapshots.length === 0 && <Empty icon={I0} title="Снепшотов пока нет" hint="Первый создастся сегодня автоматически в конце дня — или по кнопке выше." />}
            {snapshots.map((s) => (
              <div key={s.id} className="row" style={{ gap: 10, padding: '6px 0', cursor: 'pointer' }} onClick={() => setOpenSnap(s)}>
                <span className="grow small" style={{ fontWeight: 600 }}>{fmtDay(s.day)}</span>
                <span className="xsmall muted">{s.summary ? s.summary.slice(0, 60) : '—'}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>

      {openSnap && <SnapshotDetail snapshot={openSnap} onClose={() => setOpenSnap(null)} />}
    </div>
  );
}

const I0 = '◧';

function SnapshotDetail({ snapshot, onClose }: { snapshot: DailySnapshot; onClose: () => void }) {
  const parse = (raw: string | null) => {
    if (!raw) return null;
    try { return JSON.parse(raw) as unknown; } catch { return null; }
  };
  const completed = parse(snapshot.completed_json) as { title: string }[] | null;
  const pending = parse(snapshot.pending_json) as { title: string }[] | null;
  const metrics = parse(snapshot.metrics_json) as Record<string, number> | null;
  const achievements = parse(snapshot.achievements_json) as { title: string }[] | null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>Снепшот · {fmtDay(snapshot.day)}</h3>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {snapshot.summary && <p className="small mb-sm">{snapshot.summary}</p>}
          {metrics && (
            <div className="row wrap mb-sm" style={{ gap: 8 }}>
              <Tag tone="green">выполнено: {metrics.tasks_completed ?? 0}</Tag>
              <Tag tone="p1">перенесено: {metrics.tasks_postponed ?? 0}</Tag>
              <Tag tone="outline">фокус: {fmtMinutes(metrics.focus_minutes ?? 0)}</Tag>
              {metrics.completion_rate != null && <Tag tone="violet">план: {Math.round(metrics.completion_rate)}%</Tag>}
            </div>
          )}
          {completed && completed.length > 0 && (
            <div className="mb-sm">
              <div className="xsmall" style={{ fontWeight: 700, color: 'var(--ink-3)' }}>СДЕЛАНО</div>
              {completed.map((t, i) => <div key={i} className="small">✓ {t.title}</div>)}
            </div>
          )}
          {pending && pending.length > 0 && (
            <div className="mb-sm">
              <div className="xsmall" style={{ fontWeight: 700, color: 'var(--ink-3)' }}>ОСТАЛОСЬ</div>
              {pending.map((t, i) => <div key={i} className="small muted">• {t.title}</div>)}
            </div>
          )}
          {achievements && achievements.length > 0 && (
            <div>
              <div className="xsmall" style={{ fontWeight: 700, color: 'var(--ink-3)' }}>ДОСТИЖЕНИЯ ДНЯ</div>
              {achievements.map((a, i) => <div key={i} className="small">🏆 {a.title}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
