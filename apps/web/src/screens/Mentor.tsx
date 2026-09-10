import React, { useEffect, useRef, useState } from 'react';
import type { Message, TurnResult } from '@lifementor/core';
import { Btn, I, Spinner, TextArea, Tag } from '../components/ui';
import { useApp } from '../state/store';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; ok: boolean; detail?: string }[];
  meta?: string;
}

const TOOL_RU: Record<string, string> = {
  get_user_profile: 'читал профиль',
  get_user_memory: 'заглянул в память',
  create_goal: 'создал цель',
  update_goal: 'обновил цель',
  archive_goal: 'архивировал цель',
  get_skills: 'просмотрел навыки',
  assess_skill: 'оценил навык',
  create_task: 'создал задачу',
  complete_task: 'завершил задачу',
  reschedule_task: 'перенёс задачу',
  create_calendar_event: 'добавил событие',
  update_calendar_event: 'изменил событие',
  get_schedule: 'просмотрел расписание',
  rebuild_schedule: 'пересобрал день',
  create_learning_path: 'создал путь обучения',
  update_learning_progress: 'обновил прогресс обучения',
  get_project: 'открыл проект',
  update_project: 'обновил проект',
  create_notification: 'поставил напоминание',
  get_recent_news: 'посмотрел новости',
  get_important_news: 'посмотрел важные новости',
  save_memory: 'запомнил',
  update_memory: 'обновил память',
  delete_memory: 'удалил из памяти',
  suggest_learning: 'предложил обучение',
  get_progress: 'посмотрел прогресс',
};

