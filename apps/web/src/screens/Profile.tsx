import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Memory, ScoredMemory, UserModel } from '@lifementor/core';
import { Btn, Card, Confirm, Empty, I, PageHead, Spinner, Tag, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { SECTION_RU, modelLabelRu, modelValueRu } from '../lib/onboarding-ru';
import { KIND_RU, timeAgo } from '../lib/ru';

export function Profile() {
  const { app, version, mutate, toast, auth } = useApp();
  const navigate = useNavigate();
  const [model, setModel] = useState<UserModel | null>(null);
  const [memories, setMemories] = useState<Awaited<ReturnType<import('@lifementor/core').MemoryService['viewerData']>> | null>(null);
  const [persona, setPersona] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ScoredMemory[] | null>(null);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    (async () => {
      try {
        const [m, mem, p] = await Promise.all([
          app.services.profile.model(),
          app.services.memory.viewerData(),
          app.services.personalization.describe(),
        ]);
        if (!stop) { setModel(m); setMemories(mem); setPersona(p); }
      } catch (e) { console.error(e); }
    })();
    return () => { stop = true; };
  }, [app, version]);

  // Search across long-term memory (req. 51–53): the user must be able to ask "what do you know
  // about X" themselves, not only through the AI. It searches by words *and* by meaning, says
  // which one matched, and every hit keeps its confirm/mark-wrong/delete controls.
  useEffect(() => {
    if (!app) return;
    const text = query.trim();
    if (text.length < 2) { setResults(null); return; }
    let stop = false;
    const timer = window.setTimeout(() => {
      app.services.memory.search(text, { limit: 10, includeUnconfirmed: true })
        .then((found) => { if (!stop) setResults(found); })
        .catch(() => { if (!stop) setResults([]); });
    }, 250);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [app, query]);

  // `memory.search` is built for the AI context: when nothing matches it still returns the most
  // important/recent memories so the model has *something*. A search box must not do that — it
  // would answer "зыбучий песок на Марсе" with the user's goals as if they matched. Only hits with
  // a real match reason are shown, and the reason is stated.
  const hits = results?.filter((m) => m.matched_by.includes('semantic') || m.matched_by.includes('keyword')) ?? null;

  if (!model || !memories) return <Spinner label="Открываю профиль…" />;

  const grouped = Object.entries(model.sections).filter(([, items]) => items.length > 0);

  return (
    <div>
      <PageHead title="Мой профиль" sub="Что система знает о вас — и что она думает (предположения помечены отдельно)." />

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr', alignItems: 'start' }}>
        <div className="stack">
          <Card title="Модель пользователя" sub={`${model.field_count} фактов · подтверждено ${Math.round(model.confirmed_ratio * 100)}%`}>
            {grouped.length === 0 && <div className="small muted">Модель пуста — она заполняется на onboarding и в диалогах.</div>}
            {grouped.map(([section, items]) => (
              <div key={section} style={{ marginBottom: 12 }}>
                <div className="section-title" style={{ marginTop: 4 }}>{SECTION_RU[section] ?? section}</div>
                {items.map((f) => (
                  <div key={f.id} className="row" style={{ gap: 10, padding: '5px 0', alignItems: 'flex-start' }}>
                    <div className="grow">
                      <span className="small muted">{modelLabelRu(f.key, f.label ?? f.key)}</span>
                      <div className="small" style={{ fontWeight: 560 }}>
                        {typeof f.value === 'object' && f.value !== null && !Array.isArray(f.value)
                          ? JSON.stringify(f.value)
                          : modelValueRu(f.value)}
                      </div>
                    </div>
                    <Tag tone={f.source === 'ai_inferred' ? 'gold' : f.source === 'system_observed' ? 'violet' : 'green'}>
                      {KIND_RU[f.source] ?? f.source}
                    </Tag>
                    {f.confidence !== 'confirmed' && <Tag tone="outline">{f.confidence === 'inferred' ? 'предположение' : 'неясно'}</Tag>}
                    <div className="row">
                      <Btn kind="ghost" size="xs" title="Подтвердить как факт" onClick={() => void mutate(() => app!.services.profile.confirm(f.id), 'Подтверждено')}>✓</Btn>
                      <Btn kind="ghost" size="xs" title="Отметить как неверное" onClick={() => void mutate(() => app!.services.profile.markWrong(f.id), 'Отмечено как неверное — наставник это учтёт')}>✗</Btn>
                      <Btn kind="ghost" size="xs" title="Удалить" onClick={() => void mutate(() => app!.services.profile.remove(f.section, f.key), 'Удалено из модели')}>{I.trash}</Btn>
                    </div>
                  </div>
                ))}
              </div>
            ))}
            {model.unknowns.length > 0 && (
              <div className="proactive mt">
                <b>Чего система ещё не знает:</b> {model.unknowns.join(', ')}
              </div>
            )}
          </Card>

          <Card title="Что ИИ помнит" sub="Долгосрочная память: факты, предпочтения, решения, выводы. Всё можно подтвердить, пометить неверным или удалить.">
            <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по памяти: «финансы», «спорт», «что я решил про работу»"
                style={{ flex: 1, minWidth: 220 }}
              />
              {query.length > 0 && <Btn size="xs" onClick={() => setQuery('')}>Сбросить</Btn>}
            </div>
            {hits ? (
              hits.length === 0 ? (
                <div className="small muted">Ничего не нашлось. Память ищет и по словам, и по смыслу — попробуйте другой запрос.</div>
              ) : (
                <>
                  <div className="section-title" style={{ marginTop: 4 }}>Найдено ({hits.length})</div>
                  {hits.map((m) => (
                    <div key={m.id} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'flex-start' }}>
                      <div className="grow">
                        <span className="small">{m.content}</span>
                        <span className="xsmall muted">
                          {' · '}{KIND_RU[m.source] ?? m.source}
                          {m.matched_by.includes('semantic') ? ' · по смыслу' : ''}
                          {m.matched_by.includes('keyword') ? ' · по словам' : ''}
                        </span>
                      </div>
                      {m.needs_confirmation === 1 && <Btn kind="ghost" size="xs" onClick={() => void mutate(() => app!.services.memory.confirm(m.id), 'Подтверждено')}>подтвердить</Btn>}
                      <Btn kind="ghost" size="xs" title="Удалить" onClick={() => setDeleting(m)}>{I.trash}</Btn>
                    </div>
                  ))}
                </>
              )
            ) : (
              <>
            <MemoryList title="Факты" items={memories.facts} onDelete={setDeleting} />
            <MemoryList title="Предпочтения" items={memories.preferences} onDelete={setDeleting} />
            <MemoryList title="Решения и смены целей" items={memories.goals} onDelete={setDeleting} />
            <MemoryList title="Выводы и поведенческие паттерны" items={memories.insights} onDelete={setDeleting} />
            {memories.assumptions.length > 0 && (
              <div className="proactive" style={{ background: 'var(--gold-soft)', borderColor: '#e4d3a1' }}>
                <b>Предположения ИИ ({memories.assumptions.length}):</b>
                {memories.assumptions.slice(0, 6).map((m) => <div key={m.id} className="small mt-sm">• {m.content} — подтвердите, если верно</div>)}
              </div>
            )}
              </>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Учётная запись">
            <div className="kv">
              <dt>Email</dt><dd>{auth?.email ?? 'нет аккаунта (офлайн)'}</dd>
              <dt>Устройства</dt><dd>{auth ? 'синхронизация включена' : 'только это устройство'}</dd>
              <dt>Режим</dt><dd>{app!.ai.isOffline ? 'офлайн-ИИ (локальный движок)' : 'облачный ИИ через сервер'}</dd>
            </div>
            <div className="row mt">
              {!auth?.authenticated && <Btn size="sm" kind="primary" onClick={() => navigate('/auth')}>Войти / регистрация</Btn>}
              {auth?.authenticated && (
                <Btn size="sm" kind="danger" onClick={() => void mutate(() => app!.services.auth.signOut(), 'Вы вышли из аккаунта. Локальные данные сохранены.')}>Выйти</Btn>
              )}
            </div>
          </Card>

          <Card title="О чём я знаю о ваших паттернах" sub="Персонализация: накапливается из множества событий, не из одного">
            {persona.length === 0 && <div className="small muted">Паттернов пока мало — система начинает делать выводы только после нескольких подтверждённых событий (req. 29).</div>}
            {persona.map((p) => <div key={p} className="small" style={{ padding: '3px 0' }}>• {p}</div>)}
          </Card>

          <Card title="История изменений модели" sub="Каждое изменение стратегии сохраняется (старое → новое → причина → дата)">
            <div className="small muted">Открывается в настройках → Диагностика и в истории изменений базы.</div>
          </Card>
        </div>
      </div>

      {deleting && (
        <Confirm title="Удалить из памяти?" text={deleting.content}
          onConfirm={() => void mutate(() => app!.services.memory.remove(deleting.id), 'Удалено из памяти')}
          onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function MemoryList({ title, items, onDelete }: { title: string; items: Memory[]; onDelete: (m: Memory) => void }) {
  const { app, mutate, toast } = useApp();
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="section-title" style={{ marginTop: 4 }}>{title}</div>
      {items.slice(0, 12).map((m) => (
        <div key={m.id} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'flex-start' }}>
          <div className="grow">
            <span className="small">{m.content}</span>
            <span className="xsmall muted"> · {KIND_RU[m.source] ?? m.source}{m.updated_at ? ` · ${timeAgo(m.updated_at)}` : ''}</span>
          </div>
          {m.needs_confirmation === 1 && <Btn kind="ghost" size="xs" onClick={() => void mutate(() => app!.services.memory.confirm(m.id), 'Подтверждено')}>подтвердить</Btn>}
          <Btn kind="ghost" size="xs" onClick={() => void mutate(() => app!.services.memory.markUncertain(m.id), 'Помечено неопределённым').then(() => toast('Теперь система относится к этому осторожно.', 'info'))}>? </Btn>
          <Btn kind="ghost" size="xs" onClick={() => onDelete(m)}>{I.trash}</Btn>
        </div>
      ))}
      {items.length > 12 && <div className="xsmall muted">и ещё {items.length - 12}…</div>}
    </div>
  );
}
