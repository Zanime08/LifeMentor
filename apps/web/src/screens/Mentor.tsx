import React, { useEffect, useRef, useState } from 'react';
import type { ConfirmationRequest, Message, NeedsInputItem, TurnResult } from '@lifementor/core';
import { Btn, I, Spinner, TextArea, Tag } from '../components/ui';
import { useApp } from '../state/store';
import { bestEffort } from '../lib/load';
import { confirmationText } from '../lib/confirm-ru';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: { name: string; ok: boolean; detail?: string }[];
  meta?: string;
}

/**
 * What the mentor did, in the user's words (phase-20 i18n).
 *
 * The chips under an answer name the tools the model actually ran. The names are engine identifiers
 * (`plan_day`, `create_calendar_event`) and the list had drifted: it labelled eleven tools that no
 * longer exist and left fourteen real ones (including `plan_day` and `send_notification`) showing
 * their raw snake_case name in the chat. `mentor-tools-ru.test.ts` reads the registry and fails if a
 * tool ever lacks a label again.
 */
const TOOL_RU: Record<string, string> = {
  // reading
  get_user_model: 'посмотрел профиль',
  get_user_profile: 'посмотрел профиль',
  get_user_memory: 'заглянул в память',
  get_preferences: 'посмотрел настройки',
  get_progress: 'посмотрел прогресс',
  get_goals: 'посмотрел цели',
  get_tasks: 'посмотрел задачи',
  get_schedule: 'посмотрел расписание',
  get_skills: 'посмотрел навыки',
  get_learning: 'посмотрел обучение',
  get_news: 'посмотрел новости',
  search_knowledge: 'поискал в знаниях',
  // goals & tasks
  create_goal: 'создал цель',
  update_goal: 'обновил цель',
  create_task: 'создал задачу',
  update_task: 'изменил задачу',
  complete_task: 'завершил задачу',
  cancel_task: 'отменил задачу',
  reschedule_task: 'перенёс задачу',
  plan_day: 'построил план дня',
  // schedule
  create_calendar_event: 'добавил событие',
  delete_calendar_event: 'удалил событие',
  // learning, projects, skills
  create_learning_path: 'создал путь обучения',
  update_learning_progress: 'обновил прогресс обучения',
  create_project: 'создал проект',
  assess_skill: 'оценил навык',
  // memory & messages
  save_memory: 'запомнил',
  delete_memory: 'удалил из памяти',
  update_user_model: 'поправил профиль',
  send_notification: 'поставил напоминание',
};

/**
 * The refusal reasons the notification gate reports. The engine sends the model an English sentence
 * («Not sent — the notification gate refused it (budget_exhausted)…») and that sentence used to be
 * printed into the chip verbatim; the user gets the reason in their own language and the engine's
 * wording stays in the console.
 */
const NOTIFICATION_REFUSAL_RU: Record<string, string> = {
  disabled: 'уведомления выключены в настройках',
  type_disabled: 'этот вид уведомлений выключен',
  budget_exhausted: 'дневной лимит уведомлений исчерпан',
  duplicate: 'такое напоминание уже было недавно',
  invalid: 'напоминание не прошло проверку',
};

/**
 * Why a tool did not work, as far as the user needs to know.
 *
 * The engine's own sentences are addressed to the model — the one for «which task did you mean»
 * literally tells it to ask instead of guessing — so the chip says what happened, in Russian, and the
 * reason the tool is waiting for an answer names the words the user actually used.
 */
function failureDetail(outcome: { message: string; data?: unknown; needsInput?: string; needs_input_item?: NeedsInputItem; error?: string }): string | undefined {
  const data = outcome.data as { reason?: string } | undefined;
  if (data?.reason && NOTIFICATION_REFUSAL_RU[data.reason]) return NOTIFICATION_REFUSAL_RU[data.reason];
  if (outcome.needs_input_item) return needsInputDetail(outcome.needs_input_item);
  if (outcome.needsInput) return 'нужно уточнить детали';
  if (outcome.error) return 'не получилось — причина в журнале';
  return undefined;
}

/** «Под «хлеб» подходит несколько задач» — short enough for a chip, still about the user's words. */
function needsInputDetail(item: NeedsInputItem): string {
  return item.code === 'ambiguous'
    ? `под «${item.ref}» подходит несколько — уточните`
    : `не нашёл по «${item.ref}» — уточните название`;
}


