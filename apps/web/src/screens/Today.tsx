import React, { useEffect, useMemo, useState } from 'react';
import type { CalendarEvent, DayPlan, PlannedSlot, Task } from '@lifementor/core';
import { Btn, Card, Empty, Field, I, Modal, PageHead, Seg, Select, Spinner, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { ENERGY_RU, KIND_RU, PRIORITY_RU, REASON_RU, SKIP_REASONS, fmtMinutes, hm, todayKey } from '../lib/ru';

export function Today() {
  const { app, mutate, toast, toastError, refresh } = useApp();
  const day = todayKey();
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [style, setStyle] = useState<'strict' | 'balanced' | 'flexible'>('balanced');
  const [loading, setLoading] = useState(true);
  const [taskModal, setTaskModal] = useState(false);
  const [postponeFor, setPostponeFor] = useState<Task | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const load = async () => {
    if (!app) return;
    try {
      const [p, ev, tk, settings] = await Promise.all([
        app.services.planner.lastPlan(),
        app.services.calendar.listDay(day),
        app.services.tasks.listForDay(day),
        app.services.settings.get('planning'),
      ]);
      const current = p && p.day === day ? p : null;
      setPlan(current);
      setEvents(ev);
      setTasks(tk);
      setStyle(settings.style);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app]);
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const buildPlan = async () => {
    if (!app) return;
    setRebuilding(true);
    try {
      const p = await app.services.planner.buildDay(day);
      await app.services.planner.persist(p, day);
      try { await app.services.notifications.scheduleFromPlan(p); } catch { /* non-fatal */ }
      setPlan(p);
      await load();
      if (p.overload) toast('Внимание: день перегружен — часть задач перенесена. Смотрите список ниже.', 'warn');
      else toast('План дня построен.', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setRebuilding(false);
    }
  };

  const rebuild = async () => {
    if (!app) return;
    setRebuilding(true);
    try {
      const p = await app.services.planner.rebuildRemainingDay();
      await app.services.planner.persist(p, day);
      setPlan(p);
      await load();
      toast('Остаток дня пересобран: обязательства — прежде всего.', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setRebuilding(false);
    }
  };

  const completeTask = async (t: Task) => {
    const r = await mutate(() => app!.services.tasks.complete(t.id), 'Задача выполнена ✓');
    if (r) {
      // keep the plan slot in sync (mark done visually)
      refresh();
      void load();
    }
  };

  const taskStatus = (taskId?: string): Task | undefined => tasks.find((t) => t.id === taskId);

  const timeline = useMemo(() => {
    if (!plan) return [];
    return [...plan.slots].sort((a, b) => a.start.localeCompare(b.start));
  }, [plan]);

  if (loading) return <Spinner label="Загружаю день…" />;

  const doneCount = tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="content narrow" style={{ padding: 0 }}>
      <PageHead
        title="Сегодня"
        sub={plan
          ? <>Фокус {fmtMinutes(plan.focus_minutes)} · Свободно {fmtMinutes(plan.free_minutes)} · Обязательное {fmtMinutes(plan.fixed_minutes)}{plan.overload && ' · день перегружен'}</>
          : 'План пока не построен'}
        actions={
          <>
            <Btn size="sm" onClick={() => setTaskModal(true)}>{I.plus} Задача</Btn>
            {plan && <Btn size="sm" onClick={() => void rebuild()} disabled={rebuilding}>↻ Пересобрать остаток</Btn>}
            <Btn kind="primary" size="sm" onClick={() => void buildPlan()} disabled={rebuilding}>{rebuilding ? 'Строю…' : 'Построить план'}</Btn>
          </>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        {plan && plan.warnings.length > 0 && (
          <div className="proactive" style={{ background: 'var(--warn-soft)', borderColor: '#e8d5ae' }}>
            {plan.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}

        <Card>
          {timeline.length === 0 ? (
            <Empty icon={I.today} title="День пуст"
              hint="Добавьте обязательные события (учёба, работа, дорога) в календаре — или я соберу план из ваших задач."
              action={<Btn kind="primary" size="sm" onClick={() => void buildPlan()}>Построить план</Btn>} />
          ) : (
            <>
              <div className="row mb-sm" style={{ justifyContent: 'space-between' }}>
                <span className="small muted">{tasks.length > 0 ? `${doneCount} из ${tasks.length} задач выполнено` : 'Задач на сегодня нет'}</span>
                <Seg value={style} onChange={(v) => void mutate(() => app!.services.settings.set('planning', { style: v }), `Режим: ${v === 'strict' ? 'строгий' : v === 'balanced' ? 'сбалансированный' : 'гибкий'}`)}
                  options={[{ id: 'strict', label: 'Строгий' }, { id: 'balanced', label: 'Сбаланс.' }, { id: 'flexible', label: 'Гибкий' }]} />
              </div>
              <div className="timeline">
                {timeline.map((slot, i) => (
                  <SlotView key={i} slot={slot} task={taskStatus(slot.taskId)}
                    onDone={(t) => void completeTask(t)}
                    onPostpone={(t) => {
                      const important = style === 'strict' && (t.strict === 1 || t.priority === 'P0' || t.priority === 'P1');
                      if (important) setPostponeFor(t);
                      else void doPostpone(t, null);
                    }}
                  />
                ))}
              </div>
              {plan!.deferred.length > 0 && (
                <div className="mt">
                  <div className="section-title">Не вошло в день</div>
                  {plan!.deferred.map((d) => (
                    <div key={d.task_id} className="row small" style={{ gap: 8, padding: '4px 0' }}>
                      <Tag tone="p1">не влезло</Tag>
                      <span className="grow">{d.title}</span>
                      <span className="muted xsmall">{d.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>

        {events.length > 0 && (
          <Card title="Обязательные события" sub="Они никуда не сдвигаются — план строится вокруг них">
            {events.map((e) => (
              <div key={e.id} className="row" style={{ padding: '5px 0', gap: 10 }}>
                <span className="muted small" style={{ width: 100, fontVariantNumeric: 'tabular-nums' }}>
                  {e.all_day ? 'весь день' : `${hm(e.starts_at)}–${hm(e.ends_at)}`}
                </span>
                <span className="grow small" style={{ fontWeight: 560 }}>{e.title}</span>
                <Tag tone={e.priority === 'critical' ? 'p0' : e.priority === 'flexible' ? 'p3' : 'p2'}>{KIND_RU[e.kind] ?? e.kind}</Tag>
              </div>
            ))}
          </Card>
        )}

        <Card title="Все задачи на день">
          {tasks.length === 0 && <div className="small muted">Пусто. Добавьте задачу или постройте план.</div>}
          {tasks.map((t) => (
            <div key={t.id} className="row" style={{ padding: '6px 0', gap: 10, alignItems: 'center' }}>
              <input type="checkbox" checked={t.status === 'done'} onChange={() => t.status === 'done' ? void mutate(() => app!.services.tasks.reopen(t.id)) : void completeTask(t)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
              <span className={`grow small ${t.status === 'done' ? 'muted' : ''}`} style={{ textDecoration: t.status === 'done' ? 'line-through' : undefined }}>
                {t.scheduled_start ? <span className="muted">{hm(t.scheduled_start)} · </span> : null}{t.title}
              </span>
              <Tag tone={`p${t.priority.slice(1)}`}>{t.priority}</Tag>
              <span className="xsmall muted">{fmtMinutes(t.estimated_minutes)}</span>
              {t.status !== 'done' && <Btn kind="ghost" size="xs" onClick={() => (style === 'strict' && (t.strict === 1 || t.priority === 'P0' || t.priority === 'P1') ? setPostponeFor(t) : void doPostpone(t, null))}>→</Btn>}
            </div>
          ))}
        </Card>
      </div>

      {taskModal && <TaskForm onClose={() => setTaskModal(false)} onSaved={() => { setTaskModal(false); void load(); }} day={day} />}
      {postponeFor && (
        <PostponeDialog task={postponeFor} style={style}
          onClose={() => setPostponeFor(null)}
          onPostpone={(reason) => void doPostpone(postponeFor, reason).then(() => setPostponeFor(null))} />
      )}
    </div>
  );

  async function doPostpone(t: Task, reason: string | null) {
    if (!app) return;
    try {
      const r = await app.services.tasks.postpone(t.id, { reason: (reason as never) ?? null });
      if (r.mentor_message) toast(r.mentor_message, 'warn');
      if (r.minimal_version) toast(`Минимальная версия создана: «${r.minimal_version.title}» (${r.minimal_version.estimated_minutes} мин)`, 'info');
      await load();
      refresh();
    } catch (e) {
      toastError(e);
    }
  }
}

function SlotView({ slot, task, onDone, onPostpone }: { slot: PlannedSlot; task?: Task; onDone: (t: Task) => void; onPostpone: (t: Task) => void }) {
  const done = task?.status === 'done';
  const status = task?.status;
  return (
    <div className={`tl-item ${slot.kind} ${done ? 'done' : ''}`}>
      <div className="tl-time">{slot.start}{slot.end !== slot.start ? `–${slot.end}` : ''}</div>
      <div className="tl-title">
        {slot.kind === 'task' && task && (
          <input type="checkbox" checked={!!done} onChange={() => onDone(task)} style={{ accentColor: 'var(--accent)', width: 15, height: 15, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1 }}>{slot.title}</span>
        <div className="tl-actions">
          {slot.priority && <Tag tone={`p${slot.priority.slice(1)}`}>{slot.priority}</Tag>}
          {slot.energy && <span className="xsmall muted">{ENERGY_RU[slot.energy]}</span>}
          {slot.kind === 'task' && task && !done && (
            <>
              {status === 'todo' || status === 'scheduled' ? (
                <Btn kind="ghost" size="xs" onClick={() => void onPostpone(task)} title="Перенести">→</Btn>
              ) : null}
            </>
          )}
        </div>
      </div>
      {slot.note && <div className="tl-meta">{slot.note}</div>}
      {task && task.postponed_count > 0 && <div className="tl-meta">переносов: {task.postponed_count}</div>}
    </div>
  );
}

function TaskForm({ onClose, onSaved, day }: { onClose: () => void; onSaved: () => void; day: string }) {
  const { app, mutate, toast, toastError } = useApp();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [minutes, setMinutes] = useState(30);
  const [energy, setEnergy] = useState<'low' | 'medium' | 'high'>('medium');
  const [date, setDate] = useState(day);
  const [kind, setKind] = useState<'generic' | 'learning' | 'practice' | 'project' | 'health' | 'errand' | 'work' | 'review'>('generic');
  const [notes, setNotes] = useState('');
  const [strict, setStrict] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!app || !title.trim()) return;
    setBusy(true);
    try {
      await app.services.tasks.create({
        title: title.trim(), kind, priority, energy, estimated_minutes: minutes,
        scheduled_date: date, strict, notes: notes || null,
      });
      toast('Задача создана и сразу сохранена.', 'ok');
      onSaved();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Новая задача" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void save()} disabled={busy || !title.trim()}>Создать</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать" autoFocus /></Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Приоритет" optional>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as never)} style={{ width: 150 }}>
            <option value="P0">P0 — критично</option><option value="P1">P1 — высокий</option>
            <option value="P2">P2 — средний</option><option value="P3">P3 — низкий</option>
          </Select>
        </Field>
        <Field label="Время" optional>
          <TextInput type="number" min={5} max={480} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 5)} style={{ width: 110 }} />
        </Field>
        <Field label="Энергия" optional>
          <Select value={energy} onChange={(e) => setEnergy(e.target.value as never)} style={{ width: 130 }}>
            <option value="low">лёгкая</option><option value="medium">средняя</option><option value="high">нагрузочная</option>
          </Select>
        </Field>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Дата" optional>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} />
        </Field>
        <Field label="Тип" optional>
          <Select value={kind} onChange={(e) => setKind(e.target.value as never)} style={{ width: 140 }}>
            <option value="generic">обычная</option><option value="learning">обучение</option><option value="practice">практика</option>
            <option value="project">проект</option><option value="health">здоровье</option><option value="errand">бытовое</option>
            <option value="work">работа</option><option value="review">повторение</option>
          </Select>
        </Field>
      </div>
      <Field label="Заметка" optional><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <label className="checkbox"><input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Важная задача — наставник спросит причину, если я её пропущу</label>
    </Modal>
  );
}

function PostponeDialog({ task, style, onClose, onPostpone }: { task: Task; style: string; onClose: () => void; onPostpone: (reason: string | null) => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const strictMode = style === 'strict';
  return (
    <Modal title={strictMode ? `Пропустить «${task.title}»?` : 'Перенести задачу'} onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="danger" onClick={() => onPostpone(reason)} disabled={strictMode && !reason}>
          {strictMode && !reason ? 'Выберите причину' : 'Перенести'}
        </Btn>
      </>
    }>
      {strictMode && (
        <p className="small muted mb-sm">
          В строгом режиме пропуск важной задачи требует причины. Если это просто прокрастинация —
          наставник предложит минимальную версию, которую реально сделать.
        </p>
      )}
      <div className="field" style={{ marginBottom: 8 }}>
        <label>Причина</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {SKIP_REASONS.map((r) => (
            <button key={r} type="button" className={`q-option ${reason === r ? 'sel' : ''}`} style={{ margin: 0, padding: '7px 11px' }} onClick={() => setReason(r)}>
              {REASON_RU[r]}
            </button>
          ))}
        </div>
      </div>
      <Field label="Комментарий" optional><TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Необязательно" /></Field>
    </Modal>
  );
}
