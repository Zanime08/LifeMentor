import React, { useEffect, useState } from 'react';
import type { LearningPath, LearningReview, PathView, Skill } from '@lifementor/core';
import { Btn, Card, Empty, Field, I, Modal, PageHead, Progress, Select, Spinner, Stars, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { fmtMinutes, plural, timeAgo } from '../lib/ru';

export function Learning() {
  const { app, version, mutate, toast } = useApp();
  const [paths, setPaths] = useState<LearningPath[] | null>(null);
  const [openPath, setOpenPath] = useState<PathView | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [reviews, setReviews] = useState<(LearningReview & { topic_title: string; path_title: string })[]>([]);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    (async () => {
      try {
        const [p, r] = await Promise.all([app.services.learning.paths(), app.services.learning.dueReviews(30)]);
        if (!stop) { setPaths(p); setReviews(r); }
      } catch (e) { console.error(e); }
    })();
    return () => { stop = true; };
  }, [app, version]);

  const open = async (id: string) => {
    if (!app) return;
    try { setOpenPath(await app.services.learning.pathView(id)); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  if (!paths) return <Spinner label="Загружаю обучение…" />;

  const refreshPaths = () => { if (app) void app.services.learning.paths().then(setPaths).catch(() => undefined); };

  return (
    <div>
      <PageHead title="Обучение" sub="Пути → темы → практика → повторение по интервалам (SM-2)."
        actions={<Btn kind="primary" size="sm" onClick={() => setCreateOpen(true)}>{I.plus} Путь обучения</Btn>} />

      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr', alignItems: 'start' }}>
        <div className="stack">
          {paths.length === 0 && (
            <Empty icon={I.learning} title="Путов обучения пока нет"
              hint="Скажите наставнику «хочу изучить X» — он определит уровень и соберёт путь. Или создайте вручную."
              action={<Btn kind="primary" size="sm" onClick={() => setCreateOpen(true)}>Создать путь</Btn>} />
          )}
          {paths.map((p) => (
            <Card key={p.id} title={p.title} sub={p.description ?? undefined}
              action={p.status !== 'active' ? <Tag tone="p3">{p.status}</Tag> : undefined}>
              <Progress value={p.progress} thin />
              <div className="row mt-sm" style={{ justifyContent: 'space-between' }}>
                <span className="xsmall muted">
                  {p.status === 'active' ? 'активен' : p.status === 'completed' ? 'завершён' : p.status}
                </span>
                <Btn size="sm" onClick={() => void open(p.id)}>Открыть →</Btn>
              </div>
            </Card>
          ))}
        </div>

        <Card title="Повторения" sub={reviews.length ? `К выполнению: ${reviews.length} — активное извлечение по интервалам` : undefined}>
          {reviews.length === 0 && <div className="small muted">Сейчас повторений нет. Они появятся после изучения тем — с интервалами 1, 3, 7, 21 день.</div>}
          {reviews.map((r) => (
            <div key={r.id} className="list-item" style={{ alignItems: 'center' }}>
              <div className="li-main">
                <div className="li-title" style={{ fontSize: 13 }}>{r.prompt}</div>
                <div className="li-sub">{r.path_title} · {r.topic_title}</div>
              </div>
              <ReviewGrade reviewId={r.id} onDone={() => { refreshPaths(); if (app) void app.services.learning.dueReviews(30).then(setReviews).catch(() => undefined); }} />
            </div>
          ))}
        </Card>
      </div>

      {openPath && <PathDetail view={openPath} onClose={() => setOpenPath(null)} onReload={() => void open(openPath.id)} />}
      {createOpen && <PathCreate onClose={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); void open(id); }} />}
    </div>
  );
}

function ReviewGrade({ reviewId, onDone }: { reviewId: string; onDone: () => void }) {
  const { app, mutate, toast } = useApp();
  const [showGrade, setShowGrade] = useState(false);
  return (
    <div className="row" style={{ gap: 4 }}>
      {showGrade ? (
        <>
          <span className="xsmall muted">качество (0–5):</span>
          <Stars value={0} onChange={(q) => void mutate(() => app!.services.learning.gradeReview(reviewId, q)).then((r) => {
            if (r) { toast('Оценка сохранена. Следующее повторение запланировано по интервалу.', 'ok'); onDone(); }
          })} />
        </>
      ) : (
        <Btn size="xs" onClick={() => setShowGrade(true)}>Ответить</Btn>
      )}
    </div>
  );
}

