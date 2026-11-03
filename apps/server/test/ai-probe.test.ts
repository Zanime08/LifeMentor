import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatReport, probeProvider } from '../src/tools/ai-probe';

/**
 * The probe that tells an operator whether a third-party OpenAI-compatible endpoint can actually
 * drive the app (docs/11 §"Подключить сторонний OpenAI-совместимый шлюз").
 *
 * The tests run a **real** HTTP server and speak to it over the wire, so what is verified is the
 * probe's reading of real responses — not a mocked fetch. The three servers below are the three
 * outcomes that exist in the wild: an honest gateway, a reseller that proxies plain chat but drops
 * `tools`/`response_format`, and a key whose balance is unusable (402).
 */

type Mode = 'good' | 'chat-only' | 'no-budget';

function bodyOf(request: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function answer(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(text);
}

function start(mode: Mode): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url.endsWith('/models')) {
      return answer(response, 200, { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-sol' }] });
    }
    const body = await bodyOf(request);
    if (mode === 'no-budget') {
      return answer(response, 402, { error: { message: 'Budget pool quota has been exhausted.' } });
    }
    // A reseller that answers chat but silently ignores function calling and json_schema.
    if (mode === 'chat-only') {
      return answer(response, 200, {
        choices: [{ message: { content: 'У вас 3 открытые задачи.' }, finish_reason: 'stop' }],
      });
    }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['раз', ', ', 'два', ', ', 'три']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      return response.end('data: [DONE]\n\n');
    }
    if (body.response_format) {
      return answer(response, 200, {
        choices: [{ message: { content: '{"summary":"Пользователь закрыл две задачи."}' }, finish_reason: 'stop' }],
      });
    }
    if (Array.isArray(body.tools) && body.tools.length) {
      return answer(response, 200, {
        choices: [{
          message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_tasks', arguments: '{"limit":5}' } }] },
          finish_reason: 'tool_calls',
        }],
      });
    }
    return answer(response, 200, { choices: [{ message: { content: 'работает' }, finish_reason: 'stop' }] });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

const servers: Server[] = [];
let good = { url: '' };
let chatOnly = { url: '' };
let noBudget = { url: '' };

beforeAll(async () => {
  const a = await start('good'); servers.push(a.server); good = { url: a.url };
  const b = await start('chat-only'); servers.push(b.server); chatOnly = { url: b.url };
  const c = await start('no-budget'); servers.push(c.server); noBudget = { url: c.url };
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('the AI endpoint probe', () => {
  it('passes a gateway that speaks everything the app uses', async () => {
    const report = await probeProvider({ baseUrl: good.url, apiKey: 'sk-test-123456', model: 'gpt-6.1-sol' });
    const by = Object.fromEntries(report.results.map((r) => [r.step, r.status]));
    expect(by).toMatchObject({ models: 'ok', chat: 'ok', tools: 'ok', schema: 'ok', stream: 'ok' });
    expect(report.usable).toBe(true);
    expect(report.degraded).toBe(false);
    // It read the model list honestly, including whether our model is named in it.
    expect(report.results[0].detail).toContain('в списке');
    // The snippet it prints is what goes into .env, with the key never echoed in full.
    const env = formatReport(report);
    expect(env).toContain('OPENAI_BASE_URL=');
    expect(env).toContain('AI_MODEL_MID=gpt-6.1-sol');
    expect(env).not.toContain('sk-test-123456');
    expect(env).toContain('всё, что нужно приложению');
  });

  it('says plainly that a chat-only reseller leaves the app on the offline engine', async () => {
    const report = await probeProvider({ baseUrl: chatOnly.url, apiKey: 'sk-test-123456', model: 'gpt-6.1-sol' });
    const by = Object.fromEntries(report.results.map((r) => [r.step, r.status]));
    expect(by.chat).toBe('ok');
    // The endpoint never refuses — it just answers in words instead of calling the function.
    expect(by.tools).toBe('skipped');
    expect(by.schema).toBe('failed');
    expect(report.usable).toBe(true);
    expect(report.degraded).toBe(true);
    const text = formatReport(report);
    expect(text).toContain('чат заработает, но не полностью');
    expect(text).toContain('уйдут на встроенный движок');
  });

  it('explains a balance that cannot be spent instead of reporting a mystery', async () => {
    const report = await probeProvider({ baseUrl: noBudget.url, apiKey: 'sk-test-123456', model: 'gpt-6.1-sol' });
    expect(report.usable).toBe(false);
    const chat = report.results.find((r) => r.step === 'chat');
    expect(chat?.status).toBe('failed');
    // The vendor's own words, plus what it means for the operator.
    expect(chat?.detail).toContain('402');
    expect(chat?.detail).toContain('нет доступного лимита');
    expect(chat?.detail).toContain('Budget pool quota');
    // Nothing else is asked once chat failed: three more 402s teach nobody anything.
    expect(report.results.filter((r) => r.step !== 'models').every((r) => r.status !== 'ok')).toBe(true);
    expect(formatReport(report)).toContain('ключ не работает');
  });

  it('never throws on an unreachable endpoint — it reports it', async () => {
    const report = await probeProvider({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'x', timeoutMs: 1500 });
    expect(report.usable).toBe(false);
    expect(report.results.find((r) => r.step === 'chat')?.status).toBe('failed');
    expect(formatReport(report)).toContain('не ответил');
  });
});
