import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, newId, nowIso } from '@lifementor/core';
import type { ServerDb } from '../db';

/**
 * Sessions (docs/08 §2, req. 57).
 *
 *  - **Access token**: short-lived JWT (15 min default), HMAC-signed with `JWT_SECRET`.
 *    Carries only `sub` (user id) and `did` (device id) — no personal data.
 *  - **Refresh token**: opaque 256-bit random string, **stored only as a SHA-256 hash**,
 *    rotating on every use, bound to the device that received it, and revocable per device
 *    or per user. A stolen database therefore yields no usable tokens.
 */

export interface JwtSigner {
  sign(payload: Record<string, unknown>, expiresInSeconds: number): Promise<string>;
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface AccessTokenClaims {
  userId: string;
  deviceId: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
}

export interface RefreshTokenRow {
  token_hash: string;
  user_id: string;
  device_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  rotated_from: string | null;
  revoked_at: string | null;
}

export class TokenService {
  constructor(
    private readonly db: ServerDb,
    private readonly jwt: JwtSigner,
    private readonly config: { accessTtlSeconds: number; refreshTtlDays: number },
  ) {}

  /** Issue a fresh access + refresh pair for an authenticated user/device. */
  async issue(userId: string, deviceId: string, rotatedFrom: string | null = null): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    const issuedAt = Date.now();
    const accessExpiresAt = new Date(issuedAt + this.config.accessTtlSeconds * 1000).toISOString();
    const refreshExpiresAt = new Date(issuedAt + this.config.refreshTtlDays * 86_400_000).toISOString();

    const accessToken = await this.jwt.sign(
      { sub: userId, did: deviceId, jti: newId('session') },
      this.config.accessTtlSeconds,
    );

    await this.db.run(
      `INSERT INTO refresh_tokens (token_hash, user_id, device_id, created_at, expires_at, last_used_at, rotated_from, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      [hashToken(refreshToken), userId, deviceId, nowIso(), refreshExpiresAt, rotatedFrom],
    );
    await this.registerDevice(userId, deviceId);

    return { access_token: accessToken, refresh_token: refreshToken, access_expires_at: accessExpiresAt };
  }

  /**
   * Rotate a refresh token: the presented token is revoked and a new pair is returned.
   * Re-use of an already rotated token revokes the whole device (classic token-theft signal).
   */
  async rotate(refreshToken: string, deviceId: string): Promise<TokenPair> {
    const presented = hashToken(refreshToken);
    const row = await this.db.get<RefreshTokenRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ?', [presented],
    );
    if (!row) throw AppError.unauthorized('Unknown refresh token');
    if (row.revoked_at) {
      // Replayed token → the device's sessions can no longer be trusted.
      await this.revokeDevice(row.user_id, row.device_id, 'refresh token replayed');
      throw AppError.unauthorized('Refresh token was already used — all sessions on that device were signed out');
    }
    if (!sameDevice(row.device_id, deviceId)) {
      throw AppError.unauthorized('Refresh token does not belong to this device');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await this.revoke(presented, 'expired');
      throw AppError.unauthorized('Refresh token expired — please sign in again');
    }

    return this.db.transaction(async () => {
      await this.db.run(
        'UPDATE refresh_tokens SET revoked_at = ?, last_used_at = ? WHERE token_hash = ?',
        [nowIso(), nowIso(), presented],
      );
      return this.issue(row.user_id, row.device_id, presented);
    });
  }

  /** Revoke a single token by its stored hash. */
  async revoke(tokenHash: string, reason: string): Promise<void> {
    await this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [`${nowIso()} (${reason})`.slice(0, 200), tokenHash],
    );
  }

  /** Sign out one device (also used by `DELETE /v1/devices/:id`). */
  async revokeDevice(userId: string, deviceId: string, reason: string): Promise<number> {
    const result = await this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL',
      [`${nowIso()} (${reason})`.slice(0, 200), userId, deviceId],
    );
    return result.changes;
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [`${nowIso()} (${reason})`.slice(0, 200), userId],
    );
    return result.changes;
  }

  /** A device that authenticates is a device the user can see and revoke. */
  private async registerDevice(userId: string, deviceId: string): Promise<void> {
    if (!deviceId) return;
    const at = nowIso();
    await this.db.run(
      `INSERT INTO devices (user_id, device_id, name, platform, registered_at, last_seen_at)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [userId, deviceId, at, at],
    );
  }

  /** Verify an access token and return its claims. Throws `unauthorized` on any problem. */
  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verify(token);
    } catch {
      throw AppError.unauthorized('Session expired or invalid — please sign in again');
    }
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    const deviceId = typeof payload.did === 'string' ? payload.did : '';
    if (!userId) throw AppError.unauthorized('Malformed access token');
    return { userId, deviceId };
  }

  async activeSessions(userId: string): Promise<{ device_id: string; created_at: string; expires_at: string; last_used_at: string | null }[]> {
    return this.db.all(
      `SELECT device_id, created_at, expires_at, last_used_at FROM refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
      [userId, nowIso()],
    );
  }

  /** Drop tokens that expired more than a week ago — the table must not grow forever. */
  async pruneExpired(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = await this.db.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [cutoff]);
    return result.changes;
  }
}

/** Refresh tokens are stored hashed; comparison is constant-time on the hash bytes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sameDevice(stored: string, presented: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(presented ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
