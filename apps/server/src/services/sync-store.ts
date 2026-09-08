import { AppError, nowIso } from '@lifementor/core';
import type { PushAck, PushOperation, RemoteChange } from '@lifementor/core';
import type { ServerDb } from '../db';
import type { AuditLog } from './audit';

/**
 * Server side of the sync protocol (docs/04 §5, docs/08 §1).
 *
 * The server is an **optimistic-concurrency store**, not a merge engine:
 *  - `sync_entities` holds the current authoritative version of every entity per user;
 *  - `sync_feed` is an append-only, per-user ordered log — its `seq` is the cursor clients store;
 *  - a push whose `base_version` is older than the stored version is **not** merged here: the
 *    server answers `conflict` with the current payload and the *client* applies its documented
 *    rules (field merge / completion wins / delete wins / ask the user for critical entities).
 *
 * Payloads are opaque JSON. The server never interprets them, so it cannot leak meaning even if
 * the database is exposed, and every query is scoped by `user_id` taken from the access token —
 * never from the request body.
 */

const ENTITY_TYPE_RE = /^[a-z_][a-z0-9_]{0,63}$/;
const MAX_ENTITY_ID_LENGTH = 96;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_OPERATIONS_PER_PUSH = 500;

export interface StoredEntity {
  user_id: string;
  entity_type: string;
  entity_id: string;
  version: number;
  payload: string;
  deleted: number;
  origin_device: string | null;
  updated_at: string;
  received_at: string;
}

export interface FeedRow {
  seq: number;
  user_id: string;
  entity_type: string;
  entity_id: string;
  version: number;
  base_version: number;
  payload: string;
  deleted: number;
  origin_device: string | null;
  updated_at: string;
  created_at: string;
}

export interface SyncStatus {
  entities: number;
  deletedEntities: number;
  feedLength: number;
  headSeq: number;
  lastChangeAt: string | null;
  devices: number;
}

export class SyncStore {
  constructor(private readonly db: ServerDb, private readonly audit: AuditLog) {}

  /** Apply a batch of client operations. Returns one ack per operation, in order. */
  async push(userId: string, deviceId: string, operations: PushOperation[], ip?: string | null): Promise<PushAck[]> {
    if (!Array.isArray(operations)) throw AppError.validation('operations must be an array');
    if (operations.length > MAX_OPERATIONS_PER_PUSH) {
      throw AppError.validation(`Too many operations in one push (max ${MAX_OPERATIONS_PER_PUSH})`);
    }

    const acks: PushAck[] = [];
    let applied = 0;
    let conflicted = 0;

    await this.db.transaction(async () => {
      for (const operation of operations) {
        const invalid = validateOperation(operation);
        if (invalid) {
          acks.push({ operation_id: String(operation?.operation_id ?? ''), status: 'rejected', error: invalid });
          continue;
        }

        const existing = await this.db.get<StoredEntity>(
          'SELECT * FROM sync_entities WHERE user_id = ? AND entity_type = ? AND entity_id = ?',
          [userId, operation.entity_type, operation.entity_id],
        );
        const deleted = operation.operation_type === 'delete' ? 1 : Number(operation.payload?.deleted ?? 0) === 1 ? 1 : 0;
        const payload = JSON.stringify({ ...(operation.payload ?? {}), deleted });

        if (!existing) {
          const version = Math.max(1, Number(operation.version) || 1);
          await this.upsertEntity(userId, operation, payload, deleted, version, deviceId);
          await this.appendFeed(userId, operation, payload, deleted, version, Number(operation.base_version) || 0, deviceId);
          acks.push({ operation_id: operation.operation_id, status: 'applied', server_version: version });
          applied += 1;
          continue;
        }

        const serverVersion = Number(existing.version);
        const baseVersion = Number(operation.base_version) || 0;

        if (baseVersion >= serverVersion) {
          // Fast-forward: the client built on the state we already have.
          const version = Math.max(Number(operation.version) || serverVersion + 1, serverVersion + 1);
          await this.upsertEntity(userId, operation, payload, deleted, version, deviceId);
          await this.appendFeed(userId, operation, payload, deleted, version, serverVersion, deviceId);
          acks.push({ operation_id: operation.operation_id, status: 'applied', server_version: version });
          applied += 1;
          continue;
        }

        // Somebody else got there first. The client decides what to do with it.
        acks.push({
          operation_id: operation.operation_id,
          status: 'conflict',
          server_version: serverVersion,
          remote_payload: { ...safeParse(existing.payload), deleted: existing.deleted },
        });
        conflicted += 1;
      }
    });

    await this.touchDevice(userId, deviceId);
    await this.audit.record({
      event: applied || conflicted ? 'sync_push' : 'sync_push',
      userId, deviceId, ip,
      detail: { operations: operations.length, applied, conflicted },
    });
    if (conflicted) await this.audit.record({ event: 'sync_conflict', userId, deviceId, ip, detail: { conflicted } });

    return acks;
  }

