import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/app';
import { loadConfig } from '../src/config';
import { MAX_BACKUP_BLOB_BYTES } from '../src/services/cloud-backup';
import type { ServerConfig } from '../src/config';

function testConfig(): ServerConfig {
  const config = loadConfig();
  return { ...config, env: 'test', databaseInMemory: true, jwtSecret: 'test-secret-0123456789' } as ServerConfig;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function b64(bytes: Buffer): string { return bytes.toString('base64'); }

async function register(app: { inject: (req: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): unknown }> }, email: string): Promise<string> {
  const registered = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email, password: 'supersecret1', device_id: 'device-backup' },
  });
  expect(registered.statusCode).toBe(201);
  return (registered.json() as { access_token: string }).access_token;
}

const BLOB = Buffer.from('ciphertext-bytes-that-the-server-cannot-read-0123456789');

describe('cloud backup (server)', () => {
  it('upload → status → download round-trips the exact bytes; checksum is verified', async () => {
    const { app, shutdown } = await buildServer(testConfig());
    try {
      const token = await register(app, 'backup1@test.dev');
      const auth = { authorization: `Bearer ${token}` };

      // no backup yet
      const none = await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: auth });
      expect(none.json()).toEqual({ exists: false });

      // upload
      const up = await app.inject({
        method: 'POST', url: '/v1/backup', headers: auth,
        payload: {
          checksum: sha256(BLOB), format: 'lifementor-archive/v1',
          created_at: '2026-09-08T10:00:00.000Z', note: 'e2e', blob: b64(BLOB),
        },
      });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toMatchObject({ ok: true, size_bytes: BLOB.length, format: 'lifementor-archive/v1' });

      // status (metadata only — no blob in the response)
      const meta = await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: auth });
      const metaBody = meta.json() as { exists: boolean; size_bytes: number; blob?: string; created_at: string };
      expect(metaBody.exists).toBe(true);
      expect(metaBody.size_bytes).toBe(BLOB.length);
      expect(metaBody.created_at).toBe('2026-09-08T10:00:00.000Z');
      expect(metaBody.blob).toBeUndefined();

      // download the blob — exact bytes back, integrity re-checked
      const dl = await app.inject({ method: 'GET', url: '/v1/backup/latest?blob=1', headers: auth });
      const dlBody = dl.json() as { exists: boolean; blob: string };
      expect(dlBody.exists).toBe(true);
      expect(Buffer.from(dlBody.blob, 'base64').equals(BLOB)).toBe(true);

      // replace, not duplicate
      const blob2 = Buffer.from('second-backup-ciphertext');
      await app.inject({
        method: 'POST', url: '/v1/backup', headers: auth,
        payload: { checksum: sha256(blob2), created_at: '2026-09-09T10:00:00.000Z', blob: b64(blob2) },
      });
      const rows = await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: auth });
      expect((rows.json() as { size_bytes: number }).size_bytes).toBe(blob2.length);

      // delete
      const del = await app.inject({ method: 'DELETE', url: '/v1/backup', headers: auth });
      expect(del.json()).toMatchObject({ ok: true, removed: true });
      const del2 = await app.inject({ method: 'DELETE', url: '/v1/backup', headers: auth });
      expect((del2.json() as { removed: boolean }).removed).toBe(false);
      const gone = await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: auth });
      expect(gone.json()).toEqual({ exists: false });

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });

  it('rejects a wrong checksum and oversized blobs; users cannot read each other\'s backups', async () => {
    const { app, shutdown } = await buildServer(testConfig());
    try {
      const alice = await register(app, 'backup2a@test.dev');
      const bob = await register(app, 'backup2b@test.dev');
      const aliceAuth = { authorization: `Bearer ${alice}` };
      const bobAuth = { authorization: `Bearer ${bob}` };

      // wrong checksum → 400, nothing stored
      const bad = await app.inject({
        method: 'POST', url: '/v1/backup', headers: aliceAuth,
        payload: { checksum: 'a'.repeat(64), created_at: '2026-09-08T10:00:00.000Z', blob: b64(BLOB) },
      });
      expect(bad.statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: aliceAuth })).json()).toEqual({ exists: false });

      // oversized blob (service guard) → rejected
      const oversized = Buffer.alloc(MAX_BACKUP_BLOB_BYTES + 1, 1);
      const big = await app.inject({
        method: 'POST', url: '/v1/backup', headers: aliceAuth,
        payload: { checksum: sha256(oversized), created_at: '2026-09-08T10:00:00.000Z', blob: b64(oversized) },
      });
      expect(big.statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: aliceAuth })).json()).toEqual({ exists: false });

      // isolation: alice uploads, bob sees nothing
      await app.inject({
        method: 'POST', url: '/v1/backup', headers: aliceAuth,
        payload: { checksum: sha256(BLOB), created_at: '2026-09-08T10:00:00.000Z', blob: b64(BLOB) },
      });
      expect(((await app.inject({ method: 'GET', url: '/v1/backup/latest', headers: aliceAuth })).json() as { exists: boolean }).exists).toBe(true);
      expect(((await app.inject({ method: 'GET', url: '/v1/backup/latest?blob=1', headers: bobAuth })).json() as { exists: boolean }).exists).toBe(false);

      // unauthenticated → 401
      expect((await app.inject({ method: 'GET', url: '/v1/backup/latest' })).statusCode).toBe(401);

      await shutdown();
    } finally {
      await shutdown().catch(() => undefined);
    }
  });
});
