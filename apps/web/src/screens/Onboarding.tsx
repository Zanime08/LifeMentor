import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QUESTIONNAIRE, type Question, type QuestionBlock } from '@lifementor/core';
import type { GoalDraft } from '@lifementor/core';
import { Btn, Field, I, Spinner, TextArea, TextInput, Tag } from '../components/ui';
import { userError } from '../lib/errors';
import { useApp } from '../state/store';
import { BLOCK_RU, GAP_TYPE_RU, Q_RU, SECTION_RU, modelLabelRu, modelValueRu, optRu } from '../lib/onboarding-ru';

type Stage = 'welcome' | 'questionnaire' | 'analysis' | 'interview' | 'preview' | 'goals';

const STAGE_ORDER: Stage[] = ['welcome', 'questionnaire', 'analysis', 'interview', 'preview', 'goals'];

export function Onboarding() {
  const { app, mutate, toast, toastError } = useApp();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>('welcome');
  const [blockIdx, setBlockIdx] = useState(0);
  const [analysis, setAnalysis] = useState<{ gaps: number; selected: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  const begin = async () => {
    if (!app) return;
    setBusy(true);
    try {
      await app.services.onboarding.start();
      setStarted(true);
      setStage('questionnaire');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const idx = STAGE_ORDER.indexOf(stage);
  const progress = (
    <div className="ob-progress">
      {STAGE_ORDER.map((s, i) => (
        <div key={s} className={`ob-step ${i < idx ? 'done' : i === idx ? 'current' : ''}`} />
      ))}
    </div>
  );

  return (
    <div className="center-screen">
      <div className="ob-card">
        {progress}
        <div className="card">
          {!started && stage === 'welcome' && (
            <Welcome busy={busy} onBegin={() => void begin()} onSkip={() => navigate('/auth')} />
          )}
          {stage === 'questionnaire' && app && (
            <Questionnaire block={QUESTIONNAIRE[blockIdx]} blockIndex={blockIdx} totalBlocks={QUESTIONNAIRE.length}
              onNext={() => {
                if (blockIdx + 1 < QUESTIONNAIRE.length) setBlockIdx(blockIdx + 1);
                else void runAnalysis(app, setAnalysis, setStage, toast);
              }}
              onBack={() => { if (blockIdx > 0) setBlockIdx(blockIdx - 1); else setStage('welcome'); }} />
          )}
          {stage === 'analysis' && app && (
            <Analysis analysis={analysis} onContinue={() => setStage('interview')} />
          )}
          {stage === 'interview' && app && <Interview onDone={() => setStage('preview')} />}
          {stage === 'preview' && app && (
            <Preview onDone={() => setStage('goals')} toast={toast} mutate={mutate} />
          )}
          {stage === 'goals' && app && (
            <GoalsStep onDone={() => navigate('/dashboard')} />
          )}
        </div>
        <p className="xsmall muted mt-sm" style={{ textAlign: 'center' }}>
          Каждый ответ сохраняется сразу — можно закрыть приложение и вернуться в любой момент.
        </p>
      </div>
    </div>
  );
}

function Welcome({ busy, onBegin, onSkip }: { busy: boolean; onBegin: () => void; onSkip: () => void }) {
  return (
    <div>
      <div className="brand" style={{ justifyContent: 'center', padding: '6px 0 10px' }}>
        <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 17 }}>LM</div>
      </div>
      <h1 style={{ textAlign: 'center' }}>Сначала мне нужно понять, кто вы</h1>
      <p className="muted mt-sm" style={{ textAlign: 'center' }}>
        Я не буду выдавать вам «стандартный план продуктивности». Сначала — несколько вопросов
        о вашей ситуации, целях и времени. Потом я задам уточняющие вопросы по тому, где информации
        не хватило. В конце вы увидите, как я вас понял, и сможете всё поправить.
      </p>
      <div className="stack mt" style={{ gap: 8 }}>
        <Btn kind="primary" onClick={onBegin} disabled={busy} style={{ width: '100%' }}>
          {busy ? <Spinner /> : 'Начать знакомство (~5 минут)'}
        </Btn>
        <Btn kind="ghost" onClick={onSkip}>Создать аккаунт и синхронизировать устройства</Btn>
      </div>
    </div>
  );
}

async function runAnalysis(app: NonNullable<ReturnType<typeof useApp>['app']>, set: (v: { gaps: number; selected: number }) => void, setStage: (s: Stage) => void, toast: (t: string, k?: 'info' | 'error' | 'ok' | 'warn') => void) {
  try {
    const result = await app.services.onboarding.analyse();
    set({ gaps: result.gaps.length, selected: result.selected.length });
    setStage('analysis');
  } catch (e) {
    toast(userError(e), 'error');
  }
}

function Analysis({ analysis, onContinue }: { analysis: { gaps: number; selected: number } | null; onContinue: () => void }) {
  return (
    <div>
      <h2>Анализирую ваши ответы…</h2>
      {!analysis ? <div className="mt"><Spinner label="Ищу противоречия, расплывчатые цели и недостающие ограничения" /></div> : (
        <div className="mt">
          <p className="muted">Готово. Я проанализировал анкету: нашёл {analysis.gaps} зон, где стоит уточнить.</p>
          <Btn kind="primary" onClick={onContinue}>Перейти к уточняющим вопросам →</Btn>
        </div>
      )}
    </div>
  );
}

/* ── Stage 1: questionnaire ─────────────────────────────────────────── */
function Questionnaire({ block, blockIndex, totalBlocks, onNext, onBack }: { block: QuestionBlock; blockIndex: number; totalBlocks: number; onNext: () => void; onBack: () => void }) {
  const { app, mutate } = useApp();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let stop = false;
    if (app) app.services.onboarding.answers().then((a) => { if (!stop) setAnswers(a); }).catch(() => undefined);
    return () => { stop = true; };
  }, [app]);

  const ru = BLOCK_RU[block.id] ?? { title: block.title, subtitle: block.subtitle };
  const criticalMissing = block.questions.filter((q) => q.critical && !hasAnswer(answers[q.key]));

  const saveAndNext = async () => {
    if (!app) return;
    try {
      await app.services.onboarding.answerBlock(answers as Record<string, unknown>);
      onNext();
    } catch { /* handled */ }
  };

  return (
    <div>
      <div className="row mb-sm">
        <div className="grow">
          <h2>{ru.title}</h2>
          <div className="muted small">{ru.subtitle}</div>
        </div>
        <span className="tag outline">Блок {blockIndex + 1} / {totalBlocks}</span>
      </div>
      {block.questions.map((q) => (
        <QuestionView key={q.key} question={q} value={answers[q.key]}
          onChange={(v) => setAnswers((a) => ({ ...a, [q.key]: v }))} />
      ))}
      <div className="row mt" style={{ justifyContent: 'space-between' }}>
        <span className="small muted">
          {criticalMissing.length > 0 ? `Без ответа: ${criticalMissing.length} важных вопрос(а)` : 'Все важные вопросы отвечены ✓'}
        </span>
        <div className="row">
          {blockIndex > 0 && <Btn onClick={onBack}>← Назад</Btn>}
          <Btn kind="primary" onClick={() => void saveAndNext()}>Сохранить и дальше</Btn>
        </div>
      </div>
    </div>
  );
}

