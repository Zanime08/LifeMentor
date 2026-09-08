import type { z } from 'zod';
import type { AIProvider, GenerationRequest, GenerationResult, JsonSchema, ProviderCapabilities, StreamDelta, ToolCallRequest } from '../types';
import { estimateTokens } from '../types';
import { newId } from '../../util/id';

/**
 * Local heuristic provider — a real, deterministic, fully offline AI engine.
 *
 * It is a first-class `AIProvider` (req. 21 lists "local model" as a valid provider), not a stub:
 *  - it parses intent from the user's message and emits real tool calls;
 *  - it answers from the context packet produced by the Context Engine;
 *  - it extracts memories/goals with rule-based NLP;
 *  - it produces genuine 128-dim hashed embeddings so semantic memory retrieval works offline.
 *
 * It is used when no server/API key is configured, when the device is offline, and in tests.
 * The UI labels these answers "offline mentor" so a heuristic answer is never mistaken for a
 * large-model answer.
 */
export class LocalHeuristicProvider implements AIProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    structured: true,
    embeddings: true,
    tools: true,
    maxContextTokens: 8000,
  };

  constructor(private readonly options: { language?: string; id?: string } = {}) {
    this.id = options.id ?? 'local-heuristic';
  }

  /** Always available: no key, no network. */
  isAvailable(): boolean { return true; }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    const userText = lastUserText(request.messages);
    const context = systemContext(request.messages);
    const intent = (request.intent as LocalIntent | undefined) ?? detectIntent(userText);

    const toolCalls: ToolCallRequest[] = request.tools?.length && !request.jsonSchema ? matchToolCalls(userText, request.tools.map((t) => t.name)) : [];
    const text = toolCalls.length
      ? acknowledgementFor(toolCalls, userText)
      : request.jsonSchema ? '' : composeAnswer(intent, userText, context, this.options.language ?? 'en');

    return {
      text,
      toolCalls,
      provider: this.id,
      model: 'heuristic-v1',
      tier: request.tier ?? 'cheap',
      usage: { promptTokens: estimateTokens(request.messages.map((m) => m.content).join('\n')), completionTokens: estimateTokens(text) },
      latencyMs: Date.now() - started,
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }

  async stream(request: GenerationRequest, onDelta: (delta: StreamDelta) => void): Promise<GenerationResult> {
    const result = await this.generate(request);
    if (result.toolCalls.length) {
      for (const call of result.toolCalls) onDelta({ toolCall: call });
      onDelta({ done: true });
      return result;
    }
    const words = result.text.split(' ');
    for (let i = 0; i < words.length; i += 4) {
      onDelta({ text: `${words.slice(i, i + 4).join(' ')} ` });
      await sleep(8);
    }
    onDelta({ done: true });
    return result;
  }

  async generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T> {
    const started = Date.now();
    const userText = lastUserText(request.messages);
    const context = systemContext(request.messages);
    const intent = (request.intent as LocalIntent | undefined) ?? detectIntent(userText);
    const payload = structuredFor(intent, userText, context, request.jsonSchema);
    const parsed = schema.safeParse(payload);
    if (parsed.success) {
      void started;
      return parsed.data;
    }
    // Second attempt: fall back to a schema-shaped default so callers always get valid data.
    const fallback = synthesizeFromSchema(request.jsonSchema ?? zodShapeHint(schema));
    const second = schema.safeParse(fallback);
    if (second.success) return second.data;
    throw new Error(`LocalHeuristicProvider could not produce valid structured output for intent "${intent}": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }

  /** Deterministic hashed bag-of-words embedding (128 dims, L2-normalised). */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => hashEmbed(text, 128));
  }
}

// ─────────────────────────── intent detection ───────────────────────────
export type LocalIntent =
  | 'next_action' | 'plan_day' | 'progress' | 'memory_review' | 'add_task' | 'complete_task'
  | 'postpone_task' | 'add_goal' | 'schedule_event' | 'log_learning' | 'news' | 'advice' | 'small_talk' | 'general';

export function detectIntent(text: string): LocalIntent {
  const t = text.toLowerCase().trim();
  if (/^(hi|hello|hey|привет|good (morning|evening|afternoon))\b/.test(t)) return 'small_talk';
  if (/(what|which).*(do|should).*(now|next)|what should i do|next step|what's next|что делать/.test(t)) return 'next_action';
  if (/plan (my|the) day|build.*schedule|what.*today|расписание|план на (день|сегодня)/.test(t)) return 'plan_day';
  if (/how (am i|is it) (doing|going)|my progress|how much.*done|stats|statistics|прогресс/.test(t)) return 'progress';
  if (/what do you (know|remember) about me|what.*remember|что ты.*знаешь обо мне/.test(t)) return 'memory_review';
  if (/(add|create|new) (a )?(task|todo)|remind me to|задача/.test(t)) return 'add_task';
  if (/(i )?(finished|completed|done|did) |mark .* (as )?(done|complete)|выполнил/.test(t)) return 'complete_task';
  if (/(postpone|move|reschedule|delay|shift) .*|перенеси/.test(t)) return 'postpone_task';
  if (/(add|create|set) (a )?goal|i want to (achieve|reach)|цель/.test(t)) return 'add_goal';
  if (/(schedule|add) (an )?(event|meeting|class|exam)|at \d{1,2}(:\d{2})?/.test(t)) return 'schedule_event';
  if (/(i )?(studied|learned|practiced|reviewed) .*|log .* minutes/.test(t)) return 'log_learning';
  if (/news|what.*happening in the world|новости/.test(t)) return 'news';
  if (/(should i|advice|suggest|recommend|how do i|help me with)/.test(t)) return 'advice';
  return 'general';
}

interface ContextSections { [heading: string]: string[] }

function systemContext(messages: GenerationRequest['messages']): ContextSections {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const sections: ContextSections = {};
  let current = 'HEADER';
  sections[current] = [];
  for (const line of system.split('\n')) {
    const heading = /^(?:#{1,3}\s*)?([A-Z][A-Z0-9 &/()\-]{3,40})\s*$/.exec(line.trim());
    if (heading && !line.trim().startsWith('-')) {
      current = heading[1].trim();
      sections[current] ??= [];
    } else if (line.trim()) {
      (sections[current] ??= []).push(line.trim());
    }
  }
  return sections;
}

function section(sections: ContextSections, ...names: string[]): string[] {
  for (const name of names) {
    const key = Object.keys(sections).find((k) => k.toLowerCase().startsWith(name.toLowerCase()));
    if (key && sections[key]?.length) return sections[key];
  }
  return [];
}

function lastUserText(messages: GenerationRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return '';
}

// ─────────────────────────── answer composition ───────────────────────────
export function composeAnswer(intent: LocalIntent, userText: string, sections: ContextSections, language = 'en'): string {
  const today = section(sections, 'TODAY', 'TODAY SCHEDULE');
  const next = section(sections, 'NEXT TASKS', 'ACTIVE TASKS');
  const goals = section(sections, 'CURRENT GOALS', 'GOALS');
  const progress = section(sections, 'RECENT PROGRESS', 'PROGRESS');
  const learning = section(sections, 'CURRENT LEARNING', 'LEARNING');
  const patterns = section(sections, 'OBSERVED PATTERNS', 'PERSONALIZATION');
  const profile = section(sections, 'USER MODEL', 'PROFILE');
  const memory = section(sections, 'RELEVANT MEMORY', 'MEMORY');
  const news = section(sections, 'NEWS', 'IMPORTANT NEWS');
  const projects = section(sections, 'ACTIVE PROJECTS', 'PROJECTS');

  switch (intent) {
    case 'small_talk':
      return `Hello. ${next[0] ? `The most useful next step is: ${stripBullet(next[0])}.` : 'Tell me what is on your mind, or ask me to plan the day.'}`;

    case 'next_action': {
      const nowSlot = today.find((line) => isUpcomingSlot(line));
      const pick = nowSlot ?? next[0] ?? today[0];
      if (!pick) return 'There is nothing scheduled and no open task. Either add a task, or tell me a goal and I will build the first step.';
      const why = patterns[0] ? ` (Note: ${stripBullet(patterns[0])})` : '';
      return `Next: ${stripBullet(pick)}${why}. Do not plan anything else until this is done — one block, then a break.`;
    }

    case 'plan_day': {
      if (!today.length) return 'Your day has no events and no scheduled tasks yet. Tell me your fixed commitments and what matters most this week, and I will build it.';
      const lines = [`Here is the day as it stands:`, ...today.slice(0, 10).map((l) => `  ${stripBullet(l)}`)];
      if (goals[0]) lines.push(`This serves: ${stripBullet(goals[0])}.`);
      if (progress[0]) lines.push(`Recent reality: ${stripBullet(progress[0])}.`);
      return lines.join('\n');
    }

    case 'progress': {
      const lines = ['What the data shows:'];
      for (const line of progress.slice(0, 5)) lines.push(`  ${stripBullet(line)}`);
      if (patterns.length) { lines.push('Patterns I have observed:'); for (const line of patterns.slice(0, 4)) lines.push(`  ${stripBullet(line)}`); }
      if (learning.length) lines.push(`Learning: ${stripBullet(learning[0])}`);
      if (lines.length === 1) return 'There is no progress data yet. Complete a task or log a study session and this becomes meaningful.';
      return lines.join('\n');
    }

    case 'memory_review': {
      const lines = ['What I currently know about you:'];
      for (const line of profile.slice(0, 12)) lines.push(`  ${stripBullet(line)}`);
      for (const line of memory.slice(0, 8)) lines.push(`  ${stripBullet(line)}`);
      lines.push('You can edit, confirm or delete any of this in Profile → "What AI knows about me". Anything marked as an assumption is my inference, not your statement.');
      return lines.join('\n');
    }

    case 'news': {
      if (!news.length) return 'No news is stored locally right now. News needs a connection to sync; everything else works offline.';
      return ['Latest items:', ...news.slice(0, 5).map((l) => `  ${stripBullet(l)}`)].join('\n');
    }

    case 'advice': {
      const lines = [`On "${truncate(userText, 120)}":`];
      if (goals[0]) lines.push(`Your stated direction is: ${stripBullet(goals[0])}. Any advice should serve that, not replace it.`);
      if (patterns[0]) lines.push(`Observed: ${stripBullet(patterns[0])}`);
      lines.push('The honest answer is usually the smallest next action you can do today, not the biggest plan you can imagine.');
      if (next[0]) lines.push(`Concretely: ${stripBullet(next[0])}.`);
      lines.push('You decide — I am here to make the trade-offs visible.');
      return lines.join('\n');
    }

    case 'add_task':
      return `Tell me the task title, roughly how long it needs, and when it should happen. Or say "add task <title> tomorrow 18:00" and I will create it.`;
    case 'complete_task':
      return `Good. Which task was it? If you name it, I will mark it done and update the progress of the project and goal it belongs to.`;
    case 'postpone_task':
      return `Which task, and to when? If it is an important one I will also ask why — not to nag you, but because the reason changes what we do next.`;
    case 'add_goal':
      return `Let us make it concrete: what exactly should be true, by when, and how will you know? Vague goals produce vague plans.`;
    case 'schedule_event':
      return `Give me the title, day and start/end time. Real events always win over study blocks — I will never schedule over them.`;
    case 'log_learning':
      return `How many minutes, and on which topic? I will update the topic progress and schedule the next recall review.`;

    default: {
      const lines: string[] = [];
      lines.push(`You said: "${truncate(userText, 160)}".`);
      if (memory[0]) lines.push(`Related to what I know: ${stripBullet(memory[0])}`);
      if (projects[0]) lines.push(`Active project: ${stripBullet(projects[0])}`);
      if (next[0]) lines.push(`The most useful thing right now is still: ${stripBullet(next[0])}.`);
      else lines.push('I do not have enough to act on yet — ask me to plan the day, or tell me a goal.');
      lines.push('(Offline heuristic mentor: short, deterministic, works without internet. Connect for the full model.)');
      return lines.join('\n');
    }
  }
}

function stripBullet(line: string): string { return line.replace(/^[-*•]\s*/, '').trim(); }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}…` : value; }
function isUpcomingSlot(line: string): boolean {
  const match = /^-?\s*(\d{2}):(\d{2})/.exec(line.trim());
  if (!match) return false;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  const now = new Date();
  return minutes >= now.getHours() * 60 + now.getMinutes() - 30;
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function acknowledgementFor(calls: ToolCallRequest[], userText: string): string {
  const names = calls.map((c) => c.name.replace(/_/g, ' ')).join(', ');
  return `On it — ${names}. (${truncate(userText, 80)})`;
}

// ─────────────────────────── tool-call matching ───────────────────────────
export function matchToolCalls(text: string, availableTools: string[]): ToolCallRequest[] {
  const t = text.trim();
  const lower = t.toLowerCase();
  const calls: ToolCallRequest[] = [];
  const has = (name: string) => availableTools.includes(name);
  const call = (name: string, args: Record<string, unknown>) => { if (has(name)) calls.push({ id: newId(), name, arguments: args }); };

  const minutesMatch = /(\d{1,3})\s*(min|minute|minutes|minuten|мин)/i.exec(lower);
  const timeMatch = /(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(lower);
  const tomorrow = /tomorrow|завтра/.test(lower);
  const today = /\btoday\b|сегодня/.test(lower);

  const addTaskMatch = /(?:add|create|new)\s+(?:a\s+)?(?:task|todo)[:\s-]+(.+)/i.exec(t) ?? /remind me to\s+(.+)/i.exec(t);
  if (addTaskMatch) {
    const title = cleanTitle(addTaskMatch[1]);
    call('create_task', {
      title,
      estimated_minutes: minutesMatch ? Number(minutesMatch[1]) : 30,
      scheduled_date: tomorrow ? 'tomorrow' : today ? 'today' : undefined,
      scheduled_start: timeMatch ? normalizeTime(timeMatch) : undefined,
    });
  }

  const completeMatch = /(?:i\s+)?(?:finished|completed|did|done)\s+(.+)/i.exec(t) ?? /mark\s+(.+?)\s+(?:as\s+)?(?:done|complete)/i.exec(t);
  if (completeMatch && !addTaskMatch) call('complete_task', { task: cleanTitle(completeMatch[1]) });

  const postponeMatch = /(?:postpone|move|reschedule|delay|shift)\s+(.+?)\s+(?:to\s+)?(tomorrow|today|next week|\d{1,2}:\d{2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.exec(t);
  if (postponeMatch) {
    const target = postponeMatch[2].toLowerCase();
    const isTime = /^\d{1,2}:\d{2}$/.test(target);
    call('reschedule_task', {
      task: cleanTitle(postponeMatch[1]),
      ...(isTime ? { new_start: target } : { new_date: target }),
    });
  }

  const goalMatch = /(?:add|create|set)\s+(?:a\s+)?goal[:\s-]+(.+)/i.exec(t) ?? /i want to (achieve|reach)\s+(.+)/i.exec(t);
  if (goalMatch) {
    const raw = goalMatch[2] ?? goalMatch[1];
    call('create_goal', { title: cleanTitle(raw), horizon: /year|год/.test(lower) ? 'medium' : 'short', priority: 'P1' });
  }

  const eventMatch = /(?:schedule|add)\s+(?:an?\s+)?(?:event|meeting|class|exam|call)[:\s-]+(.+?)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?)?$/i.exec(t);
  if (eventMatch && !addTaskMatch) {
    call('create_calendar_event', {
      title: cleanTitle(eventMatch[1]),
      day: tomorrow ? 'tomorrow' : 'today',
      start: eventMatch[2] ? normalizeTime([eventMatch[0], eventMatch[2], eventMatch[3] ?? '00']) : '09:00',
      end: eventMatch[2] ? normalizeTime([eventMatch[0], String(Number(eventMatch[2]) + 1), eventMatch[3] ?? '00']) : '10:00',
      kind: /exam/.test(lower) ? 'exam' : /class|lecture/.test(lower) ? 'class' : /meeting|call/.test(lower) ? 'meeting' : 'other',
    });
  }

  const learningMatch = /(?:i\s+)?(?:studied|learned|practiced|reviewed)\s+(?:(\w[\w\s+#.-]{1,40}?)\s+)?for\s+(\d{1,3})\s*(?:min|minutes)/i.exec(t);
  if (learningMatch) call('update_learning_progress', { topic: cleanTitle(learningMatch[1] ?? ''), minutes: Number(learningMatch[2]), kind: 'study' });

  const cancelMatch = /(?:cancel|delete|remove|drop|отмени|удали)\s+(?:the\s+|my\s+)?(?:task|todo|event)?[:\s-]*(.+)/i.exec(t);
  if (cancelMatch && !addTaskMatch && !completeMatch) {
    const target = cleanTitle(cancelMatch[1]);
    const looksLikeEvent = /\b(event|meeting|class|exam|appointment|встреч|событие)\b/i.test(lower);
    call(looksLikeEvent ? 'delete_calendar_event' : 'cancel_task', looksLikeEvent ? { title: target } : { task: target });
  }

  if (/what do you (know|remember) about me/i.test(lower)) call('get_user_memory', {});
  if (/plan (my|the) day/i.test(lower) || /what should i do (now|next)/i.test(lower)) call('get_schedule', { day: 'today' });

  return calls.slice(0, 3);
}

function cleanTitle(value: string): string {
  return value
    .replace(/\b(please|thanks|thank you)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim()
    .slice(0, 160);
}

function normalizeTime(match: RegExpExecArray | string[]): string {
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = String(match[3] ?? '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${`${Math.min(23, Math.max(0, hour))}`.padStart(2, '0')}:${`${Math.min(59, Math.max(0, minute))}`.padStart(2, '0')}`;
}

// ─────────────────────────── structured output ───────────────────────────
export function structuredFor(intent: string, userText: string, sections: ContextSections, schema?: JsonSchema): Record<string, unknown> {
  switch (intent) {
    case 'extract_memories':
      return { memories: extractMemoryCandidates(userText) };
    case 'extract_goals':
      return { goals: extractGoalCandidates(userText) };
    case 'extract_tasks':
      return { tasks: extractTaskCandidates(userText) };
    case 'summarize_day':
    case 'summarize_week':
    case 'summarize_month':
      return { summary: composeAnswer('progress', userText, sections).split('\n').slice(1).join(' ') || 'No activity recorded for this period.' };
    case 'structure_news':
      return {
        what_happened: truncate(userText, 240),
        why_it_matters: 'Impact is not yet analysed — connect to the news service for AI structuring.',
        context: '', impact: '', category: 'world', urgency: 'digest',
      };
    case 'interview_questions':
      return { questions: [] };
    default:
      return synthesizeFromSchema(schema ?? {});
  }
}

/** Rule-based fact extraction: what the user states about themselves. */
export function extractMemoryCandidates(text: string): { kind: string; content: string; importance: number; confidence: string; section?: string; tags?: string[] }[] {
  const out: { kind: string; content: string; importance: number; confidence: string; section?: string; tags?: string[] }[] = [];
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 6);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    const iAm = /^(?:i am|i'm|im)\s+(.{3,120})$/i.exec(sentence);
    if (iAm && !/(tired|sorry|not sure|confused|busy right now)/i.test(iAm[1])) {
      // "I am a developer and I prefer evenings" carries two facts — split them.
      const identity = iAm[1].split(/\s+(?:and|but|,)\s+(?:i|my)\b/i)[0].replace(/\.$/, '').trim();
      if (identity.length >= 3) {
        out.push({ kind: 'fact', content: `The user is ${identity}`, importance: 0.75, confidence: 'confirmed', section: 'PROFILE', tags: ['identity'] });
      }
    }

    const iWant = /i (?:want|would like|need|wish)(?: to)?\s+(.{3,140})/i.exec(sentence);
    if (iWant) {
      out.push({ kind: 'fact', content: `Wants to ${iWant[1].replace(/\.$/, '')}`, importance: 0.85, confidence: 'confirmed', section: 'GOALS', tags: ['goal'] });
    }

    const iHave = /i (?:have|has|had)\s+(.{3,120})/i.exec(sentence);
    if (iHave && !/(i have to|i've got to)/i.test(lower)) {
      out.push({ kind: 'fact', content: `Has ${iHave[1].replace(/\.$/, '')}`, importance: 0.6, confidence: 'confirmed', section: 'PROFILE', tags: ['situation'] });
    }

    const iWork = /i (?:work|study|am studying|am working)\s+(?:at|in|as)?\s*(.{2,100})/i.exec(sentence);
    if (iWork) out.push({ kind: 'fact', content: `Works/studies: ${iWork[1].replace(/\.$/, '')}`, importance: 0.8, confidence: 'confirmed', section: 'PROFILE', tags: ['occupation'] });

    const prefer = /i (?:prefer|like|love|enjoy|hate|dislike|cannot stand)\s+(.{2,120})/i.exec(sentence);
    if (prefer) {
      const negative = /(hate|dislike|cannot stand)/i.test(sentence);
      out.push({ kind: 'preference', content: `${negative ? 'Dislikes' : 'Prefers'} ${prefer[1].replace(/\.$/, '')}`, importance: 0.7, confidence: 'confirmed', section: 'PREFERENCES', tags: ['preference'] });
    }

    const time = /i (?:have|can spend|only have)\s+(?:about\s+)?(\d{1,2}(?:[.,]\d)?)\s*(hours?|h|minutes?|min)/i.exec(sentence);
    if (time) {
      const hours = time[2].toLowerCase().startsWith('h') ? Number(time[1]) : Number(time[1]) / 60;
      out.push({ kind: 'fact', content: `Available time: ~${hours}h`, importance: 0.9, confidence: 'confirmed', section: 'TIME_AVAILABILITY', tags: ['time'] });
    }

    const deadline = /(?:deadline|exam|due)\s+(?:is\s+)?(?:on\s+)?(.{3,60})/i.exec(sentence);
    if (deadline) out.push({ kind: 'event', content: `Deadline/exam: ${deadline[1].replace(/\.$/, '')}`, importance: 0.85, confidence: 'confirmed', section: 'CONSTRAINTS', tags: ['deadline'] });

    const decided = /i (?:decided|chose|chosen|will)\s+(.{3,120})/i.exec(sentence);
    if (decided) out.push({ kind: 'decision', content: `Decided: ${decided[1].replace(/\.$/, '')}`, importance: 0.8, confidence: 'confirmed', section: 'GOALS', tags: ['decision'] });

    const canSkill = /i (?:know|can|am good at)\s+(.{2,90})/i.exec(sentence);
    if (canSkill) out.push({ kind: 'skill_evidence', content: `Claims ability: ${canSkill[1].replace(/\.$/, '')}`, importance: 0.65, confidence: 'inferred', section: 'SKILLS', tags: ['skill', 'needs_evidence'] });
  }
  return out.slice(0, 12);
}

export function extractGoalCandidates(text: string): { title: string; horizon: string; priority: string; description: string }[] {
  const out: { title: string; horizon: string; priority: string; description: string }[] = [];
  const parts = text.split(/[.;\n]|, and /).map((s) => s.trim()).filter((s) => s.length > 10);
  for (const part of parts.slice(0, 5)) {
    const cleaned = part.replace(/^(i want to|i want|i need to|i would like to|my goal is)\s+/i, '');
    if (!cleaned) continue;
    const horizon = /(year|years|long term|5y|3y)/i.test(cleaned) ? 'long' : /(month|3 months|quarter)/i.test(cleaned) ? 'short' : 'medium';
    out.push({ title: cleaned.charAt(0).toUpperCase() + cleaned.slice(1), horizon, priority: out.length === 0 ? 'P1' : 'P2', description: `Extracted from: "${part}"` });
  }
  return out;
}

export function extractTaskCandidates(text: string): { title: string; estimated_minutes: number }[] {
  return matchToolCalls(text, ['create_task'])
    .map((call) => ({ title: String(call.arguments.title ?? '').slice(0, 160), estimated_minutes: Number(call.arguments.estimated_minutes ?? 30) }))
    .filter((t) => t.title.length > 2);
}

/** Build a schema-valid object when no intent-specific rule applies. */
export function synthesizeFromSchema(schema: JsonSchema, depth = 0): Record<string, unknown> {
  if (depth > 4 || !schema || typeof schema !== 'object') return {};
  const view = schema as { type?: string; anyOf?: JsonSchema[]; properties?: Record<string, JsonSchema> };
  if (Array.isArray(view.anyOf) && view.anyOf.length) return synthesizeFromSchema(view.anyOf[0], depth + 1);
  if (view.type === 'object' && view.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(view.properties)) out[key] = defaultValueFor(value, depth + 1);
    return out;
  }
  return {};
}

function defaultValueFor(schema: JsonSchema, depth: number): unknown {
  const view = schema as { type?: string; anyOf?: JsonSchema[]; enum?: string[]; properties?: Record<string, JsonSchema> };
  if (Array.isArray(view.anyOf) && view.anyOf.length) return defaultValueFor(view.anyOf[0], depth + 1);
  switch (view.type) {
    case 'string': return view.enum?.length ? view.enum[0] : '';
    case 'number': return 0;
    case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return synthesizeFromSchema(view.properties ? { type: 'object', properties: view.properties } : { type: 'object', properties: {} }, depth + 1);
    default: return null;
  }
}

function zodShapeHint(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def?: { typeName?: string; shape?: () => Record<string, z.ZodTypeAny> } })._def;
  if (def?.typeName === 'ZodObject' && def.shape) {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(def.shape())) properties[key] = guessZodType(value);
    return { type: 'object', properties, required: [] };
  }
  return { type: 'object', properties: {} };
}

function guessZodType(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def?: { typeName?: string; innerType?: z.ZodTypeAny; type?: z.ZodTypeAny } })._def;
  switch (def?.typeName) {
    case 'ZodString': return { type: 'string' };
    case 'ZodNumber': return { type: 'number' };
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodArray': return { type: 'array', items: def.type ? guessZodType(def.type) : { type: 'string' } };
    case 'ZodOptional': case 'ZodDefault': case 'ZodNullable': return def.innerType ? guessZodType(def.innerType) : { type: 'string' };
    default: return { type: 'string' };
  }
}

// ─────────────────────────── hashing embedder ───────────────────────────
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'i', 'you', 'my', 'your', 'it', 'this', 'that']);

export function hashEmbed(text: string, dims = 128): number[] {
  const vector = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9а-яё]+/iu).filter((t) => t.length > 2 && !STOP.has(t));
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) { hash ^= token.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    const index = Math.abs(hash) % dims;
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
    // character trigrams give partial matching for morphologically related words
    for (let i = 0; i + 3 <= token.length; i++) {
      const trigram = token.slice(i, i + 3);
      let h = 5381;
      for (let j = 0; j < trigram.length; j++) h = ((h << 5) + h + trigram.charCodeAt(j)) | 0;
      vector[Math.abs(h) % dims] += 0.35 * (((h >>> 8) % 2 === 0) ? 1 : -1);
    }
  }
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(5)));
}
