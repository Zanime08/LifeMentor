/**
 * Probe an OpenAI-compatible endpoint before trusting it with the app.
 *
 *   npm run ai:probe --workspace @lifementor/server
 *   OPENAI_BASE_URL=https://vendor.example/v1 OPENAI_API_KEY=sk-... npm run ai:probe --workspace @lifementor/server
 *
 * Why this exists: LifeMentor's assistant does more than "write text". It calls **tools**
 * (all 29 of them are function calls), asks for **JSON with a schema** (memories, reviews,
 * onboarding proposals) and **streams** replies. A reseller gateway can proxy plain chat
 * perfectly while silently failing all three — and then the app works, but only with the
 * offline engine, because every cloud call degrades instead of failing loudly. This tool
 * answers "will this key actually drive the app?" in one command, with no guesswork.
 *
 * It talks to the endpoint directly (`fetch`) rather than through our provider on purpose:
 * the report must describe the vendor, not our fallback chain.
 */

const TIMEOUT_MS = 20_000;

export type ProbeStep = 'models' | 'chat' | 'tools' | 'schema' | 'stream';
export type ProbeStatus = 'ok' | 'failed' | 'skipped';

export interface ProbeResult {
  step: ProbeStep;
  status: ProbeStatus;
  /** What was actually observed — shown to the operator, never invented. */
  detail: string;
  latencyMs?: number;
}

export interface ProbeReport {
  baseUrl: string;
  model: string;
  results: ProbeResult[];
  /** Steps the app genuinely depends on. */
  usable: boolean;
  /** True when the endpoint answered chat but something the app needs is missing. */
  degraded: boolean;
  env: string[];
}

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const TOOL = {
  name: 'get_tasks',
  description: 'List the tasks that are open right now.',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'How many tasks' } }, required: [] },
};

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string', description: 'One sentence' } },
  required: ['summary'],
  additionalProperties: false,
};

const SYSTEM = 'You are the LifeMentor assistant. Be brief.';

