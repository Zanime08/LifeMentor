import React, { useEffect, useState } from 'react';
import type { Project, ProjectDetails, ProjectMilestone } from '@lifementor/core';
import { Btn, Card, Confirm, Empty, Field, I, Modal, PageHead, Progress, Select, Spinner, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';

export function Projects() {
  const { app, version, mutate, toast, toastError } = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [detailsTick, setDetailsTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    app.services.projects.list().then((p) => { if (!stop) setProjects(p); }).catch(() => undefined);
    return () => { stop = true; };
  }, [app, version]);

  useEffect(() => {
    if (!app || !openId) return;
    let stop = false;
    app.services.projects.details(openId).then((d) => { if (!stop) setDetails(d); }).catch(() => undefined);
    return () => { stop = true; };
  }, [app, openId, version, detailsTick]);

  const reloadDetails = () => setDetailsTick((t) => t + 1);

  if (!projects) return <Spinner label="Загружаю проекты…" />;

  return (
    <div>
      <PageHead title="Проекты" sub="Проект соединяет цель, вехи, задачи, навыки и обучение."
        actions={<Btn kind="primary" size="sm" onClick={() => setCreating(true)}>{I.plus} Проект</Btn>} />

      {projects.length === 0 && (
        <Empty icon={I.projects} title="Проектов пока нет"
          hint="Проект — это конкретная работа над целью: у неё есть вехи, дедлайн и связанный навык."
          action={<Btn kind="primary" size="sm" onClick={() => setCreating(true)}>Создать проект</Btn>} />
      )}

      <div className="grid cols-2">
        {projects.map((p) => (
          <Card key={p.id} title={p.title} sub={p.description ?? undefined}
            action={<Tag tone={p.status === 'active' ? 'green' : p.status === 'done' ? 'gold' : 'p3'}>{p.status === 'active' ? 'активен' : p.status === 'idea' ? 'идея' : p.status === 'done' ? 'завершён' : p.status}</Tag>}>
            <Progress value={p.progress} thin />
            <div className="row mt-sm" style={{ justifyContent: 'space-between' }}>
              <span className="xsmall muted">
                {p.priority}
                {p.deadline ? ` · дедлайн ${p.deadline}` : ''}
                {p.goal_id ? ' · привязан к цели' : ''}
              </span>
              <div className="row">
                <Btn size="sm" onClick={() => setOpenId(p.id)}>Открыть</Btn>
                <Btn kind="ghost" size="sm" onClick={() => setDeleting(p)}>{I.trash}</Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {openId && details && <ProjectDetail details={details} onClose={() => setOpenId(null)} onDeleted={() => setOpenId(null)} onChanged={reloadDetails} />}
      {creating && <ProjectCreate onClose={() => setCreating(false)} />}
      {deleting && (
        <Confirm title="Удалить проект?" text={`«${deleting.title}» будет перемещён в архив. Вехи и связанные задачи останутся.`}
          confirmLabel="В архив"
          onConfirm={() => void mutate(() => app!.services.projects.archive(deleting.id), 'Проект в архиве')}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function ProjectDetail({ details, onClose, onDeleted, onChanged }: { details: ProjectDetails; onClose: () => void; onDeleted: () => void; onChanged: () => void }) {
  const { app, mutate } = useApp();
  const p = details.project;
  const [msTitle, setMsTitle] = useState('');
  return (
    <Modal title={p.title} onClose={onClose} wide footer={
      <>
        <Btn kind="danger" onClick={() => void mutate(() => app!.services.projects.archive(p.id), 'Проект в архиве').then(() => onDeleted())}>В архив</Btn>
        <Btn kind="primary" onClick={onClose}>Закрыть</Btn>
      </>
    }>
      <div className="row mb" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">{p.description || 'Без описания'} · {p.status}</span>
        <Tag tone="green">{p.progress}%</Tag>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>Вехи</div>
      {details.milestones.length === 0 && <div className="small muted mb-sm">Вех пока нет.</div>}
      {details.milestones.map((m) => (
        <div key={m.id} className="row" style={{ gap: 10, padding: '5px 0', alignItems: 'center' }}>
          <input type="checkbox" checked={m.status === 'done'} style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
            onChange={() => {
              if (m.status === 'done') void mutate(() => app!.services.projects.updateMilestone(m.id, { status: 'pending' })).then((r) => { if (r) onChanged(); });
              else void mutate(() => app!.services.projects.completeMilestone(m.id), 'Веха завершена').then((r) => { if (r) onChanged(); });
            }} />
          <span className={`grow small ${m.status === 'done' ? 'muted' : ''}`} style={{ textDecoration: m.status === 'done' ? 'line-through' : undefined }}>
            {m.title}{m.due_date ? <span className="muted"> · до {m.due_date}</span> : null}
          </span>
          <Btn kind="ghost" size="xs" onClick={() => void mutate(() => app!.services.projects.removeMilestone(m.id)).then((r) => { if (r) onChanged(); })}>{I.trash}</Btn>
        </div>
      ))}
      <div className="row mb" style={{ gap: 8 }}>
        <TextInput value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder="Новая веха" style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => {
          if (!msTitle.trim()) return;
          void mutate(() => app!.services.projects.addMilestone(p.id, { title: msTitle.trim() })).then((r) => { if (r) { setMsTitle(''); onChanged(); } });
        }}>Добавить</Btn>
      </div>

      {details.tasks.length > 0 && (
        <>
          <div className="section-title">Задачи проекта</div>
          {details.tasks.slice(0, 15).map((t) => (
            <div key={t.id} className="row" style={{ gap: 8, padding: '3px 0' }}>
              <span className={`xsmall ${t.status === 'done' ? 'muted' : ''}`} style={{ textDecoration: t.status === 'done' ? 'line-through' : undefined }}>• {t.title}</span>
              <Tag tone={`p${t.priority.slice(1)}`}>{t.priority}</Tag>
              {t.status !== 'done' && t.status !== 'cancelled' && <Tag tone="outline">{t.status}</Tag>}
            </div>
          ))}
        </>
      )}

      {details.skills.length > 0 && (
        <>
          <div className="section-title">Навыки</div>
          <div className="row wrap">
            {details.skills.map((s) => <Tag key={s.id} tone="violet">{s.name} · {s.level}/100</Tag>)}
          </div>
        </>
      )}
    </Modal>
  );
}

function ProjectCreate({ onClose }: { onClose: () => void }) {
  const { app, mutate, toast, toastError } = useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [goalId, setGoalId] = useState('');
  const [deadline, setDeadline] = useState('');
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [milestones, setMilestones] = useState('');
  const [goals, setGoals] = useState<import('@lifementor/core').Goal[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (app) void app.services.goals.list({ status: 'active' }).then(setGoals).catch(() => undefined); }, [app]);

  const create = async () => {
    if (!app || !title.trim()) return;
    setBusy(true);
    try {
      const ms = milestones.split('\n').map((l) => l.trim()).filter(Boolean).map((t) => ({ title: t, weight: 1 }));
      await app.services.projects.create({
        title: title.trim(), description: description || null, goal_id: goalId || null,
        priority, deadline: deadline || null, milestones: ms,
      });
      toast('Проект создан.', 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Новый проект" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void create()} disabled={busy || !title.trim()}>Создать</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="напр. Портфолио-сайт" autoFocus /></Field>
      <Field label="Описание" optional><TextArea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Цель" optional>
          <Select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">— без цели —</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </Select>
        </Field>
        <Field label="Дедлайн" optional>
          <TextInput type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={{ width: 160 }} />
        </Field>
        <Field label="Приоритет">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as never)} style={{ width: 90 }}>
            <option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
          </Select>
        </Field>
      </div>
      <Field label="Вехи (каждая с новой строки)" optional>
        <TextArea value={milestones} onChange={(e) => setMilestones(e.target.value)} placeholder={'Черновик\nПервая версия\nПубликация'} />
      </Field>
    </Modal>
  );
}