function PathDetail({ view, onClose, onReload }: { view: PathView; onClose: () => void; onReload: () => void }) {
  const { app, mutate, toast } = useApp();
  const [logFor, setLogFor] = useState<string | null>(null);
  return (
    <Modal title={view.title} onClose={onClose} wide footer={<Btn onClick={onClose}>Закрыть</Btn>}>
      <div className="row mb-sm" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">
          {view.skill_name ? `Навык: ${view.skill_name} · ` : ''}
          {view.done_minutes} мин из ~{view.total_minutes} · повторений: {view.due_reviews}
        </span>
        <Progress value={view.progress} thin />
      </div>
      {view.topics.map((t) => (
        <div key={t.id} className="list-item" style={{ alignItems: 'flex-start' }}>
          <input type="checkbox" checked={t.status === 'done'} style={{ accentColor: 'var(--accent)', marginTop: 3, width: 16, height: 16 }}
            onChange={() => {
              if (t.status === 'done') void mutate(() => app!.services.learning.updateTopic(t.id, { status: 'available' }));
              else void mutate(() => app!.services.learning.completeTopic(t.id), 'Тема завершена, карточки встали в повторение').then(() => onReload());
            }} />
          <div className="li-main">
            <div className="li-title">{t.position + 1}. {t.title}</div>
            {t.summary && <div className="li-sub" style={{ whiteSpace: 'normal' }}>{t.summary}</div>}
            {t.outcome && <div className="xsmall muted mt-sm">Результат: {t.outcome}</div>}
            <div className="row mt-sm" style={{ gap: 6 }}>
              <Tag tone="outline">{fmtMinutes(t.estimated_minutes)}</Tag>
              {t.cards_due > 0 && <Tag tone="p1">повторений: {t.cards_due}</Tag>}
              <Tag tone={t.status === 'done' ? 'green' : t.status === 'in_progress' ? 'p2' : 'p3'}>
                {t.status === 'done' ? 'изучено' : t.status === 'in_progress' ? 'в процессе' : t.status === 'skipped' ? 'пропущено' : 'доступно'}
              </Tag>
            </div>
          </div>
          <div className="li-side">
            <Btn size="xs" onClick={() => setLogFor(t.id)}>＋ прогресс</Btn>
          </div>
        </div>
      ))}
      {logFor && <ProgressLog topicId={logFor} onClose={() => setLogFor(null)} onDone={onReload} />}
    </Modal>
  );
}

function ProgressLog({ topicId, onClose, onDone }: { topicId: string; onClose: () => void; onDone: () => void }) {
  const { app, mutate, toast } = useApp();
  const [kind, setKind] = useState<'study' | 'practice' | 'test' | 'recall' | 'explanation' | 'project'>('study');
  const [minutes, setMinutes] = useState(30);
  const [score, setScore] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  return (
    <Modal title="Записать прогресс" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void mutate(() => app!.services.learning.recordProgress({
          topic_id: topicId, kind, minutes, score: score === '' ? null : score, notes: notes || null,
        })).then((r) => { if (r) { toast('Прогресс сохранён.', 'ok'); onDone(); onClose(); } })}>Сохранить</Btn>
      </>
    }>
      <Field label="Тип занятия">
        <Select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="study">изучение</option><option value="practice">практика</option>
          <option value="test">тест</option><option value="recall">active recall</option>
          <option value="explanation">объяснение</option><option value="project">проект</option>
        </Select>
      </Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Минуты"><TextInput type="number" min={0} max={720} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 0)} style={{ width: 110 }} /></Field>
        <Field label="Оценка 0–100" optional><TextInput type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 110 }} /></Field>
      </div>
      <Field label="Заметка" optional><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

function PathCreate({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { app, mutate, toast } = useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillId, setSkillId] = useState('');
  const [topicLines, setTopicLines] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (app) void app.services.skills.list().then(setSkills).catch(() => undefined); }, [app]);

  const create = async () => {
    if (!app || !title.trim()) return;
    const topics = topicLines.split('\n').map((l) => l.trim()).filter(Boolean).map((t, i) => ({
      title: t, estimated_minutes: 45, depends_on: i > 0 ? [] : [], summary: null, outcome: null, resources: [], cards: [],
    }));
    if (!topics.length) { toast('Добавьте хотя бы одну тему (каждая с новой строки)', 'warn'); return; }
    setBusy(true);
    try {
      const r = await app.services.learning.createPath({
        title: title.trim(), description: description || null,
        skill_id: skillId || null, topics,
      });
      toast('Путь создан. Начните с первой темы.', 'ok');
      onCreated(r.path.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Новый путь обучения" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void create()} disabled={busy || !title.trim()}>Создать</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="напр. Python с нуля до backend" autoFocus /></Field>
      <Field label="Описание" optional><TextArea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Связанный навык" optional>
        <Select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
          <option value="">— не связывать —</option>
          {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="Темы (каждая с новой строки)" hint="Сверху вниз — по порядку; зависимости вы пометите позже">
        <TextArea value={topicLines} onChange={(e) => setTopicLines(e.target.value)} placeholder={'Основы языка\nСтруктуры данных\nПервая практика'} style={{ minHeight: 110 }} />
      </Field>
    </Modal>
  );
}


