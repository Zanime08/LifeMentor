import React, { useEffect, useState } from 'react';
import type { StrategyChange, StrategyItem, StrategyHorizon } from '@lifementor/core';
import { Btn, Card, Empty, Field, Modal, PageHead, Select, Spinner, Tag, TextArea, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { fmtDay, timeAgo } from '../lib/ru';

/**
 * Strategy screen (req. 45, 46, 79–81).
 *
 * The engine existed from phase 7 but nothing in the UI called it: the horizon ladder, the option
 * comparison and the immutable change history were unreachable. This screen makes them usable:
 *
 *  • the ladder 3–5 years → 1 year → 3 months → 1 month → 1 week → today → now, each level holding
 *    the directions the user (not the model) confirmed;
 *  • every change of direction is written to `strategy_changes` and shown below — nothing is
 *    overwritten silently;
 *  • the option comparison (career / freelance / business / digital product / investment / study)
 *    scores each option against the user's *own* stated time, capital and risk tolerance, and says
 *    in words why. It never claims an option is objectively better and never promises income.
 */

const HORIZON_LABEL: Record<StrategyHorizon, string> = {
  '3-5y': '3–5 лет',
  '1y': 'Год',
  '3mo': '3 месяца',
  '1mo': 'Месяц',
  '1w': 'Неделя',
  today: 'Сегодня',
  now: 'Сейчас',
};

const HORIZON_HINT: Record<StrategyHorizon, string> = {
  '3-5y': 'Кем/чем вы хотите быть через несколько лет — направление, не обещание.',
  '1y': 'Что должно быть правдой через год, чтобы дальний горизонт оставался возможным.',
  '3mo': 'Какой результат квартала двигает год.',
  '1mo': 'Что нужно успеть за месяц.',
  '1w': 'Фокус недели.',
  today: 'Что делает сегодняшний день частью стратегии.',
  now: 'Ближайшее действие, когда есть свободные 30 минут.',
};

const OPTION_KIND: Record<string, string> = {
  career: 'Работа по найму', freelance: 'Фриланс', business: 'Бизнес',
  digital_product: 'Цифровой продукт', investment: 'Инвестиции', education: 'Обучение', other: 'Другое',
};

interface OptionDraft {
  id: string;
  name: string;
  kind: string;
  risk: number;
  hours_per_week: number;
  capital_required: number;
  months_to_first_result: number;
  income_estimate: string;
  reversibility: number;
}

const EMPTY_OPTION: OptionDraft = {
  id: '', name: '', kind: 'career', risk: 3, hours_per_week: 10,
  capital_required: 0, months_to_first_result: 12, income_estimate: '', reversibility: 3,
};

export function Strategy() {
  const { app, version, mutate, toast, toastError } = useApp();
  const [ladder, setLadder] = useState<{ horizon: StrategyHorizon; items: StrategyItem[] }[] | null>(null);
  const [changes, setChanges] = useState<StrategyChange[]>([]);
  const [audit, setAudit] = useState<{ horizon: StrategyHorizon; items: number; unlinked: number; warnings: string[] }[]>([]);
  const [adding, setAdding] = useState<StrategyHorizon | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '' });
  const [dropping, setDropping] = useState<StrategyItem | null>(null);
  const [dropReason, setDropReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<OptionDraft[]>([{ ...EMPTY_OPTION, id: 'a' }]);
  const [context, setContext] = useState({ hours_per_week_available: 10, capital_available: 0, risk_tolerance: 3, horizon_months: 12 });

  const load = async () => {
    if (!app) return;
    const [l, c, a] = await Promise.all([
      app.services.strategy.ladder(),
      app.services.strategy.changes({ limit: 30 }),
      app.services.strategy.audit(),
    ]);
    setLadder(l);
    setChanges(c);
    setAudit(a);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app, version]);

  const addItem = async () => {
    if (!app || !adding || !draft.title.trim()) return;
    try {
      await mutate(async () => {
        await app.services.strategy.addItem({
          horizon: adding,
          title: draft.title.trim(),
          description: draft.description.trim() || null,
        });
      });
      setAdding(null);
      setDraft({ title: '', description: '' });
      toast('Направление добавлено в горизонт.', 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  const dropItem = async () => {
    if (!app || !dropping || dropReason.trim().length < 3) return;
    try {
      await mutate(() => app.services.strategy.drop(dropping.id, dropReason.trim()));
      setDropping(null);
      setDropReason('');
      toast('Направление закрыто — причина сохранена в истории изменений.', 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  const buildFromGoals = async () => {
    if (!app) return;
    setBusy(true);
    try {
      await mutate(() => app.services.strategy.buildFromGoals('собрано из подтверждённых целей'));
      toast('Лестница горизонтов собрана из ваших целей.', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const comparison = app && options.some((o) => o.name.trim())
    ? app.services.strategy.compareOptions(
      options.filter((o) => o.name.trim()).map((o) => ({
        name: o.name.trim(), kind: o.kind as never, risk: o.risk,
        hours_per_week: o.hours_per_week, capital_required: o.capital_required,
        months_to_first_result: o.months_to_first_result,
        income_estimate: o.income_estimate.trim() || null, reversibility: o.reversibility,
      })),
      context,
    )
    : null;

  if (!ladder) return <Spinner label="Собираю лестницу горизонтов…" />;

  const warnings = audit.flatMap((level) => level.warnings.map((w) => ({ horizon: level.horizon, text: w })));

  return (
    <div className="stack">
      <PageHead
        title="Стратегия"
        sub="Горизонты связаны между собой: дальняя цель → год → квартал → месяц → неделя → сегодня. Каждое изменение направления остаётся в истории — ничего не переписывается молча."
        actions={<Btn size="sm" onClick={() => void buildFromGoals()} disabled={busy}>Собрать из целей</Btn>}
      />

      {ladder.every((level) => level.items.length === 0) && (
        <Card>
          <Empty
            icon="◈"
            title="Стратегия пока не заполнена"
            hint="Начните с дальнего горизонта: одно-два направления на 3–5 лет, затем год. Можно нажать «Собрать из целей» — лестница построится из уже подтверждённых целей, а вы поправите формулировки."
          />
        </Card>
      )}

      {ladder.map((level) => (
        <Card
          key={level.horizon}
          title={HORIZON_LABEL[level.horizon]}
          sub={HORIZON_HINT[level.horizon]}
          action={<Btn size="sm" kind="ghost" onClick={() => { setAdding(level.horizon); setDraft({ title: '', description: '' }); }}>+ направление</Btn>}
        >
          {level.items.length === 0 && <div className="small muted">Пока пусто.</div>}
          <div className="stack" style={{ gap: 8 }}>
            {level.items.map((item) => (
              <div className="row" key={item.id} style={{ alignItems: 'flex-start', gap: 10 }}>
                <div className="grow">
                  <b>{item.title}</b>
                  {item.description && <div className="small muted">{item.description}</div>}
                  <div className="row xsmall muted" style={{ gap: 8 }}>
                    {item.goal_id ? <Tag>связано с целью</Tag> : <Tag tone="warn">не связано с целью</Tag>}
                    {item.review_at && <span>пересмотр: {fmtDay(item.review_at)}</span>}
                    <span>изменено {timeAgo(item.updated_at)}</span>
                  </div>
                </div>
                <Btn size="xs" kind="ghost" onClick={() => { setDropping(item); setDropReason(''); }}>Закрыть</Btn>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {warnings.length > 0 && (
        <Card title="Проверка связности" sub="Где лестница пока не держится — честно, а не молча.">
          <div className="stack" style={{ gap: 6 }}>
            {warnings.map((warning, index) => (
              <div key={index} className="small">
                <b>{HORIZON_LABEL[warning.horizon]}:</b> {warning.text}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Варианты будущего"
        sub="Сравнение считается по вашим же ограничениям: сколько часов в неделю у вас есть, какой капитал доступен, какой риск вы готовы принять. Это не прогноз успеха и не финансовый совет."
      >
        <div className="grid cols-4" style={{ gap: 10 }}>
          <Field label="Часов в неделю"><TextInput type="number" value={String(context.hours_per_week_available)} onChange={(e) => setContext({ ...context, hours_per_week_available: Number(e.target.value) || 0 })} /></Field>
          <Field label="Доступный капитал"><TextInput type="number" value={String(context.capital_available)} onChange={(e) => setContext({ ...context, capital_available: Number(e.target.value) || 0 })} /></Field>
          <Field label="Готовность к риску (1–5)"><TextInput type="number" min="1" max="5" value={String(context.risk_tolerance)} onChange={(e) => setContext({ ...context, risk_tolerance: Math.min(5, Math.max(1, Number(e.target.value) || 3)) })} /></Field>
          <Field label="Горизонт, месяцев"><TextInput type="number" value={String(context.horizon_months)} onChange={(e) => setContext({ ...context, horizon_months: Number(e.target.value) || 0 })} /></Field>
        </div>

        <div className="stack mt" style={{ gap: 10 }}>
          {options.map((option, index) => (
            <div className="grid cols-4" key={option.id} style={{ gap: 10, alignItems: 'end' }}>
              <Field label="Вариант">
                <TextInput value={option.name} placeholder="Например: фриланс на 10 ч/нед" onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, name: e.target.value } : o))} />
              </Field>
              <Field label="Тип">
                <Select value={option.kind} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, kind: e.target.value } : o))}>
                  {Object.entries(OPTION_KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              </Field>
              <Field label="Часов в неделю">
                <TextInput type="number" value={String(option.hours_per_week)} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, hours_per_week: Number(e.target.value) || 0 } : o))} />
              </Field>
              <Field label="Риск (1–5)">
                <TextInput type="number" min="1" max="5" value={String(option.risk)} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, risk: Math.min(5, Math.max(1, Number(e.target.value) || 3)) } : o))} />
              </Field>
              <Field label="Нужен капитал">
                <TextInput type="number" value={String(option.capital_required)} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, capital_required: Number(e.target.value) || 0 } : o))} />
              </Field>
              <Field label="Первый результат, месяцев">
                <TextInput type="number" value={String(option.months_to_first_result)} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, months_to_first_result: Number(e.target.value) || 0 } : o))} />
              </Field>
              <Field label="Доход (оценка, не обещание)">
                <TextInput value={option.income_estimate} placeholder="например: сопоставимо с текущим" onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, income_estimate: e.target.value } : o))} />
              </Field>
              <Field label="Легко выйти? (1–5)">
                <div className="row" style={{ gap: 6 }}>
                  <TextInput type="number" min="1" max="5" value={String(option.reversibility)} onChange={(e) => setOptions(options.map((o, i) => i === index ? { ...o, reversibility: Math.min(5, Math.max(1, Number(e.target.value) || 3)) } : o))} />
                  {options.length > 1 && <Btn size="xs" kind="ghost" onClick={() => setOptions(options.filter((_, i) => i !== index))} aria-label="Убрать вариант">✕</Btn>}
                </div>
              </Field>
            </div>
          ))}
          <div>
            <Btn size="sm" onClick={() => setOptions([...options, { ...EMPTY_OPTION, id: `o${Date.now()}` }])}>+ вариант</Btn>
          </div>
        </div>

        {comparison && comparison.ranking.length > 0 && (
          <div className="mt stack" style={{ gap: 8 }}>
            {comparison.ranking.map((row) => (
              <div key={row.name} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Tag tone="ok">{Math.round(row.fit_score * 100)}%</Tag>
                <div className="grow">
                  <b>{row.name}</b>
                  <div className="small muted">{row.why}</div>
                </div>
              </div>
            ))}
            <div className="xsmall muted">
              {comparison.caveats.map((caveat) => <div key={caveat}>• {caveat}</div>)}
            </div>
          </div>
        )}
      </Card>

      <Card title="История изменений" sub="Кто и почему изменил направление — восстановимо, ничего не пропадает.">
        {changes.length === 0 && <div className="small muted">Изменений пока нет.</div>}
        <div className="stack" style={{ gap: 8 }}>
          {changes.map((change) => (
            <div key={change.id} className="small">
              <b>{fmtDay(change.created_at.slice(0, 10))}</b> · {change.entity_type}
              {change.field ? ` · ${change.field}` : ''}: {change.old_value ? `${change.old_value} → ` : ''}{change.new_value ?? '—'}
              <div className="xsmall muted">{change.reason} · {change.actor === 'ai' ? 'предложено ИИ' : change.actor === 'sync' ? 'синхронизация' : 'вы'}</div>
            </div>
          ))}
        </div>
      </Card>

      {adding && (
        <Modal
          title={`Новое направление: ${HORIZON_LABEL[adding]}`}
          onClose={() => setAdding(null)}
          footer={<>
            <Btn onClick={() => setAdding(null)}>Отмена</Btn>
            <Btn kind="primary" onClick={() => void addItem()} disabled={!draft.title.trim()}>Добавить</Btn>
          </>}
        >
          <Field label="Формулировка">
            <TextInput value={draft.title} placeholder="Что для вас правда на этом горизонте" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="Пояснение (необязательно)">
            <TextArea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <div className="small muted mt-sm">{HORIZON_HINT[adding]}</div>
        </Modal>
      )}

      {dropping && (
        <Modal
          title={`Закрыть направление: ${dropping.title}`}
          onClose={() => setDropping(null)}
          footer={<>
            <Btn onClick={() => setDropping(null)}>Отмена</Btn>
            <Btn kind="danger" onClick={() => void dropItem()} disabled={dropReason.trim().length < 3}>Закрыть направление</Btn>
          </>}
        >
          <Field label="Почему закрываем (сохранится в истории)">
            <TextInput value={dropReason} placeholder="Например: выбрал другое направление" onChange={(e) => setDropReason(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