  /** Changes after `since`, excluding the requesting device's own writes. */
  async pull(userId: string, since: string | null, limit: number, deviceId: string): Promise<{ changes: RemoteChange[]; cursor: string | null }> {
    const from = Number.parseInt(String(since ?? '0'), 10);
    const fromSeq = Number.isFinite(from) && from > 0 ? from : 0;
    const take = Math.min(Math.max(1, Number(limit) || 200), 1000);

    const rows = await this.db.all<FeedRow>(
      `SELECT seq, entity_type, entity_id, version, base_version, payload, deleted, origin_device, updated_at
       FROM sync_feed
       WHERE user_id = ? AND seq > ? AND (origin_device IS NULL OR origin_device <> ?)
       ORDER BY seq ASC LIMIT ?`,
      [userId, fromSeq, deviceId, take],
    );

    const changes: RemoteChange[] = rows.map((row) => ({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      version: Number(row.version),
      base_version: Number(row.base_version),
      payload: safeParse(row.payload),
      deleted: Number(row.deleted) === 1,
      updated_at: row.updated_at,
      origin_device: row.origin_device,
      seq: String(row.seq),
    }));

    // A real cursor always moves forward, even when nothing new exists for this device —
    // otherwise clients rescan the whole feed on every cycle.
    const head = await this.headSeq(userId);
    const cursor = changes.length ? String(changes[changes.length - 1].seq!) : String(Math.max(head, fromSeq));

    await this.touchDevice(userId, deviceId);
    return { changes, cursor };
  }

  async status(userId: string): Promise<SyncStatus> {
    const entities = await this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sync_entities WHERE user_id = ? AND deleted = 0', [userId],
    );
    const deleted = await this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sync_entities WHERE user_id = ? AND deleted = 1', [userId],
    );
    const feed = await this.db.get<{ n: number; head: number | null; last: string | null }>(
      'SELECT COUNT(*) AS n, MAX(seq) AS head, MAX(created_at) AS last FROM sync_feed WHERE user_id = ?', [userId],
    );
    const devices = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [userId]);
    return {
      entities: Number(entities?.n ?? 0),
      deletedEntities: Number(deleted?.n ?? 0),
      feedLength: Number(feed?.n ?? 0),
      headSeq: Number(feed?.head ?? 0),
      lastChangeAt: feed?.last ?? null,
      devices: Number(devices?.n ?? 0),
    };
  }

  /** One entity as the server currently holds it (used by support tooling and tests). */
  async entity(userId: string, entityType: string, entityId: string): Promise<{ version: number; payload: Record<string, unknown>; deleted: boolean } | null> {
    const row = await this.db.get<StoredEntity>(
      'SELECT * FROM sync_entities WHERE user_id = ? AND entity_type = ? AND entity_id = ?',
      [userId, entityType, entityId],
    );
    return row ? { version: Number(row.version), payload: safeParse(row.payload), deleted: Number(row.deleted) === 1 } : null;
  }

  private async headSeq(userId: string): Promise<number> {
    const row = await this.db.get<{ head: number | null }>('SELECT MAX(seq) AS head FROM sync_feed WHERE user_id = ?', [userId]);
    return Number(row?.head ?? 0);
  }

  private async upsertEntity(userId: string, operation: PushOperation, payload: string, deleted: number, version: number, deviceId: string): Promise<void> {
    const receivedAt = nowIso();
    await this.db.run(
      `INSERT INTO sync_entities (user_id, entity_type, entity_id, version, payload, deleted, origin_device, updated_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, entity_type, entity_id) DO UPDATE SET
         version = excluded.version, payload = excluded.payload, deleted = excluded.deleted,
         origin_device = excluded.origin_device, updated_at = excluded.updated_at, received_at = excluded.received_at`,
      [userId, operation.entity_type, operation.entity_id, version, payload, deleted, deviceId, operation.updated_at ?? receivedAt, receivedAt],
    );
  }

  private async appendFeed(userId: string, operation: PushOperation, payload: string, deleted: number, version: number, baseVersion: number, deviceId: string): Promise<void> {
    await this.db.run(
      `INSERT INTO sync_feed (user_id, entity_type, entity_id, version, base_version, payload, deleted, origin_device, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, operation.entity_type, operation.entity_id, version, baseVersion, payload, deleted, deviceId, operation.updated_at ?? nowIso(), nowIso()],
    );
  }

  private async touchDevice(userId: string, deviceId: string): Promise<void> {
    if (!deviceId) return;
    const now = nowIso();
    await this.db.run(
      `INSERT INTO devices (user_id, device_id, name, platform, registered_at, last_seen_at)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [userId, deviceId, now, now],
    );
  }
}

function validateOperation(operation: PushOperation): string | null {
  if (!operation || typeof operation !== 'object') return 'operation must be an object';
  if (typeof operation.operation_id !== 'string' || !operation.operation_id) return 'operation_id is required';
  if (typeof operation.entity_type !== 'string' || !ENTITY_TYPE_RE.test(operation.entity_type)) return `unsupported entity_type: ${String(operation.entity_type).slice(0, 40)}`;
  if (typeof operation.entity_id !== 'string' || !operation.entity_id || operation.entity_id.length > MAX_ENTITY_ID_LENGTH) return 'entity_id is required (max 96 chars)';
  if (!['create', 'update', 'delete'].includes(operation.operation_type)) return `unsupported operation_type: ${String(operation.operation_type)}`;
  if (!Number.isFinite(Number(operation.version)) || Number(operation.version) < 1) return 'version must be >= 1';
  if (!Number.isFinite(Number(operation.base_version)) || Number(operation.base_version) < 0) return 'base_version must be >= 0';
  if (!operation.payload || typeof operation.payload !== 'object') return 'payload must be an object';
  const size = Buffer.byteLength(JSON.stringify(operation.payload), 'utf8');
  if (size > MAX_PAYLOAD_BYTES) return `payload too large (${size} bytes, max ${MAX_PAYLOAD_BYTES})`;
  return null;
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
