import { createHash } from 'node:crypto';
import { AppError, createLogger } from '@lifementor/core';
import type { ServerDb } from '../db';

/**
 * Cloud backup slot (docs/08 §1). One latest backup per user.
 *
 * The blob is client-encrypted (AES-GCM with a device-held key) — the server stores only
 * ciphertext it cannot read. The sha256 checksum is computed by the server on upload and
 * re-checked on download, so bit rot or a tampered row is caught before it reaches the client.
 */

/** Hard cap for one backup blob (25 MB) — beyond that the route rejects the body. */
export const MAX_BACKUP_BLOB_BYTES = 25 * 1024 * 1024;

export interface CloudBackupMeta {
  size_bytes: number;
  checksum: string;
  format: string | null;
  created_at: string;
  uploaded_at: string;
  device_id: string | null;
  note: string | null;
}

export interface CloudBackupUploadInput {
  blob: Uint8Array | Buffer;
  checksum: string; // client-claimed sha256 hex — the server recomputes and compares
  format?: string | null;
  createdAt: string;
  deviceId?: string | null;
  note?: string | null;
}

interface Row extends CloudBackupMeta {
  blob: Uint8Array | Buffer;
}

export class CloudBackupStore {
  private readonly log = createLogger('backup');

  constructor(private readonly db: ServerDb) {}

  sha256Hex(bytes: Uint8Array | Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  async upload(userId: string, input: CloudBackupUploadInput): Promise<CloudBackupMeta> {
    const size = input.blob.byteLength;
    if (size === 0) throw AppError.validation('backup blob is empty');
    if (size > MAX_BACKUP_BLOB_BYTES) {
      throw AppError.validation(`backup too large (${size} bytes, max ${MAX_BACKUP_BLOB_BYTES})`);
    }
    const actual = this.sha256Hex(input.blob);
    if (actual !== input.checksum.toLowerCase()) {
      // A mismatch means the transfer is broken (or someone is lying) — refuse, don't store.
      this.log.warn('backup checksum mismatch on upload', { userId, expected: input.checksum, actual });
      throw AppError.validation('checksum mismatch — upload rejected');
    }
    const uploadedAt = new Date().toISOString();
    await this.db.run(
      `INSERT INTO cloud_backups (user_id, blob, size_bytes, checksum, format, created_at, uploaded_at, device_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         blob = excluded.blob,
         size_bytes = excluded.size_bytes,
         checksum = excluded.checksum,
         format = excluded.format,
         created_at = excluded.created_at,
         uploaded_at = excluded.uploaded_at,
         device_id = excluded.device_id,
         note = excluded.note`,
      [userId, input.blob, size, actual, input.format ?? null, input.createdAt, uploadedAt, input.deviceId ?? null, input.note ?? null],
    );
    this.log.info('cloud backup uploaded', { userId, size });
    return { size_bytes: size, checksum: actual, format: input.format ?? null, created_at: input.createdAt, uploaded_at: uploadedAt, device_id: input.deviceId ?? null, note: input.note ?? null };
  }

  /** Metadata only (cheap) — used by the status line in settings. */
  async latestMeta(userId: string): Promise<CloudBackupMeta | null> {
    const row = await this.db.get<CloudBackupMeta>(
      `SELECT size_bytes, checksum, format, created_at, uploaded_at, device_id, note FROM cloud_backups WHERE user_id = ?`,
      [userId],
    );
    return row ?? null;
  }

  /** The encrypted blob; the checksum is re-verified before returning it. */
  async latestBlob(userId: string): Promise<(CloudBackupMeta & { blob: Uint8Array | Buffer }) | null> {
    const row = await this.db.get<Row>(`SELECT * FROM cloud_backups WHERE user_id = ?`, [userId]);
    if (!row) return null;
    const actual = this.sha256Hex(row.blob);
    if (actual !== row.checksum) {
      this.log.error('cloud backup checksum mismatch on download — row corrupted', { userId });
      throw new Error('stored backup failed the integrity check');
    }
    return { ...row };
  }

  async remove(userId: string): Promise<boolean> {
    const r = await this.db.run(`DELETE FROM cloud_backups WHERE user_id = ?`, [userId]);
    if (r.changes > 0) this.log.info('cloud backup removed', { userId });
    return r.changes > 0;
  }
}
