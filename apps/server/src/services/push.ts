import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { createLogger } from '@lifementor/core';
import type { ServerDb } from '../db';
import type { ServerConfig } from '../config';

/**
 * Push notifications (docs/08 §5).
 *
 * Delivery paths:
 *  - **Web Push** (primary here): the server pushes to the browser's service worker via VAPID;
 *  - **polling fallback** (guaranteed): every notification is stored in a per-user queue, and the
 *    client pulls `GET /v1/notifications/pending` on each foreground — so a notification survives
 *    a closed tab, a dead network at push time, and (later) FCM tokens for Android.
 *
 * The client remains the final gate (budget / quiet hours / per-type switches, req. 86); the
 * server only guarantees the notification *arrives*, and applies a hard daily cap for
 * important-news pushes.
 */

export type NotificationType =
  | 'daily_plan' | 'schedule_start' | 'task_reminder' | 'learning_review' | 'important_news'
  | 'goal_review' | 'project_deadline' | 'mentor_message' | 'daily_digest';

export interface ServerNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  url: string | null;
  data: string | null;
  urgent: number;
  dedup_key: string | null;
  push_sent_at: string | null;
  push_error: string | null;
  created_at: string;
}

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  url?: string | null;
  data?: Record<string, unknown> | null;
  urgent?: boolean;
  dedupKey?: string | null;
  /** How long the notification may be picked up by polling (default 7 days). */
  ttlHours?: number;
}

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  device_id: string;
  kind: 'web' | 'fcm';
  endpoint: string;
  p256dh: string | null;
  auth_secret: string | null;
  last_error: string | null;
}

export class PushService {
  private readonly log = createLogger('notification');

