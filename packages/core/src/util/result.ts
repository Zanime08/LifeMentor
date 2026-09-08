/** Typed result + error model. Services never throw for expected failures. */

export type ErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'network'
  | 'provider'
  | 'storage'
  | 'integrity'
  | 'rate_limited'
  | 'unsupported'
  | 'unknown';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly correlationId?: string;
  readonly userMessage: string;

  constructor(code: ErrorCode, message: string, options: { details?: unknown; correlationId?: string; userMessage?: string } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.correlationId = options.correlationId;
    this.userMessage = options.userMessage ?? message;
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError('validation', message, { details, userMessage: message });
  }
  static notFound(entity: string, id?: string): AppError {
    return new AppError('not_found', `${entity}${id ? ` ${id}` : ''} not found`, {
      userMessage: `We could not find that ${entity.toLowerCase()}. It may have been deleted on another device.`,
    });
  }
  static network(message = 'No connection', details?: unknown): AppError {
    return new AppError('network', message, { details, userMessage: 'You are offline. Your change is saved locally and will sync automatically.' });
  }
  static provider(message: string, details?: unknown): AppError {
    return new AppError('provider', message, { details, userMessage: 'The AI service did not respond. Your data is safe — try again in a moment.' });
  }
  static storage(message: string, details?: unknown): AppError {
    return new AppError('storage', message, { details, userMessage: 'Storage error. The last confirmed state was preserved.' });
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError('conflict', message, { details, userMessage: message });
  }
  static unauthorized(message = 'Not authenticated'): AppError {
    return new AppError('unauthorized', message, { userMessage: 'Please sign in again.' });
  }

  toJSON(): { code: ErrorCode; message: string; userMessage: string; details?: unknown; correlationId?: string } {
    return { code: this.code, message: this.message, userMessage: this.userMessage, details: this.details, correlationId: this.correlationId };
  }
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T, E = AppError>(error: E): Result<T, E> => ({ ok: false, error });

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/** Run a function, converting thrown errors into a Result. */
export async function attempt<T>(fn: () => Promise<T> | T, mapError: (e: unknown) => AppError = toAppError): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(mapError(e));
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error) return new AppError('unknown', e.message, { userMessage: e.message });
  return new AppError('unknown', String(e), { userMessage: 'Something went wrong.' });
}
