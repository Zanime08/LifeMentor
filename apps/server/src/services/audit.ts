import { newId, nowIso } from '@lifementor/core';
import type { ServerDb } from '../db';

/**
 * Audit trail (docs/08 §2, §6; req. 69).
 *
 * Records *that* something happened — never secrets: no passwords, no tokens, no key material,
 * and no personal content. Retention is bounded so the table cannot grow without limit.
 */

export type AuditEvent =
  | 'register' | 'login' | 'login_failed' | 'logout' | 'refresh' | 'refresh_rejected'
  | 'password_changed' | 'account_deleted' | 'device_revoked'
  | 'sync_push' | 'sync_pull' | 'sync_conflict'
  | 'ai_request' | 'ai_budget_exceeded' | 'ai_error';

export interface AuditEntryInput {
  event: AuditEvent;
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

export class AuditLog {
  constructor(private readonly db: ServerDb) {}

  async record(entry: AuditEntryInput): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_log (id, user_id, event, device_id, ip, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        newId('op'), entry.userId ?? null, entry.event, entry.deviceId ?? null, entry.ip ?? null,
        entry.detail ? JSON.stringify(redact(entry.detail)) : null, nowIso(),
      ],
    );
  }

  async recent(options: { userId?: string; event?: AuditEvent; limit?: number } = {}): Promise<Record<string, unknown>[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.userId) { where.push('user_id = ?'); params.push(options.userId); }
    if (options.event) { where.push('event = ?'); params.push(options.event); }
    return this.db.all(
      `SELECT id, user_id, event, device_id, ip, detail, created_at FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT ?`,
      [...params, options.limit ?? 100],
    );
  }

  async pruneOlderThan(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await this.db.run('DELETE FROM audit_log WHERE created_at < ?', [cutoff]);
    return result.changes;
  }
}

/** Never write secrets, even by accident: detail keys matching this are dropped. */
const FORBIDDEN_DETAIL_KEY = /(password|token|secret|authorization|api[_-]?key|refresh|access)/i;

function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}
