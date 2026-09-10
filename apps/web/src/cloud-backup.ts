/**
 * Cloud backup client (docs/08 §1).
 *
 * The archive is encrypted ON THIS DEVICE with AES-GCM (WebCrypto) using a 256-bit key kept in
 * the platform secure storage; the server stores only ciphertext it cannot read, plus a sha256
 * checksum for integrity. Honest limitation: if the browser storage is wiped, the key is lost
 * and the cloud copy becomes undecryptable (local backups and export remain unaffected).
 */
import type { ExportArchive, LifeMentorApp } from '@lifementor/core';
import { SERVER_URL } from './core/app';

const KEY_STORAGE_ID = 'lifementor.cloud_backup.key';
const FORMAT = 'lifementor-archive/v1';

export interface CloudBackupStatus {
  exists: boolean;
  size_bytes?: number;
  checksum?: string;
  format?: string | null;
  created_at?: string;
  uploaded_at?: string;
  note?: string | null;
}

// ─────────────────────────── device key ───────────────────────────

async function ensureKey(app: LifeMentorApp): Promise<Uint8Array> {
  const stored = await app.platform.secureStorage.get(KEY_STORAGE_ID);
  if (stored) {
    const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    if (bytes.length === 32) return bytes;
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (let i = 0; i < key.length; i += 1) bin += String.fromCharCode(key[i]);
  await app.platform.secureStorage.set(KEY_STORAGE_ID, btoa(bin));
  return key;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Copy into a fresh ArrayBuffer-backed view (what SubtleCrypto's types require). */
function toBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

async function encryptJson(json: string, key: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, toBuffer(new TextEncoder().encode(json))));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

async function decryptJson(blob: Uint8Array, key: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(blob.subarray(0, 12)) }, cryptoKey, toBuffer(blob.subarray(12)));
  return new TextDecoder().decode(plain);
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes as BufferSource).then((hash) =>
    Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
}

// ─────────────────────────── server operations ───────────────────────────

async function authHeader(app: LifeMentorApp): Promise<Record<string, string>> {
  const token = await app.services.auth.accessToken();
  if (!token) throw new Error('Нужен вход в аккаунт, чтобы пользоваться облачной копией');
  return { authorization: `Bearer ${token}` };
}

export async function cloudBackupStatus(app: LifeMentorApp): Promise<CloudBackupStatus> {
  const token = await app.services.auth.accessToken();
  if (!token) return { exists: false };
  const res = await fetch(`${SERVER_URL}/v1/backup/latest`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  return (await res.json()) as CloudBackupStatus;
}

/** Export → encrypt on device → upload ciphertext. */
export async function uploadCloudBackup(app: LifeMentorApp): Promise<CloudBackupStatus> {
  const headers = await authHeader(app);
  const archive = await app.services.backup.exportArchive({ includeNews: true });
  const key = await ensureKey(app);
  const blob = await encryptJson(JSON.stringify(archive), key);
  const checksum = await sha256Hex(blob);
  const res = await fetch(`${SERVER_URL}/v1/backup`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      checksum,
      format: FORMAT,
      created_at: archive.manifest.exported_at,
      note: 'encrypted cloud backup',
      blob: bytesToB64(blob),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`загрузка не удалась (${res.status})${text ? `: ${text.slice(0, 140)}` : ''}`);
  }
  const meta = (await res.json()) as Omit<CloudBackupStatus, 'exists'>;
  return { exists: true, ...meta };
}

/** Download ciphertext → decrypt on device → parse the archive (structure checked). */
export async function downloadCloudBackup(app: LifeMentorApp): Promise<{ archive: ExportArchive; meta: CloudBackupStatus }> {
  const headers = await authHeader(app);
  const res = await fetch(`${SERVER_URL}/v1/backup/latest?blob=1`, { headers });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const payload = (await res.json()) as (CloudBackupStatus & { blob?: string });
  if (!payload.exists || !payload.blob) throw new Error('облачной копии нет');
  const bytes = Uint8Array.from(atob(payload.blob), (c) => c.charCodeAt(0));
  const key = await ensureKey(app);
  let json: string;
  try {
    json = await decryptJson(bytes, key);
  } catch {
    throw new Error('расшифровать не удалось: ключ хранится в этом браузере. Если хранилище было очищено — облачная копия невосстановима, но локальные копии и экспорт работают');
  }
  const archive = await app.services.backup.parseArchive(json); // throws on structure/version mismatch
  return { archive, meta: payload };
}

export async function deleteCloudBackup(app: LifeMentorApp): Promise<boolean> {
  const headers = await authHeader(app);
  const res = await fetch(`${SERVER_URL}/v1/backup`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
  const { removed } = (await res.json()) as { removed: boolean };
  return removed;
}
