import React, { useEffect, useMemo, useState } from 'react';
import type { CalendarEvent, EventKind } from '@lifementor/core';
import { Btn, Confirm, Empty, Field, I, Modal, PageHead, Select, Spinner, Tag, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { KIND_RU, fmtDayDow, hm, todayKey } from '../lib/ru';

export function CalendarScreen() {
  const { app, mutate, refresh, toastError } = useApp();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState(todayKey());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [monthEvents, setMonthEvents] = useState<CalendarEvent[]>([]);
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);

  const monthKey = `${cursor.y}-${String(cursor.m + 1).padStart(2, '0')}`;

  const load = async () => {
    if (!app) return;
    try {
      const first = dayOfMonth(cursor.y, cursor.m, 1);
      const last = dayOfMonth(cursor.y, cursor.m, daysInMonth(cursor.y, cursor.m));
      const [ev, me] = await Promise.all([
        app.services.calendar.listDay(selected),
        app.services.calendar.listRange(first, last),
      ]);
      setEvents(ev);
      setMonthEvents(me);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app, selected, monthKey]);

  const cells = useMemo(() => {
    const firstDow = (new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7; // Monday-first
    const startDay = 1 - firstDow;
    const out: { day: string; other: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(cursor.y, cursor.m, startDay + i);
      out.push({ day: dayOfMonth(d.getFullYear(), d.getMonth(), d.getDate()), other: d.getMonth() !== cursor.m });
    }
    return out;
  }, [cursor]);

  if (loading) return <Spinner label="Загружаю календарь…" />;
  const today = todayKey();

  return (
    <div className="content wide" style={{ padding: 0 }}>
      <PageHead title="Календарь" sub="Реальные события имеют приоритет: план никогда не ставится поверх экзамена или работы."
        actions={<Btn kind="primary" size="sm" onClick={() => setEditing('new')}>{I.plus} Событие</Btn>} />

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', alignItems: 'start' }}>
        <div className="card">
          <div className="row mb-sm" style={{ justifyContent: 'space-between' }}>
            <h2>{monthTitle(cursor.y, cursor.m)}</h2>
            <div className="row">
              <Btn kind="ghost" size="sm" onClick={() => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))}>←</Btn>
              <Btn kind="ghost" size="sm" onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); setSelected(today); }}>Сегодня</Btn>
              <Btn kind="ghost" size="sm" onClick={() => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))}>→</Btn>
            </div>
          </div>
          <div className="cal-grid">
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => <div key={d} className="cal-dow">{d}</div>)}
            {cells.map((c, i) => {
              const dayEvents = monthEvents.filter((e) => e.day_key === c.day);
              return (
                <div key={i} className={`cal-cell ${c.other ? 'other' : ''} ${c.day === today ? 'today' : ''} ${c.day === selected ? 'today' : ''}`}
                  onClick={() => setSelected(c.day)}>
                  <div className="cal-num">{Number(c.day.slice(8))}</div>
                  <div className="cal-dots">
                    {dayEvents.slice(0, 4).map((e) => (
                      <span key={e.id} className={`cal-dot ${e.all_day ? 'ev' : 'tl'}`} title={e.title} />
                    ))}
                    {dayEvents.length > 4 && <span className="xsmall muted">+{dayEvents.length - 4}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <h3>{fmtDayDow(selected)}</h3>
          {events.length === 0 ? (
            <div className="mt-sm">
              <Empty icon={I.calendar} title="Событий нет"
                hint="Добавьте колледж, работу, дорогу, тренировки — планировщик учитывает их как жёсткие блоки."
                action={<Btn kind="primary" size="sm" onClick={() => setEditing('new')}>Добавить событие</Btn>} />
            </div>
          ) : (
            <div className="mt-sm">
              {events.map((e) => (
                <div key={e.id} className="list-item" style={{ alignItems: 'center' }}>
                  <div className="li-main">
                    <div className="li-title">{e.title}</div>
                    <div className="li-sub">
                      {e.all_day ? 'весь день' : `${hm(e.starts_at)}–${hm(e.ends_at)}`} · {KIND_RU[e.kind] ?? e.kind}
                      {e.location ? ` · ${e.location}` : ''}
                    </div>
                  </div>
                  <div className="li-side">
                    <Tag tone={e.priority === 'critical' ? 'p0' : e.priority === 'flexible' ? 'p3' : 'p2'}>
                      {e.priority === 'critical' ? 'жестко' : e.priority === 'flexible' ? 'гибко' : 'норм'}
                    </Tag>
                    <div className="row">
                      <Btn kind="ghost" size="xs" onClick={() => setEditing(e)}>{I.edit}</Btn>
                      <Btn kind="ghost" size="xs" onClick={() => setDeleting(e)}>{I.trash}</Btn>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editing && (
        <EventForm
          day={selected}
          event={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); refresh(); }}
        />
      )}
      {deleting && (
        <Confirm title="Удалить событие?" text={`«${deleting.title}» будет удалено из календаря.`}
          onConfirm={() => void mutate(() => app!.services.calendar.remove(deleting.id), 'Событие удалено').then(() => { void load(); refresh(); })}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function EventForm({ day, event, onClose, onSaved }: { day: string; event: CalendarEvent | null; onClose: () => void; onSaved: () => void }) {
  const { app, mutate, toast, toastError } = useApp();
  const [title, setTitle] = useState(event?.title ?? '');
  const [kind, setKind] = useState<EventKind>(event?.kind ?? 'other');
  const [date, setDate] = useState(event?.day_key ?? day);
  const [start, setStart] = useState(event ? hm(event.starts_at) : '10:00');
  const [end, setEnd] = useState(event ? hm(event.ends_at) : '11:00');
  const [allDay, setAllDay] = useState(event?.all_day === 1);
  const [priority, setPriority] = useState<CalendarEvent['priority']>(event?.priority ?? 'normal');
  const [location, setLocation] = useState(event?.location ?? '');
  const [notes, setNotes] = useState(event?.notes ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!app || !title.trim()) return;
    setBusy(true);
    try {
      const payload = {
        title: title.trim(), kind, day: date, start: allDay ? '00:00' : start, end: allDay ? '23:59' : end,
        all_day: allDay, priority, location: location || null, notes: notes || null,
      };
      if (event) await app.services.calendar.update(event.id, payload);
      else await app.services.calendar.create(payload);
      toast(event ? 'Событие обновлено.' : 'Событие добавлено. Планировщик больше не займёт это время.', 'ok');
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={event ? 'Изменить событие' : 'Новое событие'} onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void save()} disabled={busy || !title.trim()}>Сохранить</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Экзамен, встреча, дорога…" autoFocus /></Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Тип" optional>
          <Select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} style={{ width: 150 }}>
            {(['class', 'work', 'meeting', 'commute', 'errand', 'training', 'social', 'health', 'exam', 'free', 'other'] as EventKind[]).map((k) => (
              <option key={k} value={k}>{KIND_RU[k] ?? k}</option>
            ))}
          </Select>
        </Field>
        <Field label="Приоритет" optional>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as never)} style={{ width: 150 }}>
            <option value="critical">жесткое (не сдвигается)</option>
            <option value="normal">нормальное</option>
            <option value="flexible">гибкое</option>
          </Select>
        </Field>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Дата"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} /></Field>
        {!allDay && (
          <>
            <Field label="Начало"><TextInput type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: 110 }} /></Field>
            <Field label="Конец"><TextInput type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: 110 }} /></Field>
          </>
        )}
      </div>
      <label className="checkbox mb-sm"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Весь день</label>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Место" optional><TextInput value={location} onChange={(e) => setLocation(e.target.value)} style={{ maxWidth: 260 }} /></Field>
      </div>
      <Field label="Заметка" optional><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

/* date helpers */
function daysInMonth(y: number, m: number): number { return new Date(y, m + 1, 0).getDate(); }
function dayOfMonth(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function monthTitle(y: number, m: number): string {
  const names = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  return `${names[m]} ${y}`;
}
