import React, { useEffect, useState } from 'react';
import type { Goal, GoalNode } from '@lifementor/core';
import { Btn, Card, Confirm, Empty, Field, I, Modal, PageHead, Progress, Select, Spinner, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { HORizons_RU } from '../lib/ru';

export function Goals() {
  const { app, version, mutate, toast } = useApp();
  const [tree, setTree] = useState<GoalNode[] | null>(null);
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [conflicts, setConflicts] = useState<{ a: Goal; b: Goal; reason: string }[]>([]);
  const [stale, setStale] = useState<Goal[]>([]);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    (async () => {
      try {
        const [t, c, s] = await Promise.all([
          app.services.goals.tree(),
          app.services.goals.detectConflicts(),
          app.services.goals.stale(),
        ]);
        if (!stop) { setTree(t); setConflicts(c); setStale(s); }
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { stop = true; };
  }, [app, version]);

  if (!tree) return <Spinner label="Загружаю цели…" />;

  const groups: { horizon: 'long' | 'medium' | 'short' | 'daily'; nodes: GoalNode[] }[] = (['long', 'medium', 'short', 'daily'] as const).map((h) => ({
    horizon: h,
    nodes: tree.filter((n) => n.horizon === h),
  }));

  return (
    <div>
      <PageHead title="Цели" sub="Иерархия: долгосрочные → среднесрочные → проекты → навыки → задачи."
        actions={<Btn kind="primary" size="sm" onClick={() => setEditing('new')}>{I.plus} Новая цель</Btn>} />

      {conflicts.length > 0 && (
        <div className="proactive mb" style={{ background: 'var(--danger-soft)', borderColor: '#e8b8b2' }}>
          <b>Конфликты целей:</b>
          {conflicts.map((c, i) => <div key={i} className="small mt-sm">• «{c.a.title}» ↔ «{c.b.title}» — {c.reason}</div>)}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.horizon}>
          <div className="section-title">{HORizons_RU[g.horizon]}</div>
          {g.nodes.length === 0 && <div className="empty" style={{ padding: '14px 16px' }}>Пусто</div>}
          {g.nodes.map((node) => <GoalCard key={node.id} node={node} onEdit={() => setEditing(node)} onDelete={() => setDeleting(node)} />)}
        </div>
      ))}

      {stale.length > 0 && (
        <Card title="Цели без движения" sub="Наставник предложит проверить их актуальность">
          {stale.map((g) => (
            <div key={g.id} className="row" style={{ gap: 8, padding: '4px 0' }}>
              <Tag tone="p1">нет активности</Tag>
              <span className="grow small">{g.title}</span>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <GoalForm goal={editing === 'new' ? null : editing} allGoals={tree} onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)} />
      )}
      {deleting && (
        <Confirm title="Архивировать цель?" text={`«${deleting.title}» уйдёт в архив (данные и история сохранятся).`}
          confirmLabel="В архив"
          onConfirm={() => void mutate(() => app!.services.goals.archive(deleting.id), 'Цель в архиве')}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function GoalCard({ node, onEdit, onDelete }: { node: GoalNode; onEdit: () => void; onDelete: () => void }) {
  const { app, mutate, toast } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div className="list-item" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
      <input type="checkbox" checked={node.status === 'achieved'} style={{ accentColor: 'var(--accent)', marginTop: 4, width: 16, height: 16 }}
        onChange={() => {
          if (node.status === 'achieved') void mutate(() => app!.services.goals.update(node.id, { status: 'active' }));
          else void mutate(() => app!.services.goals.complete(node.id), 'Цель достигнута 🎉').then(() => {
            const t = node.task_stats;
            void toast(`Прогресс пересчитан. Задач: ${t.done}/${t.total}.`, 'ok');
          });
        }} />
      <div className="li-main" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="li-title">{node.title}</span>
          <Tag tone={`p${node.priority.slice(1)}`}>{node.priority}</Tag>
          {node.status === 'paused' && <Tag tone="p3">пауза</Tag>}
          {node.days_left != null && node.days_left >= 0 && <Tag tone="outline">осталось {node.days_left} дн.</Tag>}
          {node.children.length > 0 && <Tag tone="outline">{node.children.length} подцелей</Tag>}
        </div>
        {node.description && <div className="li-sub" style={{ whiteSpace: 'normal' }}>{node.description}</div>}
        <div className="row mt-sm" style={{ gap: 10, maxWidth: 420 }}>
          <div className="grow"><Progress value={node.progress} thin /></div>
          {node.task_stats.total > 0 && <span className="xsmall muted">задач: {node.task_stats.done}/{node.task_stats.total}</span>}
        </div>
        {open && (
          <div className="tree-goal mt-sm">
            {node.children.length === 0 && <div className="xsmall muted">Подцелей нет — добавьте дочернюю цель, вешая её на эту.</div>}
            {node.children.map((c) => <GoalCard key={c.id} node={c} onEdit={() => {}} onDelete={() => {}} />)}
          </div>
        )}
      </div>
      <div className="li-side">
        <div className="row">
          <Btn kind="ghost" size="xs" onClick={(e) => { e.stopPropagation(); onEdit(); }}>{I.edit}</Btn>
          <Btn kind="ghost" size="xs" onClick={(e) => { e.stopPropagation(); onDelete(); }}>{I.trash}</Btn>
        </div>
      </div>
    </div>
  );
}

function GoalForm({ goal, allGoals, onClose, onSaved }: { goal: Goal | null; allGoals: GoalNode[]; onClose: () => void; onSaved: () => void }) {
  const { app, mutate, toast } = useApp();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [horizon, setHorizon] = useState<Goal['horizon']>(goal?.horizon ?? 'medium');
  const [priority, setPriority] = useState<Goal['priority']>(goal?.priority ?? 'P2');
  const [parentId, setParentId] = useState<string | null>(goal?.parent_id ?? null);
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? '');
  const [motivation, setMotivation] = useState(goal?.motivation ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!app || !title.trim()) return;
    setBusy(true);
    try {
      const payload = {
        title: title.trim(), description: description || null, horizon, priority,
        parent_id: parentId, target_date: targetDate || null, motivation: motivation || null,
      };
      if (goal) await app.services.goals.update(goal.id, payload);
      else await app.services.goals.create(payload);
      toast(goal ? 'Цель обновлена. Изменение записано в историю стратегии.' : 'Цель создана.', 'ok');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  const parents = allGoals.filter((g) => g.id !== goal?.id && (horizon === 'daily' ? g.horizon === 'daily' : g.horizon !== 'daily'));

  return (
    <Modal title={goal ? 'Изменить цель' : 'Новая цель'} onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" onClick={() => void save()} disabled={busy || title.trim().length < 2}>Сохранить</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Конкретно и проверяемо" autoFocus /></Field>
      <Field label="Описание" optional><TextArea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Горизонт">
          <Select value={horizon} onChange={(e) => setHorizon(e.target.value as never)} style={{ width: 170 }}>
            <option value="long">Годы</option><option value="medium">Месяцы</option>
            <option value="short">Недели</option><option value="daily">Ежедневно</option>
          </Select>
        </Field>
        <Field label="Приоритет">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as never)} style={{ width: 150 }}>
            <option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
          </Select>
        </Field>
        <Field label="Целевая дата" optional>
          <TextInput type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} style={{ width: 160 }} />
        </Field>
      </div>
      {goal && (
        <Field label="Родительская цель" optional>
          <Select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)} style={{ width: '100%' }}>
            <option value="">— нет (корневая) —</option>
            {parents.map((g) => <option key={g.id} value={g.id}>{g.title} ({HORizons_RU[g.horizon]})</option>)}
          </Select>
        </Field>
      )}
      <Field label="Мотивация" optional hint="Почему это важно именно вам" ><TextInput value={motivation} onChange={(e) => setMotivation(e.target.value)} /></Field>
    </Modal>
  );
}
