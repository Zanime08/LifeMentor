import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '@lifementor/core';

/**
 * Password hashing with scrypt from `node:crypto` (docs/08 §2) — no native dependency,
 * which matters because the server has to install with a plain `npm install` on any host.
 *
 * Parameters: N=16384, r=8, p=1, 64-byte key, 16-byte per-user salt. The parameters are stored
 * with the hash so they can be raised later without invalidating existing accounts.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export interface PasswordRecord {
  hash: string;
  salt: string;
  params: string;
}

export function encodeParams(): string {
  return `scrypt$${N}$${R}$${P}$${KEY_LENGTH}`;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  assertPassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(password, salt, N, R, P, KEY_LENGTH);
  return { hash: derived.toString('hex'), salt: salt.toString('hex'), params: encodeParams() };
}

/** Constant-time verification. Accepts the stored parameter string so old hashes stay valid. */
export async function verifyPassword(password: string, stored: { password_hash: string; password_salt: string; params?: string | null }): Promise<boolean> {
  const [scheme, n, r, p, keyLength] = (stored.params ?? encodeParams()).split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(stored.password_salt, 'hex');
  const derived = await derive(password, salt, Number(n), Number(r), Number(p), Number(keyLength));
  const expected = Buffer.from(stored.password_hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Server-side policy; the client validates first so mistakes never travel. */
export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 10) {
    throw new AppError('validation', 'Password must be at least 10 characters', {
      userMessage: 'Use at least 10 characters — this password protects your sync and AI access.',
    });
  }
  if (password.length > 512) {
    throw AppError.validation('Password is too long (max 512 characters)');
  }
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
