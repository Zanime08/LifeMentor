import { AppError, newId, nowIso } from '@lifementor/core';
import type { ServerDb } from '../db';
import { hashPassword, verifyPassword, assertPassword } from './passwords';

/**
 * Accounts (docs/08 §2; req. 20, 56, 57).
 *
 * The server knows an email, a scrypt hash and a plan. It never sees the user's goals, tasks or
 * memories as *content* — those only pass through the sync feed as opaque payloads.
 */

export interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  display_name: string | null;
  plan: string;
  created_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

export interface PublicUser {
  user_id: string;
  email: string;
  display_name: string | null;
  plan: string;
  created_at: string;
  last_login_at: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export function normaliseEmail(email: string): string {
  const value = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(value) || value.length > 254) {
    throw AppError.validation('That does not look like an email address', { field: 'email' });
  }
  return value;
}

export class UserStore {
  constructor(private readonly db: ServerDb) {}

  async create(input: { email: string; password: string; displayName?: string | null; plan?: string }): Promise<PublicUser> {
    const email = normaliseEmail(input.email);
    assertPassword(input.password);
    if (await this.findByEmail(email)) throw AppError.conflict('That email already has an account');

    const credentials = await hashPassword(input.password);
    const userId = `user_${newId()}`;
    const createdAt = nowIso();

    await this.db.run(
      `INSERT INTO users (user_id, email, password_hash, password_salt, display_name, plan, created_at, last_login_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        userId, email, credentials.hash, credentials.salt,
        input.displayName?.trim() ? input.displayName.trim().slice(0, 120) : null,
        input.plan ?? 'free', createdAt, createdAt,
      ],
    );
    return { user_id: userId, email, display_name: input.displayName ?? null, plan: input.plan ?? 'free', created_at: createdAt, last_login_at: createdAt };
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [normaliseEmail(email)]);
  }

  async findById(userId: string): Promise<UserRow | undefined> {
    return this.db.get<UserRow>('SELECT * FROM users WHERE user_id = ? AND deleted_at IS NULL', [userId]);
  }

  /**
   * Verify credentials. A wrong password and an unknown email produce the same error, so the
   * endpoint cannot be used to enumerate accounts.
   */
  async authenticate(email: string, password: string): Promise<UserRow> {
    const normalised = normaliseEmail(email);
    const user = await this.db.get<UserRow>('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [normalised]);
    const ok = user ? await verifyPassword(password, user) : false;
    if (!user || !ok) throw AppError.unauthorized('Email or password is incorrect');
    await this.db.run('UPDATE users SET last_login_at = ? WHERE user_id = ?', [nowIso(), user.user_id]);
    return user;
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<{ changed: true }> {
    const user = await this.findById(userId);
    if (!user) throw AppError.notFound('account', userId);
    if (!(await verifyPassword(currentPassword, user))) throw AppError.unauthorized('Current password is incorrect');
    assertPassword(nextPassword);
    const credentials = await hashPassword(nextPassword);
    await this.db.run(
      'UPDATE users SET password_hash = ?, password_salt = ? WHERE user_id = ?',
      [credentials.hash, credentials.salt, userId],
    );
    return { changed: true };
  }

  async updateProfile(userId: string, patch: { display_name?: string | null; plan?: string }): Promise<PublicUser> {
    const user = await this.findById(userId);
    if (!user) throw AppError.notFound('account', userId);
    const displayName = patch.display_name !== undefined ? (patch.display_name?.trim().slice(0, 120) || null) : user.display_name;
    const plan = patch.plan ?? user.plan;
    await this.db.run('UPDATE users SET display_name = ?, plan = ? WHERE user_id = ?', [displayName, plan, userId]);
    return toPublic({ ...user, display_name: displayName, plan });
  }

  /**
   * Account deletion (req. 56). Hard-deletes everything the server holds for the user:
   * the account row, sessions, devices, the whole sync feed and entity state, AI usage.
   * A single audit entry survives (no personal data) so the operator can answer "was it deleted?".
   */
  async purge(userId: string): Promise<{ deletedTables: number; rows: number }> {
    const tables = ['sync_feed', 'sync_entities', 'ai_usage', 'refresh_tokens', 'devices', 'audit_log', 'users'];
    let rows = 0;
    await this.db.transaction(async () => {
      for (const table of tables) {
        const result = await this.db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
        rows += result.changes;
      }
    });
    return { deletedTables: tables.length, rows };
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL');
    return Number(row?.n ?? 0);
  }
}

export function toPublic(user: UserRow): PublicUser {
  return {
    user_id: user.user_id, email: user.email, display_name: user.display_name,
    plan: user.plan, created_at: user.created_at, last_login_at: user.last_login_at,
  };
}