export function Mentor() {
  const { app, mutate, toast, online } = useApp();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proactive, setProactive] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const booted = useRef(false);
  const draftBooted = useRef(false);
  const draftSaved = useRef(false);

  // Load conversation history + a proactive message (once per mount).
  useEffect(() => {
    if (!app || booted.current) return;
    booted.current = true;
    (async () => {
      try {
        const conv = await app.ai.conversations.resume('mentor');
        setConvId(conv.id);
        const history = await app.ai.conversations.history(conv.id, 30);
        setMessages(historyToChat(history));
      } catch { /* fresh start */ }
      try {
        const triggers = await app.ai.mentor.evaluateTriggers();
        if (triggers.length) {
          const t = triggers[0];
          setProactive(`${t.title}. ${t.body}`);
        }
      } catch { /* non-fatal */ }
    })();
  }, [app]);

  // An unsent message must not die with the process (req. 13): it is written to `app_state` while
  // the user types and comes back on the next launch, marked as a restored draft.
  useEffect(() => {
    if (!app || draftBooted.current) return;
    draftBooted.current = true;
    void app.services.recovery.readDraft<{ text?: string }>('mentor').then((draft) => {
      const text = draft?.text;
      if (typeof text === 'string' && text.trim()) {
        draftSaved.current = true;
        setInput(text);
        setDraftRestored(true);
      }
    }).catch(() => undefined);
  }, [app]);

  useEffect(() => {
    if (!app) return;
    const text = input.trim();
    if (!text) return;
    const timer = window.setTimeout(() => {
      draftSaved.current = true;
      void app.services.recovery.saveDraft('mentor', { text }).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [app, input]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Guarded on purpose: a missing `Element.scrollTo` (older Android WebViews, non-browser DOM
    // hosts) must never take down the chat screen — the rest of the app keeps working.
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!app || !content || busy) return;
    setInput('');
    setDraftRestored(false);
    if (draftSaved.current) {
      draftSaved.current = false;
      void app.services.recovery.clearDraft('mentor').catch(() => undefined);
    }
    const userMsg: ChatMsg = { id: `u${Date.now()}`, role: 'user', text: content };
    setMessages((m) => [...m, userMsg]);
    setBusy(true);
    try {
      const turn: TurnResult = await app.ai.mentor.chat(content, {
        conversationId: convId ?? undefined,
        onDelta: undefined,
      });
      setConvId(turn.conversationId);
      const assistant: ChatMsg = {
        id: turn.messageId,
        role: 'assistant',
        text: turn.reply,
        tools: turn.toolCalls.map((tc) => ({
          name: tc.call.name,
          ok: tc.outcome.ok,
          detail: tc.outcome.ok ? undefined : tc.outcome.message,
        })),
        meta: [
          turn.offline ? 'офлайн-движок' : `модель: ${turn.model}`,
          turn.usage.latencyMs ? `${Math.round(turn.usage.latencyMs / 100) / 10} с` : null,
          turn.memoriesSaved.length ? `в память: ${turn.memoriesSaved.length}` : null,
        ].filter(Boolean).join(' · '),
      };
      setMessages((m) => [...m, assistant]);
      if (turn.needsInput) setProactive(turn.needsInput);
    } catch (error) {
      const msg = error && typeof error === 'object' && 'userMessage' in error
        ? String((error as { userMessage: unknown }).userMessage)
        : error instanceof Error ? error.message : 'Не удалось получить ответ';
      setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'assistant', text: `⚠ ${msg}\nМои инструменты и локальные данные при этом работают — попробуйте повторить.` }]);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-wrap" style={{ height: '100%' }}>
      {proactive && (
        <div className="proactive">
          <b>Наставник:</b> {proactive}
          <button type="button" className="btn ghost sm" style={{ marginLeft: 10, color: 'inherit' }} onClick={() => setProactive(null)}>{I.x}</button>
        </div>
      )}
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="empty" style={{ maxWidth: 560, margin: '40px auto' }}>
            <div className="empty-ico">✦</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Спросите меня о чём угодно</div>
            <div className="small muted">
              Я помню ваши цели, задачи, навыки и расписание. Могу создать задачу или событие,
              пересобрать день, оценить навык, составить план обучения — всё выполняется
              инструментами прямо в вашей локальной базе, а не «на словах».
            </div>
            <div className="suggest-chips" style={{ justifyContent: 'center', marginTop: 14 }}>
              {['Спланируй мой день', 'Что я должен сделать, чтобы двигаться к своей главной цели?', 'Какие у меня слабые места в навыках?', 'Составь план обучения на ближайший месяц'].map((s) => (
                <Btn key={s} size="sm" onClick={() => void send(s)}>{s}</Btn>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === 'assistant' && (m.tools?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 6 }}>
                {m.tools!.map((t, i) => (
                  <span key={i} className={`tool-chip ${t.ok ? '' : 'warn'}`}>{t.ok ? '✓' : '⚠'} {TOOL_RU[t.name] ?? t.name}{t.detail ? ` — ${t.detail}` : ''}</span>
                ))}
              </div>
            )}
            {m.text}
            {m.meta && <div className="msg-meta">{m.meta}</div>}
          </div>
        ))}
        {busy && <div className="msg assistant"><span className="spin" style={{ marginRight: 8 }} /> думаю и проверяю ваши данные…</div>}
      </div>
      {draftRestored && (
        <div className="row wrap" style={{ padding: '8px 0 0', gap: 8 }}>
          <Tag tone="gold">черновик восстановлен</Tag>
          <span className="xsmall muted grow">Набранное сообщение пережило перезапуск.</span>
          <Btn size="xs" onClick={() => {
            draftSaved.current = false;
            setDraftRestored(false);
            setInput('');
            void app?.services.recovery.clearDraft('mentor').catch(() => undefined);
            toast('Черновик удалён');
          }}>Очистить</Btn>
        </div>
      )}
      <div className="chat-input-row">
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Например: завтра в 15:00 экзамен по математике, перенеси подготовку"
          style={{ flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <Btn kind="primary" onClick={() => void send()} disabled={busy || !input.trim()}>Отправить</Btn>
      </div>
      <div className="row" style={{ padding: '8px 0 4px', gap: 8 }}>
        <Tag tone={app?.ai.isOffline ? 'gold' : 'green'}>{app?.ai.isOffline ? 'офлайн-движок' : 'облачный ИИ'}</Tag>
        {!online && <Tag tone="p1">без сети — работают локальные инструменты</Tag>}
        <span className="xsmall muted grow">Ключи ИИ хранятся только на сервере; данные — только у вас.</span>
      </div>
    </div>
  );
}

function historyToChat(history: Message[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const m of history) {
    if (m.role === 'user' && m.content) out.push({ id: m.id, role: 'user', text: m.content });
    if (m.role === 'assistant' && m.content) {
      let tools: ChatMsg['tools'];
      if (m.tool_calls) {
        try {
          const calls = JSON.parse(m.tool_calls) as { name: string }[];
          tools = calls.map((c) => ({ name: c.name, ok: true }));
        } catch { tools = undefined; }
      }
      out.push({ id: m.id, role: 'assistant', text: m.content, tools });
    }
  }
  return out;
}
