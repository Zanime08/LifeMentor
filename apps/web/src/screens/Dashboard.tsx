import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Briefing, DayPlan, Goal, Project, LearningPath, NewsItem, Skill } from '@lifementor/core';
import { Btn, Card, Empty, I, Progress, Spinner, Tag } from '../components/ui';
import { useApp } from '../state/store';
import { ENERGY_RU, HORizons_RU, fmtDayDow, fmtMinutes, hm, todayKey } from '../lib/ru';

interface DashData {
  briefing: Briefing | null;
  plan: DayPlan | null;
  nextTask: { title: string; taskId: string; priority: string } | null;
  nextEvent: { title: string; start: string; end: string } | null;
  mainGoal: Goal | null;
  projects: Project[];
  learning: LearningPath[];
  reviewsDue: number;
  news: NewsItem[];
  skill: Skill | null;
  streak: number;
  overdue: number;
  tasksToday: import('@lifementor/core').Task[];
}

export function Dashboard() {
  const { app, version } = useApp();
  const navigate = useNavigate();
  const [data, setData] = useState<DashData | null>(null);

  useEffect(() => {
    let stop = false;
    if (!app) return;
    const day = todayKey();
    (async () => {
      try {
        const [briefing, plan, nextEvent, goals, projects, learning, reviewsDue, news, streak, overdueTasks, tasksToday] = await Promise.all([
          app.ai.mentor.morningBriefing(day, { ai: false }),
          app.services.planner.buildDay(day),
          app.services.calendar.nextEvent(),
          app.services.goals.list({ status: 'active' }),
          app.services.projects.list({ status: ['active', 'idea'] }),
          app.services.learning.paths(),
          app.services.learning.reviewsDueCount(),
          app.services.news.urgent(3),
          app.services.progress.streak(),
          app.services.tasks.overdue(),
          app.services.tasks.listForDay(day),
        ]);
        const activeGoals = goals.filter((g) => g.status === 'active');
        const mainGoal = [...activeGoals].sort((a, b) => (b.progress - a.progress) || a.priority.localeCompare(b.priority))[0] ?? null;
        const current = tasksToday.find((t) => t.status === 'in_progress') ?? tasksToday.find((t) => t.status === 'scheduled' || t.status === 'todo');
        const skill = (await app.services.skills.list())[0] ?? null;
        if (stop) return;
        setData({
          briefing,
          plan,
          nextTask: current ? { title: current.title, taskId: current.id, priority: current.priority } : null,
          nextEvent: nextEvent ? { title: nextEvent.title, start: nextEvent.starts_at, end: nextEvent.ends_at } : null,
          mainGoal,
          projects: projects.slice(0, 3),
          learning: learning.filter((p) => p.status === 'active').slice(0, 3),
          reviewsDue,
          news,
          skill,
          streak,
          overdue: overdueTasks.length,
          tasksToday,
        });
      } catch (error) {
        console.error('dashboard load failed', error);
        if (!stop) setData(null);
      }
    })();
    return () => { stop = true; };
  }, [app, version]);

  if (!data) return <Spinner label="Собираю картину дня…" />;
  const donePct = Math.round(100 * data.tasksToday.filter((t) => t.status === 'done').length / Math.max(1, data.tasksToday.length));

  return (
    <div className="grid dash">
      <div className="stack">
        <Card>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h2>{greeting()}, {firstName()} 👋</h2>
              <div className="muted small">{fmtDayDow(todayKey())}</div>
            </div>
            <div className="row">
              {data.streak > 1 && <Tag tone="gold">🔥 {data.streak} дн. подряд</Tag>}
              {data.overdue > 0 && <Tag tone="p1">{data.overdue} просрочен(о)</Tag>}
            </div>
          </div>
          {data.briefing && (
            <div className="proactive mt">
              <b>Наставник:</b> {data.briefing.text}
            </div>
          )}
          <div className="row mt" style={{ gap: 8 }}>
            <Btn kind="primary" size="sm" onClick={() => navigate('/today')}>Мой день</Btn>
            <Btn size="sm" onClick={() => navigate('/mentor')}>Спросить наставника</Btn>
          </div>
        </Card>

        <Card title="Сегодня" sub={data.plan ? `Фокус ${fmtMinutes(data.plan.focus_minutes)} · свободно ${fmtMinutes(data.plan.free_minutes)} · обязательно ${fmtMinutes(data.plan.fixed_minutes)}` : undefined}
          action={<Tag tone={data.plan?.overload ? 'p1' : 'green'}>{data.plan?.overload ? 'план перегружен' : 'план сбалансирован'}</Tag>}>
          {!data.plan || data.plan.slots.length === 0 ? (
            <Empty icon={I.today} title="План на день ещё не построен" hint="Загляните на «Сегодня» — я соберу его по вашему расписанию." action={<Btn kind="primary" size="sm" onClick={() => navigate('/today')}>Построить план</Btn>} />
          ) : (
            <>
              <div className="mb-sm"><Progress value={donePct} thin /></div>
              {data.plan.slots.slice(0, 6).map((s, i) => (
                <div key={i} className="row small" style={{ padding: '5px 0', gap: 10 }}>
                  <span className="muted" style={{ width: 84, fontVariantNumeric: 'tabular-nums' }}>{s.start}–{s.end}</span>
                  <span className={`grow ${s.kind === 'task' ? 'font-medium' : 'muted'}`}>{s.title}</span>
                  {s.priority && <Tag tone={`p${s.priority.slice(1)}`}>{s.priority}</Tag>}
                  {s.energy && <span className="xsmall muted">{ENERGY_RU[s.energy]}</span>}
                </div>
              ))}
              {data.plan.deferred.length > 0 && (
                <div className="small muted mt-sm">Не вошло в день: {data.plan.deferred.map((d) => d.title).join(', ')}</div>
              )}
            </>
          )}
        </Card>

        <div className="grid cols-2">
          <Card title="Главная цель" sub={data.mainGoal ? HORizons_RU[data.mainGoal.horizon] : undefined}>
            {data.mainGoal ? (
              <>
                <div className="row" style={{ gap: 8 }}>
                  <span className="grow" style={{ fontWeight: 600 }}>{data.mainGoal.title}</span>
                  <Tag tone={`p${data.mainGoal.priority.slice(1)}`}>{data.mainGoal.priority}</Tag>
                </div>
                <div className="mt-sm"><Progress value={data.mainGoal.progress} /></div>
              </>
            ) : (
              <Empty icon={I.goals} title="Пока нет активных целей" hint="Создайте первую — всё остальное строится вокруг неё." action={<Btn size="sm" kind="primary" onClick={() => navigate('/goals')}>Цели</Btn>} />
            )}
          </Card>
          <Card title="Обучение" sub={data.reviewsDue > 0 ? `Повторений к выполнению: ${data.reviewsDue}` : undefined}>
            {data.learning.length ? data.learning.map((p) => (
              <div key={p.id} className="row" style={{ padding: '4px 0', gap: 8 }}>
                <span className="grow small" style={{ fontWeight: 560 }}>{p.title}</span>
                <span className="pct">{Math.round(p.progress)}%</span>
              </div>
            )) : (
              <Empty icon={I.learning} title="Пути обучения пусты" hint="Скажите наставнику «хочу изучить…» — он соберёт путь." />
            )}
          </Card>
        </div>
      </div>

      <div className="stack">
        <Card title="Сейчас делать">
          {data.nextTask ? (
            <div>
              <div className="row" style={{ gap: 8 }}>
                <span className="grow" style={{ fontWeight: 640 }}>{data.nextTask.title}</span>
                <Tag tone={`p${data.nextTask.priority.slice(1)}`}>{data.nextTask.priority}</Tag>
              </div>
              <Btn size="sm" className="mt-sm" onClick={() => navigate('/today')}>Открыть день</Btn>
            </div>
          ) : (
            <div className="small muted">На сегодня задач не назначено. {data.overdue > 0 ? 'Есть просроченные — пересоберите план.' : 'Хороший момент добавить что-то важное.'}</div>
          )}
          {data.nextEvent && (
            <div className="mt-sm">
              <div className="xsmall muted">Ближайшее событие</div>
              <div className="small" style={{ fontWeight: 600 }}>{data.nextEvent.title}</div>
              <div className="xsmall muted">{data.nextEvent.start && data.nextEvent.end ? `${hm(data.nextEvent.start)}–${hm(data.nextEvent.end)}` : data.nextEvent.start || 'весь день'}</div>
            </div>
          )}
        </Card>

        <Card title="Активные проекты">
          {data.projects.length ? data.projects.map((p) => (
            <div key={p.id} style={{ marginBottom: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="grow small" style={{ fontWeight: 600 }}>{p.title}</span>
                {p.deadline && <span className="xsmall muted">до {p.deadline}</span>}
              </div>
              <div className="bar thin" style={{ marginTop: 4 }}><span style={{ width: `${p.progress ?? 0}%` }} /></div>
            </div>
          )) : <div className="small muted">Пока нет проектов.</div>}
        </Card>

        <Card title="Важные новости" action={<Btn kind="ghost" size="xs" onClick={() => navigate('/news')}>Все →</Btn>}>
          {data.news.length ? data.news.map((n) => (
            <div key={n.id} className="row news-item" style={{ padding: '6px 0', gap: 8, cursor: 'pointer' }} onClick={() => navigate('/news')}>
              <Tag tone={n.urgency === 'urgent' ? 'p0' : 'outline'}>{n.urgency === 'urgent' ? 'срочно' : 'новость'}</Tag>
              <span className="grow small">{n.title}</span>
            </div>
          )) : <div className="small muted">Новостей пока нет — загрузите их в разделе «Новости».</div>}
        </Card>

        {data.skill && (
          <Card title="Навыки">
            <div className="row" style={{ gap: 8 }}>
              <span className="grow small" style={{ fontWeight: 600 }}>{data.skill.name}</span>
              <Tag tone="green">{data.skill.level}/100</Tag>
            </div>
            <div className="bar thin" style={{ marginTop: 6 }}><span style={{ width: `${data.skill.level}%` }} /></div>
          </Card>
        )}
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function firstName(): string {
  try {
    return localStorage.getItem('lifementor.name') ?? 'друг';
  } catch { return 'друг'; }
}