export function Mentor() {
  const { app, mutate, toast, toastError, refresh, online } = useApp();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proactive, setProactive] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(null);
  /**
   * Calls the model proposed and the engine refuses to run without the user's word — deleting an
   * event, cancelling a task, archiving a goal, raising a task to P0. The registry produced the
   * question, the interface never showed it, and the answer never existed: those tools could not run
   * at all, no matter how many times the user said «да, удали».
   */
  const [pending, setPending] = useState<ConfirmationRequest[]>([]);
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
        const restored = historyToChat(history);
        setMessages(restored.messages);
        // The question the last turn ended on is still open: put it back in front of the user.
        if (restored.pending.length) setPending(restored.pending);
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
    }).catch((error: unknown) => console.warn('[lifementor] chat draft failed (non-fatal):', error instanceof Error ? error.message : error));
  }, [app]);

  useEffect(() => {
    if (!app) return;
    const text = input.trim();
    if (!text) return;
    const timer = window.setTimeout(() => {
      draftSaved.current = true;
      bestEffort(app.services.recovery.saveDraft('mentor', { text }), 'chat draft save');
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
      bestEffort(app.services.recovery.clearDraft('mentor'), 'chat draft clear');
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
          detail: tc.outcome.ok ? undefined : failureDetail(tc.outcome),
        })),
        meta: [
          turn.offline ? 'офлайн-движок' : `модель: ${turn.model}`,
          turn.usage.latencyMs ? `${Math.round(turn.usage.latencyMs / 100) / 10} с` : null,
          turn.memoriesSaved.length ? `в память: ${turn.memoriesSaved.length}` : null,
        ].filter(Boolean).join(' · '),
      };
      setMessages((m) => [...m, assistant]);
      setPending(turn.confirmations ?? []);
      // No banner for a question: the reply already asks it, in the reader's language, through
      // `needsInputItemText` — the raw `needsInput` is an instruction written for the model.
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

  /**
   * The user's decision about one proposed call. Approving runs exactly the call the model proposed
   * (the engine already recorded it); refusing records that nothing was done, so the next turn does
   * not silently repeat the proposal.
   */
  const decide = async (request: ConfirmationRequest, approved: boolean) => {
    if (!app || !convId) return;
    setBusy(true);
    try {
      const result = await app.ai.orchestrator.resolveConfirmation(request, {
        approved,
        conversationId: convId,
        // The engine stores this sentence in the conversation; the wording belongs here.
        replyText: approved ? `Готово: ${TOOL_RU[request.tool] ?? request.tool}.` : 'Отменено — ничего не менял.',
      });
      if (approved && !result.ok) {
        // A refusal after approval is a real failure the user must see (it changes nothing).
        setMessages((m) => [...m, { id: result.messageId, role: 'assistant', text: `⚠ Не получилось: ${TOOL_RU[request.tool] ?? request.tool}.`, tools: [{ name: request.tool, ok: false, detail: failureDetail(result.outcome ?? { message: '' }) }] }]);
      } else {
        setMessages((m) => [...m, { id: result.messageId, role: 'assistant', text: result.reply, tools: [{ name: request.tool, ok: result.ok }] }]);
      }
      setPending((list) => list.filter((c) => c.id !== request.id));
      refresh();
    } catch (error) {
      toastError(error);
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
      {pending.length > 0 && (
        <div className="proactive" style={{ background: 'var(--gold-soft)', borderColor: '#e4d3a1' }} role="group" aria-label="Нужно ваше решение">
          {pending.map((request) => (
            <div key={request.id} className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="grow">
                <b>Нужно ваше решение{request.risk === 'destructive' ? ' — действие необратимо' : ''}</b>
                {/* The engine's own `detail` is written for the model, in English — the question the
                    user reads is composed here from the tool and the arguments. */}
                <div className="small">{confirmationText(request, TOOL_RU[request.tool])}</div>
              </div>
              <Btn kind="primary" size="sm" disabled={busy} onClick={() => void decide(request, true)}>Разрешить</Btn>
              <Btn size="sm" disabled={busy} onClick={() => void decide(request, false)}>Отменить</Btn>
            </div>
          ))}
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
                  // A failed call says what went wrong, not «отменил задачу» with a warning sign —
                  // the label is written in the past tense of a success.
                  <span key={i} className={`tool-chip ${t.ok ? '' : 'warn'}`}>
                    {t.ok ? `✓ ${TOOL_RU[t.name] ?? t.name}` : `⚠ ${t.detail ?? TOOL_RU[t.name] ?? t.name}`}
                  </span>
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
            if (app) bestEffort(app.services.recovery.clearDraft('mentor'), 'chat draft clear');
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

/**
 * Turn stored messages into what the chat renders.
 *
 * Two things were being lost on the way back from the database. A tool chip was always drawn as a
 * success (`ok: true`), so a failed call — a refused notification, a rejected time slot — looked
 * like it had worked once the screen was reopened. And a question waiting for the user's decision
 * (`turn.confirmations`) lived only in React state, so closing the app silently cancelled it.
 * The question is restored only when it is the last thing in the conversation: answering it always
 * appends the tool row and the answer afterwards.
 */
function historyToChat(history: Message[]): { messages: ChatMsg[]; pending: ConfirmationRequest[] } {
  const out: ChatMsg[] = [];
  let pending: ConfirmationRequest[] = [];
  for (const m of history) {
    if (m.role === 'user' && m.content) out.push({ id: m.id, role: 'user', text: m.content });
    if (m.role === 'assistant' && m.content) {
      let tools: ChatMsg['tools'];
      let unanswered: ConfirmationRequest[] = [];
      if (m.tool_calls) {
        try {
          const calls = JSON.parse(m.tool_calls) as { name: string; ok?: boolean; confirmation?: ConfirmationRequest; needsInputItem?: NeedsInputItem }[];
          tools = calls.map((c) => ({
            name: c.name,
            ok: c.ok !== false,
            detail: c.ok === false && c.needsInputItem ? needsInputDetail(c.needsInputItem) : undefined,
          }));
          unanswered = calls.map((c) => c.confirmation).filter((c): c is ConfirmationRequest => Boolean(c));
        } catch (error) {
          // The message itself is fine; only its tool chips are unreadable. Say so in the console
          // rather than rendering a message that looks like it ran no tools at all.
          console.warn('[lifementor] tool list failed (non-fatal):', error instanceof Error ? error.message : error);
          tools = undefined;
        }
      }
      out.push({ id: m.id, role: 'assistant', text: m.content, tools });
      // A later message means the user did answer (or asked something else) — the card is not shown.
      pending = unanswered;
    } else if (m.role === 'user' || m.role === 'tool') {
      pending = [];
    }
  }
  return { messages: out, pending };
}
