import type { IsoDateString } from './time';

/** Ring-buffer + pluggable sink logger. Never logs secrets or raw personal content by default. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory =
  | 'app' | 'db' | 'sync' | 'ai' | 'planner' | 'learning' | 'notification'
  | 'news' | 'auth' | 'backup' | 'onboarding' | 'crash';

export interface LogRecord {
  at: IsoDateString;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: Record<string, unknown>;
  correlationId?: string;
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void> | void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fields whose values must never reach a log line. */
const REDACT_KEYS = [
  'password', 'pass', 'secret', 'token', 'access_token', 'refresh_token', 'authorization',
  'api_key', 'apikey', 'key', 'cookie', 'session_token', 'signature', 'private_key',
];

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/**
 * Shared logging state. Every Logger reads this, so `setLogLevel()` and
 * `addGlobalSink()` take effect immediately for loggers created earlier too —
 * a diagnostics screen or a desktop file logger can be attached at runtime.
 */
interface LogState { level: LogLevel; sinks: LogSink[] }
const state: LogState = { level: 'info', sinks: [] };

export function setLogLevel(level: LogLevel): void { state.level = level; }
export function getLogLevel(): LogLevel { return state.level; }
export function addGlobalSink(sink: LogSink): void {
  if (!state.sinks.includes(sink)) state.sinks.push(sink);
}
export function removeGlobalSink(sink: LogSink): void {
  const index = state.sinks.indexOf(sink);
  if (index >= 0) state.sinks.splice(index, 1);
}

export class Logger {
  private readonly ownSinks: LogSink[] = [];
  private ownLevel: LogLevel | null = null;
  readonly category: LogCategory;
  private readonly correlationId?: string;

  constructor(category: LogCategory, options: { sinks?: LogSink[]; level?: LogLevel; correlationId?: string } = {}) {
    this.category = category;
    if (options.sinks) this.ownSinks.push(...options.sinks);
    if (options.level) this.ownLevel = options.level;
    this.correlationId = options.correlationId;
  }

  child(category: LogCategory, correlationId?: string): Logger {
    const logger = new Logger(category, { level: this.ownLevel ?? undefined, correlationId: correlationId ?? this.correlationId });
    logger.ownSinks.push(...this.ownSinks);
    return logger;
  }

  addSink(sink: LogSink): void { if (!this.ownSinks.includes(sink)) this.ownSinks.push(sink); }

  setLevel(level: LogLevel): void { this.ownLevel = level; }

  get level(): LogLevel { return this.ownLevel ?? state.level; }

  debug(message: string, data?: Record<string, unknown>): void { this.emit('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.emit('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.emit('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.emit('error', message, data); }

  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record: LogRecord = {
      at: new Date().toISOString(),
      level,
      category: this.category,
      message,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
      correlationId: this.correlationId,
    };
    for (const sink of [...state.sinks, ...this.ownSinks]) {
      try { sink.write(record); } catch { /* a broken sink must never break the app */ }
    }
  }

  async flush(): Promise<void> {
    for (const sink of [...state.sinks, ...this.ownSinks]) await sink.flush?.();
  }
}

export class ConsoleSink implements LogSink {
  write(record: LogRecord): void {
    const line = `[${record.at}] ${record.level.toUpperCase()} ${record.category}: ${record.message}`;
    const fn = record.level === 'error' ? console.error : record.level === 'warn' ? console.warn : console.log;
    if (record.data) fn(line, record.data); else fn(line);
  }
}

/** Fixed-size in-memory ring buffer — used for crash reports and the diagnostics screen. */
export class MemorySink implements LogSink {
  private readonly buffer: LogRecord[] = [];
  constructor(private readonly capacity = 500) {}
  write(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
  }
  tail(n = 50): LogRecord[] { return this.buffer.slice(-n); }
  clear(): void { this.buffer.length = 0; }
}

/** Global default logger; platform code attaches file sinks via `addGlobalSink`. */
export const crashBuffer = new MemorySink(200);
export const historyBuffer = new MemorySink(500);
addGlobalSink(historyBuffer);
addGlobalSink(crashBuffer);
export const rootLogger = new Logger('app');

export function createLogger(category: LogCategory, correlationId?: string): Logger {
  return rootLogger.child(category, correlationId);
}