  constructor(private readonly db: ServerDb, private readonly config: ServerConfig['push']) {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    }
  }

  get vapidPublicKey(): string { return this.config.vapidPublicKey ?? ''; }

  // ─────────────────────────── subscriptions ───────────────────────────

  async addSubscription(
    userId: string,
    deviceId: string,
    sub: { kind: 'web' | 'fcm'; endpoint: string; p256dh?: string | null; authSecret?: string | null; userAgent?: string | null },
  ): Promise<{ created: boolean; count: number }> {
    const now = new Date().toISOString();
    const exists = await this.db.get(`SELECT 1 AS x FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, [userId, sub.endpoint]);
    await this.db.run(
      `INSERT INTO push_subscriptions (id, user_id, device_id, kind, endpoint, p256dh, auth_secret, user_agent, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         device_id = excluded.device_id,
         kind = excluded.kind,
         p256dh = excluded.p256dh,
         auth_secret = excluded.auth_secret,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`,
      [randomUUID(), userId, deviceId, sub.kind, sub.endpoint, sub.p256dh ?? null, sub.authSecret ?? null, sub.userAgent ?? null, now, now],
    );
    const row = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`, [userId]);
    return { created: !exists, count: Number(row?.n ?? 0) };
  }

  async removeSubscription(userId: string, endpoint: string): Promise<number> {
    const r = await this.db.run(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, [userId, endpoint]);
    return r.changes;
  }

  async countSubscriptions(userId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`, [userId]);
    return Number(row?.n ?? 0);
  }

  /** All users with at least one subscription (for server-initiated notifications). */
  async usersWithSubscriptions(limit = 100): Promise<string[]> {
    const rows = await this.db.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM push_subscriptions LIMIT ?`, [limit]);
    return rows.map((r) => r.user_id);
  }

  // ─────────────────────────── queue + delivery ───────────────────────────

  /**
   * Store + attempt immediate push. Returns `push: 'sent'` when at least one Web Push was
   * delivered, `'skipped'` (dedupe hit or no subscriptions) or `'failed'` (kept in the queue
   * for polling; `push_error` carries the reason).
   */
  async notify(userId: string, input: NotifyInput): Promise<{ id: string; created: boolean; push: 'sent' | 'skipped' | 'failed'; error?: string }> {
    const now = new Date();
    const id = randomUUID();
    const created = now.toISOString();
    const ttlHours = Math.min(24 * 30, Math.max(1, input.ttlHours ?? 24 * 7));
    const expires = new Date(now.getTime() + ttlHours * 3600_000).toISOString();

    if (input.dedupKey) {
      const dup = await this.db.get(
        `SELECT 1 AS x FROM notifications WHERE user_id = ? AND dedup_key = ? AND created_at >= ?`,
        [userId, input.dedupKey, new Date(now.getTime() - 24 * 3600_000).toISOString()],
      );
      if (dup) return { id, created: false, push: 'skipped' };
    }

    const dataJson = input.data ? JSON.stringify(input.data) : null;
    await this.db.run(
      `INSERT INTO notifications (id, user_id, type, title, body, url, data, urgent, dedup_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, input.type, input.title, input.body ?? null, input.url ?? null, dataJson, input.urgent ? 1 : 0, input.dedupKey ?? null, created, expires],
    );

    const stored: ServerNotification = {
      id, type: input.type, title: input.title, body: input.body ?? null, url: input.url ?? null,
      data: dataJson, urgent: input.urgent ? 1 : 0, dedup_key: input.dedupKey ?? null,
      push_sent_at: null, push_error: null, created_at: created,
    };
    const [push, error] = await this.deliver(userId, stored);
    if (error) this.log.warn('push delivery failed, left in queue for polling', { userId, id, error });
    return { id, created: true, push, error };
  }

  private async deliver(userId: string, n: ServerNotification): Promise<['sent' | 'skipped' | 'failed', string | undefined]> {
    const subs = await this.db.all<PushSubscriptionRow>(`SELECT * FROM push_subscriptions WHERE user_id = ?`, [userId]);
    if (!subs.length) return ['skipped', undefined];

    let delivered = false;
    let lastError: string | undefined;
    const now = new Date().toISOString();

    for (const sub of subs) {
      if (sub.kind !== 'web') {
        // FCM transport activates with the Android shell; until then the notification stays in
        // the queue and is delivered via polling (honest, not faked).
        lastError = lastError ?? 'fcm transport not enabled yet (Android shell pending) — will be delivered by polling';
        continue;
      }
      if (!sub.p256dh || !sub.auth_secret) {
        lastError = lastError ?? 'subscription stored without keys (client must re-subscribe)';
        continue;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
          JSON.stringify({
            title: n.title,
            body: n.body ?? undefined,
            url: n.url ?? undefined,
            tag: n.dedup_key ?? undefined,
            data: n.data ? JSON.parse(n.data) : undefined,
          }),
          { TTL: 24 * 3600, urgency: n.urgent ? 'high' : 'normal' },
        );
        await this.db.run(`UPDATE push_subscriptions SET last_error = NULL, updated_at = ? WHERE id = ?`, [now, sub.id]);
        delivered = true;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);
        if (status === 404 || status === 410) {
          // Expired subscription — drop it, the client will re-subscribe.
          await this.db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [sub.id]);
          lastError = lastError ?? 'subscription expired (removed)';
        } else {
          lastError = lastError ?? message;
          await this.db.run(`UPDATE push_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?`, [message.slice(0, 500), now, sub.id]);
        }
      }
    }

    const pushSentAt = new Date().toISOString();
    if (delivered) {
      await this.db.run(`UPDATE notifications SET push_sent_at = ? WHERE id = ?`, [pushSentAt, n.id]);
      return ['sent', undefined];
    }
    const error = lastError ?? 'no web subscription';
    await this.db.run(`UPDATE notifications SET push_sent_at = ?, push_error = ? WHERE id = ?`, [pushSentAt, error, n.id]);
    return ['failed', error];
  }

  // ─────────────────────────── polling fallback ───────────────────────────

  async pending(userId: string, limit = 50): Promise<ServerNotification[]> {
    const now = new Date().toISOString();
    const rows = await this.db.all<ServerNotification>(
      `SELECT id, type, title, body, url, data, urgent, dedup_key, push_sent_at, push_error, created_at
       FROM notifications
       WHERE user_id = ? AND delivered_at IS NULL AND expires_at > ?
       ORDER BY created_at ASC LIMIT ?`,
      [userId, now, Math.min(200, Math.max(1, limit))],
    );
    return rows;
  }

  async markDelivered(userId: string, id: string): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE notifications SET delivered_at = ? WHERE id = ? AND user_id = ? AND delivered_at IS NULL`,
      [new Date().toISOString(), id, userId],
    );
    return r.changes > 0;
  }

  /** Drop long-expired rows so the queue cannot grow unbounded. */
  async pruneExpired(): Promise<number> {
    const r = await this.db.run(`DELETE FROM notifications WHERE expires_at < ?`, [new Date().toISOString()]);
    return r.changes;
  }

  // ─────────────────────────── server-initiated ───────────────────────────

  /**
   * Urgent news → push, with a hard per-user per-day cap (req. 86). Deduped by URL, so the
   * same headline is never pushed twice.
   */
  async notifyUrgentNews(userId: string, items: { url: string; title: string }[]): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    let sent = 0;
    for (const item of items) {
      const used = await this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'important_news' AND substr(created_at, 1, 10) = ?`,
        [userId, day],
      );
      if (Number(used?.n ?? 0) >= this.config.newsDailyCap) break;
      const result = await this.notify(userId, {
        type: 'important_news',
        title: 'Срочная новость',
        body: item.title.slice(0, 300),
        url: item.url,
        urgent: true,
        dedupKey: `news:${item.url}`,
        ttlHours: 24,
      });
      if (result.created) sent += 1;
    }
    return sent;
  }
}
