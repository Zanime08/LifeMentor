import React, { useEffect, useState } from 'react';
import type { Skill, SkillView } from '@lifementor/core';
import { Btn, Card, Confirm, Empty, Field, I, LoadFailure, Modal, PageHead, Progress, Select, Spinner, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { loadSafely } from '../lib/load';
import { timeAgo } from '../lib/ru';

const ASSESS_KIND_RU: Record<string, string> = {
  test: 'тест', practice: 'практика', project: 'проект', exam: 'экзамен', task: 'задача', explanation: 'объяснение', real_result: 'реальный результат',
};

export function Skills() {
  const { app, version, mutate, toast } = useApp();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<SkillView | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Skill | null>(null);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    setLoadError(null);
    loadSafely(app.services.skills.list(), { ok: setSkills, fail: setLoadError, alive: () => !stop });
    return () => { stop = true; };
  }, [app, version, reloadTick]);

  useEffect(() => {
    if (!app || !openId) return;
    let stop = false;
    loadSafely(app.services.skills.view(openId), { ok: setView, fail: setLoadError, alive: () => !stop });
    return () => { stop = true; };
  }, [app, openId, version, viewTick]);

  const reloadView = () => setViewTick((t) => t + 1);

  if (loadError) return <LoadFailure what="навыки" message={loadError} onRetry={() => setReloadTick((t) => t + 1)} />;
  if (!skills) return <Spinner label="Загружаю навыки…" />;
  const due = skills.filter((s) => s.next_assessment_at && new Date(s.next_assessment_at).getTime() < Date.now());

  return (
    <div>
      <PageHead title="Навыки" sub="Уровень меняется только по доказательству: проект, тест, практика, экзамен, результат."
        actions={<Btn kind="primary" size="sm" onClick={() => setCreating(true)}>{I.plus} Навык</Btn>} />

      {due.length > 0 && (
        <div className="proactive mb">
          <b>Пора перепроверить:</b> {due.map((s) => s.name).join(', ')} — с момента последней оценки прошёл срок.
        </div>
      )}

      <div className="grid cols-2">
        {skills.map((s) => (
          <Card key={s.id} title={s.name} sub={s.domain ?? undefined}
            action={<Tag tone={s.confidence === 'confirmed' ? 'green' : s.confidence === 'inferred' ? 'p2' : 'p3'}>
              {s.confidence === 'confirmed' ? 'подтверждено' : s.confidence === 'inferred' ? 'оценка' : 'самооценка'}
            </Tag>}>
            <Progress value={s.level} thin />
            <div className="row mt-sm" style={{ justifyContent: 'space-between' }}>
              <span className="xsmall muted">
                {s.last_assessment_at ? `проверка ${timeAgo(s.last_assessment_at)}` : 'ещё не проверялся'}
              </span>
              <Btn size="sm" onClick={() => setOpenId(s.id)}>Открыть</Btn>
            </div>
          </Card>
        ))}
      </div>
      {skills.length === 0 && (
        <Empty icon={I.skills} title="Навыков пока нет" hint="Добавьте те, которыми владеете или хотите освоить — и подтвердите уровни практикой."
          action={<Btn kind="primary" size="sm" onClick={() => setCreating(true)}>Добавить навык</Btn>} />
      )}

      {openId && view && <SkillDetail view={view} onClose={() => setOpenId(null)} onDeleted={() => setOpenId(null)} onChanged={reloadView} />}
      {creating && <SkillCreate onClose={() => setCreating(false)} />}
      {deleting && (
        <Confirm title="Удалить навык?" text={`«${deleting.name}» будет удалён вместе с историей оценок.`}
          onConfirm={() => void mutate(() => app!.services.skills.remove(deleting.id), 'Навык удалён')}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function SkillDetail({ view, onClose, onDeleted, onChanged }: { view: SkillView; onClose: () => void; onDeleted: () => void; onChanged: () => void }) {
  const { app, mutate } = useApp();
  const [assessOpen, setAssessOpen] = useState(false);
  return (
    <Modal title={view.name} onClose={onClose} wide footer={
      <>
        <Btn kind="danger" onClick={() => void mutate(() => app!.services.skills.remove(view.id), 'Навык удалён').then(() => onDeleted())}>Удалить</Btn>
        <Btn kind="primary" onClick={onClose}>Закрыть</Btn>
      </>
    }>
      <div className="row mb" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row">
          <Tag tone={view.confidence === 'confirmed' ? 'green' : 'p2'}>
            {view.confidence === 'confirmed' ? 'подтверждено' : view.confidence === 'inferred' ? 'оценка по данным' : 'самооценка'}
          </Tag>
          {view.domain && <Tag tone="outline">{view.domain}</Tag>}
        </div>
        <span className="pct">{view.level}/100</span>
      </div>
      <Progress value={view.level} />
      {view.description && <p className="small muted mt-sm">{view.description}</p>}

      <div className="section-title">Слабые места</div>
      {view.weak_points_list.length === 0 && <div className="small muted">Не отмечены.</div>}
      {view.weak_points_list.map((w) => <div key={w} className="row" style={{ gap: 8, padding: '2px 0' }}>• <span className="small">{w}</span></div>)}

      <div className="section-title">Оценки (история с доказательствами)</div>
      {view.assessments.length === 0 && <div className="small muted">Оценок пока нет — уровень основан на самооценке.</div>}
      {view.assessments.map((a) => (
        <div key={a.id} className="list-item">
          <div className="li-main">
            <div className="li-title">{ASSESS_KIND_RU[a.kind] ?? a.kind}: {a.level_before} → {a.level_after}</div>
            <div className="li-sub">{timeAgo(a.assessed_at)}{a.evidence_ref ? ` · доказательство: ${a.evidence_ref}` : ''}{a.notes ? ` · ${a.notes}` : ''}</div>
          </div>
        </div>
      ))}

      <div className="mt">
        <Btn kind="primary" size="sm" onClick={() => setAssessOpen(true)}>＋ Новая оценка с доказательством</Btn>
      </div>
      {assessOpen && <AssessForm skill={view} onClose={() => setAssessOpen(false)} onDone={() => { setAssessOpen(false); onChanged(); }} />}
    </Modal>
  );
}

function AssessForm({ skill, onClose, onDone }: { skill: SkillView; onClose: () => void; onDone: () => void }) {
  const { app, mutate, toast } = useApp();
  const [kind, setKind] = useState<'test' | 'practice' | 'project' | 'exam' | 'task' | 'explanation' | 'real_result'>('practice');
  const [score, setScore] = useState(70);
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Оценить «${skill.name}»`} onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" disabled={busy || !evidence.trim()} onClick={() => void mutate(() => app!.services.skills.assess(skill.id, {
          kind, score, evidence_type: kind, evidence_ref: evidence.trim(), notes: notes || null,
        })).then((r) => {
          if (r) {
            toast(r.changed ? `Уровень: ${r.level_before} → ${r.level_after}. Оценка записана с доказательством.` : 'Оценка записана; уровня хватило, чтобы подтвердить текущий.', 'ok');
            onDone();
          }
        })}>Сохранить оценку</Btn>
      </>
    }>
      <p className="small muted mb-sm">
        Уровень сдвинется только если у оценки есть доказательство (req. 41). Опишите, что именно вы сделали.
      </p>
      <Field label="Тип доказательства">
        <Select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          {Object.entries(ASSESS_KIND_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label={`Результат: ${score}%`}>
          <input type="range" min={0} max={100} value={score} onChange={(e) => setScore(Number(e.target.value))} style={{ width: 200, accentColor: 'var(--accent)' }} />
        </Field>
      </div>
      <Field label="Доказательство (обязательно)" hint="напр. «сделал проект Telegram-бот за выходные», «тест на 82%», «2 года работы в продажах»">
        <TextArea value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
      <Field label="Заметка" optional><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

function SkillCreate({ onClose }: { onClose: () => void }) {
  const { app, mutate, toast } = useApp();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [level, setLevel] = useState(20);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Новый навык" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" disabled={busy || !name.trim()} onClick={() => void mutate(() => app!.services.skills.create({
          name: name.trim(), domain: domain || null, description: description || null, level,
        })).then((r) => { if (r) { toast('Навык добавлен. Уровень пока самооценка — подтвердите его практикой.', 'ok'); onClose(); } })}>Создать</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. SQL" autoFocus /></Field>
      <Field label="Область" optional><TextInput value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="напр. backend" /></Field>
      <Field label={`Начальный уровень (самооценка): ${level}/100`}>
        <input type="range" min={0} max={100} value={level} onChange={(e) => setLevel(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </Field>
      <Field label="Описание" optional><TextArea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}
