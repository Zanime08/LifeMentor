import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { MemoryBackupStorage, type BackupStorage } from '../src/platform/storage';
import type { SecureStorage } from '../src/platform/adapter';
import { AuthService, type AuthTokens, type AuthTransport } from '../src/services/auth';
import { AppError } from '../src/util/result';

/**
 * Account layer (req. 20, 56, 58): tokens live in the platform secure store, never in SQLite;
 * the local session row keeps metadata only; the app stays fully usable with no account at all.
 */

// ─────────────────────────── test doubles ───────────────────────────
class FakeSecureStore implements SecureStorage {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

interface ServerAccount { user_id: string; email: string; password: string; display_name: string | null; plan: string }

class FakeAuthServer implements AuthTransport {
  readonly accounts = new Map<string, ServerAccount>();
  readonly refreshTokens = new Map<string, string>(); // refresh token → user id
  readonly calls: string[] = [];
  offline = false;
  rejectRefresh = false;
  private counter = 0;

  private network(): void {
    if (this.offline) {
      const error = new Error('fetch failed: ECONNREFUSED');
      (error as Error & { code?: string }).code = 'network';
      throw error;
    }
  }

  private tokens(account: ServerAccount, minutes = 60): AuthTokens {
    this.counter += 1;
    const access = `access-${this.counter}`;
    const refresh = `refresh-${this.counter}`;
    this.refreshTokens.set(refresh, account.user_id);
    return {
      user_id: account.user_id, email: account.email, display_name: account.display_name, plan: account.plan,
      access_token: access, refresh_token: refresh,
      access_expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    };
  }

  async register(input: { email: string; password: string; display_name?: string | null }): Promise<AuthTokens> {
    this.network();
    this.calls.push('register');
    if ([...this.accounts.values()].some((a) => a.email === input.email)) {
      throw new AppError('conflict', 'email already registered');
    }
    const account: ServerAccount = {
      user_id: `user_${this.accounts.size + 1}`, email: input.email,
      password: input.password, display_name: input.display_name ?? null, plan: 'free',
    };
    this.accounts.set(account.user_id, account);
    return this.tokens(account);
  }

  async login(input: { email: string; password: string }): Promise<AuthTokens> {
    this.network();
    this.calls.push('login');
    const account = [...this.accounts.values()].find((a) => a.email === input.email);
    if (!account || account.password !== input.password) throw new AppError('unauthorized', 'invalid credentials');
    return this.tokens(account);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    this.network();
    this.calls.push('refresh');
    if (this.rejectRefresh) throw new AppError('unauthorized', 'refresh token revoked');
    const userId = this.refreshTokens.get(refreshToken);
    if (!userId) throw new AppError('unauthorized', 'unknown refresh token');
    const account = this.accounts.get(userId)!;
    this.refreshTokens.delete(refreshToken);
    return this.tokens(account);
  }

  async logout(refreshToken: string): Promise<void> {
    this.network();
    this.calls.push('logout');
    this.refreshTokens.delete(refreshToken);
  }

  async deleteAccount(): Promise<{ receipt: string; deleted_at: string }> {
    this.network();
    this.calls.push('deleteAccount');
    return { receipt: 'receipt-123', deleted_at: new Date().toISOString() };
  }
}

// ─────────────────────────── harness ───────────────────────────
let dir: string;
let opened = 0;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lifementor-auth-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

async function openDevice(deviceId: string, options: { storage?: BackupStorage } = {}): Promise<LifeMentorApp> {
  opened += 1;
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: join(dir, `${deviceId}-${opened}.sqlite`), durability: 'paranoid' },
    deviceId,
    deviceName: deviceId,
    backup: { storage: options.storage ?? new MemoryBackupStorage(), onFirstLaunch: false },
    recover: false,
  });
}

function authFor(app: LifeMentorApp, transport: AuthTransport | undefined, store: FakeSecureStore): AuthService {
  return new AuthService({
    repos: app.repos, secureStorage: store, settings: app.services.settings,
    deviceId: app.deviceId, transport, backup: app.services.backup,
  });
}

const PASSWORD = 'a-strong-passphrase';

/** Backdate the session metadata so the next accessToken() call has to refresh. */
async function expireSession(app: LifeMentorApp): Promise<void> {
  const session = await app.repos.session.findOne({ device_id: app.deviceId });
  await app.repos.session.update(session!.user_id, {
    access_expires_at: new Date(Date.now() - 1000).toISOString(),
  } as never, { actor: 'system', sync: false, audit: false });
}

