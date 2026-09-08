import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@lifementor/core';
import type { ServerContext } from '../context';
import { clientIp, requestDeviceId } from '../http/auth';
import { MAX_BACKUP_BLOB_BYTES } from '../services/cloud-backup';

/**
 * Cloud backup endpoints (docs/08 §1). The blob arrives base64-encoded inside the JSON body;
 * it is client-encrypted, so the server stores ciphertext it cannot read. The body limit is
 * raised for this route only (base64 inflates the bytes ~33%).
 */

const uploadSchema = z.object({
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 hex expected'),
  format: z.string().max(80).optional(),
  created_at: z.string().min(10).max(40),
  device_id: z.string().max(96).optional(),
  note: z.string().max(200).optional(),
  blob: z.string().min(16).max(Math.ceil((MAX_BACKUP_BLOB_BYTES * 4) / 3) + 8),
});

const base64ToBytes = (b64: string): Buffer => Buffer.from(b64, 'base64');

export function registerBackupRoutes(app: FastifyInstance, context: ServerContext): void {
  const strict = { config: { rateLimit: { max: 10, timeWindow: context.config.rateLimit.windowMs } } };
  // 40 MB body envelope for a 25 MB blob (base64 + JSON overhead).
  const bodyLimit = 40 * 1024 * 1024;

  app.post('/v1/backup', { ...strict, bodyLimit, preHandler: app.authenticate }, async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) {
      throw AppError.validation(`Invalid backup upload: ${parsed.error.issues.map((i) => i.message).join('; ').slice(0, 200)}`);
    }
    const meta = await context.cloudBackup.upload(request.userId, {
      blob: base64ToBytes(parsed.data.blob),
      checksum: parsed.data.checksum,
      format: parsed.data.format,
      createdAt: parsed.data.created_at,
      deviceId: requestDeviceId(request) || parsed.data.device_id || null,
      note: parsed.data.note,
    });
    await context.audit.record({
      event: 'backup_uploaded', userId: request.userId, deviceId: requestDeviceId(request), ip: clientIp(request),
      detail: { size_bytes: meta.size_bytes, checksum: meta.checksum.slice(0, 12) },
    });
    return reply.send({ ok: true, ...meta });
  });

  app.get('/v1/backup/latest', { ...strict, preHandler: app.authenticate }, async (request) => {
    const withBlob = (request.query as { blob?: string } | undefined)?.blob === '1';
    const meta = await context.cloudBackup.latestMeta(request.userId);
    if (!meta) return { exists: false };
    if (!withBlob) return { exists: true, ...meta };
    const full = await context.cloudBackup.latestBlob(request.userId);
    if (!full) return { exists: false };
    await context.audit.record({
      event: 'backup_downloaded', userId: request.userId, deviceId: requestDeviceId(request), ip: clientIp(request),
      detail: { size_bytes: full.size_bytes },
    });
    return { exists: true, ...meta, blob: Buffer.from(full.blob).toString('base64') };
  });

  app.delete('/v1/backup', { ...strict, preHandler: app.authenticate }, async (request, reply) => {
    const removed = await context.cloudBackup.remove(request.userId);
    if (removed) {
      await context.audit.record({ event: 'backup_deleted', userId: request.userId, deviceId: requestDeviceId(request), ip: clientIp(request) });
    }
    return reply.send({ ok: true, removed });
  });
}