function hasAnswer(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v >= 0;
  return true;
}

function QuestionView({ question, value, onChange }: { question: Question; value: unknown; onChange: (v: unknown) => void }) {
  const ru = Q_RU[question.key];
  const prompt = ru?.prompt ?? question.prompt;
  const help = ru?.help ?? question.help;
  const placeholder = ru?.placeholder ?? question.placeholder;

  return (
    <div className="mb">
      <div className="field" style={{ marginBottom: 8 }}>
        <label>{prompt}{question.optional && <span className="muted"> · можно пропустить</span>}</label>
      </div>
      {help && <div className="xsmall muted mb-sm">{help}</div>}
      {question.kind === 'single' && (
        <div>
          {question.options?.map((o) => (
            <label key={o.id} className={`q-option ${value === o.id ? 'sel' : ''}`} onClick={() => onChange(value === o.id ? null : o.id)}>
              {optRu(question.key, o.id, o.label)}
              {o.hint && <span className="q-hint">{o.hint}</span>}
            </label>
          ))}
        </div>
      )}
      {question.kind === 'multi' && (
        <div>
          {question.options?.map((o) => {
            const list = Array.isArray(value) ? (value as string[]) : [];
            const sel = list.includes(o.id);
            return (
              <label key={o.id} className={`q-option ${sel ? 'sel' : ''}`} onClick={() => onChange(sel ? list.filter((x) => x !== o.id) : [...list, o.id])}>
                {optRu(question.key, o.id, o.label)}
              </label>
            );
          })}
        </div>
      )}
      {question.kind === 'text' && (
        <TextArea value={(value as string) ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {question.kind === 'number' && (
        <div className="row">
          <TextInput type="number" min={0} step={question.key === 'capital_available' ? 100 : 0.5} className="" value={(value as number | '') ?? ''} placeholder={placeholder ?? '0'} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={{ maxWidth: 180 }} />
          {question.unit && <span className="muted small">{ru?.unit ?? question.unit}</span>}
        </div>
      )}
      {question.kind === 'time' && (
        <TextInput type="time" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 160 }} />
      )}
      {question.kind === 'scale' && question.scale && (
        <div>
          <input type="range" min={question.scale.min} max={question.scale.max} step={1} value={(value as number) ?? Math.round((question.scale.min + question.scale.max) / 2)}
            onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="xsmall muted">{question.scale.minLabel}</span>
            <Tag tone="green">{String((value as number) ?? Math.round((question.scale.min + question.scale.max) / 2))}</Tag>
            <span className="xsmall muted">{question.scale.maxLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Stage 2: adaptive interview ────────────────────────────────────── */
function Interview({ onDone }: { onDone: () => void }) {
  const { app, mutate, toast, toastError, refresh } = useApp();
  const [question, setQuestion] = useState<import('@lifementor/core').InterviewQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);

  const loadNext = async () => {
    if (!app) return;
    setLoading(true);
    try {
      const pending = await app.services.onboarding.pendingInterviewQuestions();
      setRemaining(pending.length);
      if (pending.length === 0) { onDone(); return; }
      const next = pending[0];
      setQuestion(next);
      await app.services.onboarding.markAsked(next.id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadNext(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const submit = async (skip: boolean) => {
    if (!app || !question || busy) return;
    setBusy(true);
    try {
      if (skip) {
        await app.services.onboarding.skipInterview(question.id);
      } else {
        if (!answer.trim()) { toast('Напишите ответ — или пропустите вопрос', 'warn'); setBusy(false); return; }
        await app.services.onboarding.answerInterview(question.id, answer.trim());
      }
      setAnswer('');
      setQuestion(null);
      await loadNext();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (loading && !question) return <Spinner label="Подбираю вопросы…" />;
  if (!question) return <div><Spinner label="Готовлю следующий вопрос…" /></div>;

  return (
    <div>
      <div className="row mb-sm">
        <h2 className="grow">Уточняющие вопросы</h2>
        <span className="tag outline">осталось: {remaining}</span>
      </div>
      <div className="proactive">
        <b>Почему спрашиваю:</b> {question.rationale ?? 'это сделает модель точнее'}
        <div className="xsmall muted mt-sm">Зона: {GAP_TYPE_RU[question.gap_type] ?? question.gap_type}</div>
      </div>
      <h3 className="mt">{question.question}</h3>
      <div className="mt-sm">
        <TextArea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Ваш ответ своими словами…" />
      </div>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <Btn kind="ghost" onClick={() => void submit(true)} disabled={busy}>Пропустить</Btn>
        <Btn kind="primary" onClick={() => void submit(false)} disabled={busy}>{busy ? 'Сохраняю…' : 'Ответить'}</Btn>
      </div>
    </div>
  );
}

/* ── Stage 3: model preview — "Вот как я тебя понял" ────────────────── */
function Preview({ onDone, toast, mutate }: { onDone: () => void; toast: (t: string, k?: 'info' | 'error' | 'ok' | 'warn') => void; mutate: <T>(fn: () => Promise<T>, ok?: string) => Promise<T | null> }) {
  const { app, toastError } = useApp();
  const [preview, setPreview] = useState<Awaited<ReturnType<import('@lifementor/core').OnboardingService['previewModel']>> | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!app) return;
    app.services.onboarding.previewModel().then(setPreview).catch((e) => toastError(e));
  }, [app, toast]);

  const grouped = useMemo(() => {
    if (!preview) return [];
    const bySection = new Map<string, typeof preview.items>();
    for (const item of preview.items) {
      const list = bySection.get(item.section) ?? [];
      list.push(item);
      bySection.set(item.section, list);
    }
    return [...bySection.entries()];
  }, [preview]);

  const confirm = async () => {
    if (!app || !preview) return;
    setBusy(true);
    try {
      const items = preview.items
        .filter((i) => !removed.has(itemKey(i.section, i.key)))
        .map((i) => ({ section: i.section, key: i.key, value: edits[itemKey(i.section, i.key)] !== undefined ? parseValue(edits[itemKey(i.section, i.key)]) : i.value }));
      const removals = [...removed].map((k) => {
        const [section, ...rest] = k.split('::');
        return { section: section as never, key: rest.join('::') };
      });
      await app.services.onboarding.confirmModel({ items, removed: removals });
      toast('Модель пользователя подтверждена. Это факт — не предположение.', 'ok');
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!preview) return <Spinner label="Собираю модель…" />;

  return (
    <div>
      <div className="row mb-sm">
        <h2 className="grow">Вот как я вас понял</h2>
        <span className="tag outline">{preview.items.length} фактов</span>
      </div>
      <p className="muted small">{preview.summary}</p>
      {preview.assumptions.length > 0 && (
        <div className="proactive" style={{ background: 'var(--gold-soft)', borderColor: '#e4d3a1' }}>
          <b>Предположения (не факты):</b> {preview.assumptions.map((a) => a.key).join(', ')} — проверьте и поправьте.
        </div>
      )}
      {grouped.map(([section, items]) => (
        <div key={section}>
          <SectionLabelRu>{SECTION_RU[section] ?? section}</SectionLabelRu>
          {items.filter((i) => !removed.has(itemKey(i.section, i.key))).map((i) => {
            const k = itemKey(i.section, i.key);
            return (
              <div key={k} className="model-item">
                <div className="mi-head">
                  <span>{modelLabelRu(i.key, i.label)}</span>
                  <Tag tone={i.source === 'ai_inferred' ? 'gold' : 'green'}>{i.source === 'ai_inferred' ? 'определено ИИ' : 'от вас'}</Tag>
                  {i.confidence !== 'confirmed' && <Tag tone="outline">уверенность: {i.confidence === 'inferred' ? 'средняя' : 'низкая'}</Tag>}
                  <span style={{ flex: 1 }} />
                  <Btn kind="ghost" size="xs" onClick={() => setRemoved((s) => new Set(s).add(k))}>{I.trash}</Btn>
                </div>
                {typeof i.value === 'string' || typeof i.value === 'number' ? (
                  <input className="input" style={{ marginTop: 6, fontWeight: 560 }}
                    defaultValue={modelValueRu(i.value)}
                    onChange={(e) => setEdits((m) => ({ ...m, [k]: e.target.value }))} />
                ) : (
                  <div className="mi-value">{modelValueRu(i.value)}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <Btn kind="ghost" onClick={() => history.back()}>← К вопросам</Btn>
        <Btn kind="primary" onClick={() => void confirm()} disabled={busy}>{busy ? 'Сохраняю…' : 'Подтвердить модель'}</Btn>
      </div>
    </div>
  );
}

function SectionLabelRu({ children }: { children: React.ReactNode }) {
  return <div className="section-title">{children}</div>;
}

function itemKey(section: string, key: string) { return `${section}::${key}`; }
function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === '') return null;
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch { /* fall through */ } }
  if (!Number.isNaN(Number(t)) && /^\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/* ── Stage 4: initial goals + skills + first plan ───────────────────── */
function GoalsStep({ onDone }: { onDone: () => void }) {
  const { app, toast, toastError } = useApp();
  const [drafts, setDrafts] = useState<GoalDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    app.services.onboarding.suggestGoals()
      .then((d) => setDrafts(d.length ? d : [{ title: 'Сформировать первые конкретные цели с наставником', horizon: 'short', priority: 'P1' }]))
      .catch(() => setDrafts([{ title: 'Сформировать первые конкретные цели с наставником', horizon: 'short', priority: 'P1' }]));
  }, [app]);

  const finish = async () => {
    if (!app || !drafts || busy) return;
    setBusy(true);
    try {
      setProgress('Создаю цели…');
      await app.services.onboarding.createGoals(drafts);
      setProgress('Строю карту навыков…');
      await app.services.onboarding.createInitialSkills();
      setProgress('Готовлю карту знаний…');
      await app.services.onboarding.seedKnowledge();
      setProgress('Собираю первый план на завтра…');
      const plan = await app.services.onboarding.createInitialPlan();
      if (plan.slots.length > 0) setProgress('Готово. План на завтра построен.');
      await app.services.onboarding.complete();
      onDone();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  if (!drafts) return <Spinner label="Предлагаю первые цели по вашим ответам…" />;

  return (
    <div>
      <h2>Первые цели</h2>
      <p className="muted small mt-sm">
        Я предложил цели только на основе ваших ответов. Отредактируйте, добавьте или удалите —
        они станут корнем вашей системы: проекты, навыки и задачи будут вешаться на них.
      </p>
      <div className="mt">
        {drafts.map((d, i) => (
          <div key={i} className="model-item">
            <div className="row" style={{ gap: 8 }}>
              <input className="input" style={{ flex: 1, fontWeight: 560 }} value={d.title}
                onChange={(e) => setDrafts((ds) => (ds ?? []).map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <select className="select" style={{ width: 150 }} value={d.horizon}
                onChange={(e) => setDrafts((ds) => (ds ?? []).map((x, j) => (j === i ? { ...x, horizon: e.target.value as GoalDraft['horizon'] } : x)))}>
                <option value="long">Годы</option><option value="medium">Месяцы</option>
                <option value="short">Недели</option><option value="daily">Ежедневно</option>
              </select>
              <Btn kind="ghost" size="sm" onClick={() => setDrafts((ds) => (ds ?? []).filter((_, j) => j !== i))}>{I.trash}</Btn>
            </div>
          </div>
        ))}
      </div>
      <Btn kind="ghost" size="sm" className="mt-sm" onClick={() => setDrafts((ds) => [...(ds ?? []), { title: '', horizon: 'short', priority: 'P2' }])}>＋ Добавить цель</Btn>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <Btn kind="primary" onClick={() => void finish()} disabled={busy || drafts.every((d) => !d.title.trim())}>
          {busy ? <Spinner /> : progress ? progress : 'Запустить систему →'}
        </Btn>
      </div>
    </div>
  );
}