describe('auth service', () => {
  it('works completely without an account', async () => {
    const app = await openDevice('device-offline');
    const auth = authFor(app, undefined, new FakeSecureStore());

    const state = await auth.state();
    expect(state.authenticated).toBe(false);
    expect(state.offlineOnly).toBe(true);
    expect(state.syncEnabled).toBe(false);
    expect(await auth.accessToken()).toBeNull();
    expect(await auth.currentUser()).toBeNull();

    // every local layer still works
    const goal = await app.services.goals.create({ title: 'No account needed', horizon: 'short' });
    expect((await app.services.goals.get(goal.id))?.title).toBe('No account needed');

    await expect(auth.signIn({ email: 'user@example.com', password: PASSWORD }))
      .rejects.toMatchObject({ code: 'unsupported' });
    await app.close();
  });

  it('stores tokens in the secure store only and keeps the session row secret-free', async () => {
    const server = new FakeAuthServer();
    const store = new FakeSecureStore();
    const app = await openDevice('device-a');
    await app.services.settings.setMany({ sync: { server_url: 'https://sync.lifementor.test' } }, { actor: 'user' });
    const auth = authFor(app, server, store);

    const state = await auth.signUp({ email: ' Ada@Example.COM ', password: PASSWORD, displayName: 'Ada' });
    expect(server.calls).toEqual(['register']);
    expect(state.authenticated).toBe(true);
    expect(state.email).toBe('ada@example.com'); // normalised before it ever left the device
    expect(state.displayName).toBe('Ada');
    expect(state.syncEnabled).toBe(true);
    expect(state.serverUrl).toBe('https://sync.lifementor.test');

    // tokens in the keystore, never in SQLite
    expect(store.values.get('lifementor.access_token')).toBe('access-1');
    expect(store.values.get('lifementor.refresh_token')).toBe('refresh-1');
    const session = await app.repos.session.findOne({ device_id: app.deviceId });
    expect(session?.user_id).toBe('user_1');
    expect(session?.access_token).toBeNull();
    expect(session?.refresh_token).toBeNull();
    expect(session?.access_expires_at).toBeTruthy();

    // the whole database contains no token material
    const dump = JSON.stringify(await app.repos.db.all('SELECT * FROM session'));
    expect(dump).not.toContain('access-1');
    expect(dump).not.toContain('refresh-1');

    // signing in enabled sync
    const settings = await app.services.settings.all();
    expect(settings.sync.enabled).toBe(true);
    expect(settings.sync.auto_sync).toBe(true);
    expect(await auth.accessToken()).toBe('access-1');

    await app.close();
  });

  it('rejects weak credentials on the device before any network call', async () => {
    const server = new FakeAuthServer();
    const app = await openDevice('device-a');
    const auth = authFor(app, server, new FakeSecureStore());

    await expect(auth.signUp({ email: 'not-an-email', password: PASSWORD })).rejects.toMatchObject({ code: 'validation' });
    await expect(auth.signUp({ email: 'ada@example.com', password: 'short' })).rejects.toMatchObject({ code: 'validation' });
    expect(server.calls).toEqual([]);

    await app.close();
  });

  it('signs in on a second device against the same account', async () => {
    const server = new FakeAuthServer();
    const first = await openDevice('device-a');
    await first.services.settings.setMany({ sync: { server_url: 'https://sync.lifementor.test' } }, { actor: 'user' });
    const firstAuth = authFor(first, server, new FakeSecureStore());
    const signedUp = await firstAuth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const userId = signedUp.userId!;

    const second = await openDevice('device-b');
    await second.services.settings.setMany({ sync: { server_url: 'https://sync.lifementor.test' } }, { actor: 'user' });
    const secondStore = new FakeSecureStore();
    const secondAuth = authFor(second, server, secondStore);

    const state = await secondAuth.signIn({ email: 'ada@example.com', password: PASSWORD });
    expect(state.authenticated).toBe(true);
    expect(state.userId).toBe(userId);
    expect(secondStore.values.get('lifementor.access_token')).toBeTruthy();

    await expect(secondAuth.signIn({ email: 'ada@example.com', password: 'wrong-passphrase' }))
      .rejects.toMatchObject({ code: 'unauthorized' });

    await first.close();
    await second.close();
  });

  it('refreshes an expiring token, and keeps working offline', async () => {
    const server = new FakeAuthServer();
    const store = new FakeSecureStore();
    const app = await openDevice('device-a');
    const auth = authFor(app, server, store);
    await auth.signUp({ email: 'ada@example.com', password: PASSWORD });

    // force expiry in the session metadata
    await expireSession(app);

    const refreshed = await auth.accessToken();
    expect(refreshed).toBe('access-2');
    expect(server.calls).toContain('refresh');
    expect(store.values.get('lifementor.refresh_token')).toBe('refresh-2');

    // offline: the current token is kept rather than dropping the session
    server.offline = true;
    await expireSession(app);
    expect(await auth.accessToken()).toBe('access-2');
    expect(await auth.isAuthenticated()).toBe(true);

    // a revoked refresh token ends the session locally
    server.offline = false;
    server.rejectRefresh = true;
    expect(await auth.refresh()).toBeNull();
    expect(await auth.isAuthenticated()).toBe(false);
    expect(store.values.get('lifementor.access_token')).toBeUndefined();
    expect(await app.repos.session.findOne({ device_id: app.deviceId })).toBeUndefined();

    await app.close();
  });

  it('signs out without touching local data', async () => {
    const server = new FakeAuthServer();
    const store = new FakeSecureStore();
    const app = await openDevice('device-a');
    const auth = authFor(app, server, store);
    await auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    const goal = await app.services.goals.create({ title: 'Stays on the device', horizon: 'long' });

    const result = await auth.signOut();
    expect(result.signedOut).toBe(true);
    expect(result.localDataKept).toBe(true);
    expect(server.calls).toContain('logout');
    expect(store.values.size).toBe(0);
    expect(await app.repos.session.findOne({ device_id: app.deviceId })).toBeUndefined();
    expect((await app.services.goals.get(goal.id))?.title).toBe('Stays on the device');

    const settings = await app.services.settings.all();
    expect(settings.sync.enabled).toBe(false);

    // signing out while offline still works
    const second = await openDevice('device-b');
    const secondStore = new FakeSecureStore();
    const secondAuth = authFor(second, server, secondStore);
    await secondAuth.signIn({ email: 'ada@example.com', password: PASSWORD });
    server.offline = true;
    expect((await secondAuth.signOut()).signedOut).toBe(true);
    expect(secondStore.values.size).toBe(0);

    await app.close();
    await second.close();
  });

  it('deletes the account: server copy, export, then every local row', async () => {
    const server = new FakeAuthServer();
    const storage = new MemoryBackupStorage();
    const app = await openDevice('device-a', { storage });
    const auth = authFor(app, server, new FakeSecureStore());
    await auth.signUp({ email: 'ada@example.com', password: PASSWORD });
    await app.services.goals.create({ title: 'Deleted with the account', horizon: 'short' });
    await app.services.memory.save({ kind: 'fact', content: 'Private detail', importance: 0.9 });

    const result = await auth.deleteAccount({ confirmText: 'DELETE my account' });
    expect(result.deleted).toBe(true);
    expect(result.receipt).toBe('receipt-123');
    expect(server.calls).toContain('deleteAccount');
    expect(await app.services.goals.list({ includeArchived: true })).toHaveLength(0);
    expect(await app.services.memory.list({ limit: 50 })).toHaveLength(0);
    expect(await auth.isAuthenticated()).toBe(false);

    // the export written before deletion still holds the data
    expect(result.exportPath).toBeTruthy();
    const files = await storage.list();
    expect(files.some((f) => f.name.startsWith('LifeMentor-export'))).toBe(true);

    await app.close();
  });

  it('refuses a confirmation phrase that does not say delete', async () => {
    const server = new FakeAuthServer();
    const app = await openDevice('device-a');
    const auth = authFor(app, server, new FakeSecureStore());
    await auth.signUp({ email: 'ada@example.com', password: PASSWORD });

    await expect(auth.deleteAccount({ confirmText: 'yes please' })).rejects.toMatchObject({ code: 'validation' });
    expect(server.calls).not.toContain('deleteAccount');
    expect((await app.services.goals.list({})).length).toBe(0);

    await app.close();
  });
});