async function call(
  options: ProbeOptions,
  path: string,
  body: Record<string, unknown> | null,
): Promise<{ status: number; text: string; contentType: string }> {
  const f = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await f(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text(), contentType: response.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

/** The vendor's error, trimmed to something an operator can act on. */
function why(status: number, text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const parsed = (() => {
    try { return JSON.parse(text) as { error?: { message?: string } }; } catch { return null; }
  })();
  const message = parsed?.error?.message ?? flat;
  if (status === 401 || status === 403) return `${status}: ключ не принят — ${message.slice(0, 160)}`;
  if (status === 402) return `402: на балансе нет доступного лимита — ${message.slice(0, 160)}`;
  if (status === 404) return `404: такой модели или маршрута у провайдера нет — ${message.slice(0, 160)}`;
  if (status === 429) return `429: лимит запросов — ${message.slice(0, 160)}`;
  return `${status}: ${message.slice(0, 200)}`;
}

interface ChatChoice {
  message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
  finish_reason?: string;
}

function firstChoice(text: string): ChatChoice | null {
  try {
    const data = JSON.parse(text) as { choices?: ChatChoice[] };
    return data.choices?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function probeProvider(options: ProbeOptions): Promise<ProbeReport> {
  const results: ProbeResult[] = [];
  const model = options.model;

  // 1. Which models does the key actually see? Informational: many gateways hide the list.
  {
    const started = Date.now();
    try {
      const { status, text } = await call(options, '/models', null);
      if (status === 200) {
        const list = (() => {
          try { return (JSON.parse(text) as { data?: { id?: string }[] }).data ?? []; } catch { return []; }
        })();
        const ids = list.map((m) => m.id).filter((id): id is string => Boolean(id));
        const known = ids.includes(model);
        results.push({
          step: 'models', status: 'ok', latencyMs: Date.now() - started,
          detail: ids.length
            ? `${ids.length} моделей; «${model}» ${known ? 'в списке' : 'в списке нет — запрос всё равно может пройти'}`
            : 'список моделей пуст (провайдер его не отдаёт) — это нормально',
        });
      } else {
        results.push({ step: 'models', status: 'skipped', latencyMs: Date.now() - started, detail: why(status, text) });
      }
    } catch (error) {
      results.push({ step: 'models', status: 'skipped', detail: `не ответил: ${(error as Error).message}` });
    }
  }

  // 2. Plain chat — the minimum: the vendor must answer at all with this model id.
  let chatOk = false;
  {
    const started = Date.now();
    try {
      const { status, text } = await call(options, '/chat/completions', {
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Ответь одним словом: работает.' }],
        max_tokens: 30,
        temperature: 0,
      });
      const choice = status === 200 ? firstChoice(text) : null;
      if (status === 200 && choice) {
        chatOk = true;
        const content = (choice.message?.content ?? '').trim();
        results.push({
          step: 'chat', status: 'ok', latencyMs: Date.now() - started,
          detail: content ? `ответ: «${content.slice(0, 60)}»` : 'ответ пустой, но структура верная',
        });
      } else {
        results.push({ step: 'chat', status: 'failed', latencyMs: Date.now() - started, detail: why(status, text) });
      }
    } catch (error) {
      results.push({ step: 'chat', status: 'failed', latencyMs: Date.now() - started, detail: `не ответил: ${(error as Error).message}` });
    }
  }

  // Without chat nothing else is worth asking — a 402/401 would just repeat four times.
  const runRest = chatOk;

  // 3. Tools. Every assistant action in this app is a function call; a gateway that drops
  //    `tools` makes the chat answer "I cannot do that" while the app still looks healthy.
  let toolsOk = false;
  {
    const started = Date.now();
    if (!runRest) {
      results.push({ step: 'tools', status: 'skipped', detail: 'не проверялось: обычный чат не прошёл' });
    } else {
      try {
        const { status, text } = await call(options, '/chat/completions', {
          model,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Сколько у меня открытых задач? Вызови get_tasks.' }],
          tools: [{ type: 'function', function: TOOL }],
          tool_choice: 'auto',
          max_tokens: 120,
          temperature: 0,
        });
        const choice = status === 200 ? firstChoice(text) : null;
        const called = choice?.message?.tool_calls?.[0]?.function?.name;
        const args = choice?.message?.tool_calls?.[0]?.function?.arguments ?? '';
        if (status !== 200) {
          results.push({ step: 'tools', status: 'failed', latencyMs: Date.now() - started, detail: why(status, text) });
        } else if (called === TOOL.name) {
          toolsOk = true;
          results.push({ step: 'tools', status: 'ok', latencyMs: Date.now() - started, detail: `модель вызвала ${called} с аргументами ${args.slice(0, 60) || '{}'}` });
        } else if (choice) {
          // Not fatal: a model may simply answer in words. Worth telling the operator plainly.
          results.push({
            step: 'tools', status: 'skipped', latencyMs: Date.now() - started,
            detail: 'ответ пришёл, но функция не вызвана — провайдер не отказал, модель решила ответить текстом. Проверьте на реальном вопросе в чате',
          });
        } else {
          results.push({ step: 'tools', status: 'failed', latencyMs: Date.now() - started, detail: 'не разобрать ответ' });
        }
      } catch (error) {
        results.push({ step: 'tools', status: 'failed', latencyMs: Date.now() - started, detail: `не ответил: ${(error as Error).message}` });
      }
    }
  }

  // 4. Structured output. Memories, reviews and onboarding proposals are schema calls; without
  //    them the app degrades quietly to its own wording.
  {
    const started = Date.now();
    if (!runRest) {
      results.push({ step: 'schema', status: 'skipped', detail: 'не проверялось: обычный чат не прошёл' });
    } else {
      try {
        const { status, text } = await call(options, '/chat/completions', {
          model,
          messages: [{ role: 'system', content: `${SYSTEM} Respond with JSON only.` }, { role: 'user', content: 'Summarise: the user finished two tasks today.' }],
          response_format: { type: 'json_schema', json_schema: { name: 'summary', schema: SCHEMA, strict: false } },
          max_tokens: 150,
          temperature: 0,
        });
        const choice = status === 200 ? firstChoice(text) : null;
        const content = choice?.message?.content ?? '';
        let parsed: unknown = null;
        try { parsed = JSON.parse(content); } catch { parsed = null; }
        if (status !== 200) {
          results.push({ step: 'schema', status: 'failed', latencyMs: Date.now() - started, detail: why(status, text) });
        } else if (parsed && typeof parsed === 'object' && 'summary' in parsed) {
          results.push({ step: 'schema', status: 'ok', latencyMs: Date.now() - started, detail: 'JSON по схеме пришёл' });
        } else {
          results.push({
            step: 'schema', status: 'failed', latencyMs: Date.now() - started,
            detail: `ответ не JSON по схеме: «${content.slice(0, 120)}». Приложение переварит его через запасной разбор, но качество памяти и ревью будет ниже`,
          });
        }
      } catch (error) {
        results.push({ step: 'schema', status: 'failed', latencyMs: Date.now() - started, detail: `не ответил: ${(error as Error).message}` });
      }
    }
  }

  // 5. Streaming. The chat screen streams; a gateway that buffers the whole reply still works,
  //    so this is reported, not enforced.
  {
    const started = Date.now();
    if (!runRest) {
      results.push({ step: 'stream', status: 'skipped', detail: 'не проверялось: обычный чат не прошёл' });
    } else {
      try {
        const { status, text, contentType } = await call(options, '/chat/completions', {
          model,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Скажи: раз, два, три.' }],
          stream: true,
          max_tokens: 40,
          temperature: 0,
        });
        const chunks = (text.match(/^data: /gm) ?? []).length;
        if (status !== 200) {
          results.push({ step: 'stream', status: 'failed', latencyMs: Date.now() - started, detail: why(status, text) });
        } else if (chunks >= 2 || contentType.includes('event-stream')) {
          results.push({ step: 'stream', status: 'ok', latencyMs: Date.now() - started, detail: `SSE, ${chunks} chunk(ов)` });
        } else {
          results.push({ step: 'stream', status: 'skipped', latencyMs: Date.now() - started, detail: 'ответ целиком, без потока — чат просто покажет его сразу' });
        }
      } catch (error) {
        results.push({ step: 'stream', status: 'failed', latencyMs: Date.now() - started, detail: `не ответил: ${(error as Error).message}` });
      }
    }
  }

  const byStep = (step: ProbeStep) => results.find((r) => r.step === step);
  const schemaOk = byStep('schema')?.status === 'ok';
  const env = [
    `OPENAI_API_KEY=${options.apiKey.slice(0, 6)}…(ваш ключ)`,
    `OPENAI_BASE_URL=${options.baseUrl.replace(/\/$/, '')}`,
    `AI_MODEL_MID=${model}`,
    `AI_MODEL_CHEAP=${model}`,
    `AI_MODEL_STRONG=${model}`,
  ];

  return {
    baseUrl: options.baseUrl,
    model,
    results,
    // The app is usable when chat works; it is *complete* only with tools.
    usable: chatOk,
    degraded: chatOk && (!toolsOk || !schemaOk),
    env,
  };
}

/** Human-readable report — the same text the CLI prints. */
export function formatReport(report: ProbeReport): string {
  const line = (r: ProbeResult): string => {
    const mark = r.status === 'ok' ? '✓' : r.status === 'failed' ? '✗' : '·';
    const ms = r.latencyMs ? ` ${r.latencyMs} мс` : '';
    return `  ${mark} ${r.step.padEnd(6)}${ms.padEnd(9)} ${r.detail}`;
  };
  const out = [
    `Провайдер: ${report.baseUrl}`,
    `Модель:    ${report.model}`,
    '',
    ...report.results.map(line),
    '',
  ];
  if (!report.usable) {
    out.push('Итог: ключ не работает — обычный чат не прошёл. Приложение останется на встроенном движке, ничего не сломается.');
  } else if (report.degraded) {
    out.push('Итог: чат заработает, но не полностью: чего-то из возможностей (функции/JSON) провайдер не даёт.');
    out.push('      Приложение не сломается — такие вызовы уйдут на встроенный движок, качество будет ниже.');
  } else {
    out.push('Итог: всё, что нужно приложению (чат, функции, JSON, поток), работает.');
  }
  out.push('', 'Для .env рядом с сервером:');
  for (const row of report.env) out.push(`  ${row}`);
  return out.join('\n');
}

/** CLI entry: `npm run ai:probe`. Reads OPENAI_BASE_URL / OPENAI_API_KEY / AI_MODEL_* from the env. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const baseUrl = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const apiKey = env.OPENAI_API_KEY ?? '';
  const model = env.AI_MODEL_MID ?? env.AI_MODEL_CHEAP ?? 'gpt-4o-mini';
  if (!apiKey) {
    process.stderr.write('Нужен ключ: OPENAI_API_KEY=sk-... npm run ai:probe --workspace @lifementor/server\n');
    return 2;
  }
  const report = await probeProvider({ baseUrl, apiKey, model });
  process.stdout.write(`${formatReport(report)}\n`);
  return report.usable ? 0 : 1;
}

if (process.argv[1] && /ai-probe\.(ts|mjs|js)$/.test(process.argv[1])) {
  void main().then((code) => process.exit(code));
}
