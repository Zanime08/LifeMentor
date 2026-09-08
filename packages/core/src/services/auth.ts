import type { Repos } from '../db/repos';
import type { Account, SessionRow } from '../domain/types';
import type { SecureStorage } from '../platform/adapter';
import type { SettingsService } from './settings';
import type { BackupService } from './backup';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';
import { createLogger } from '../util/logging';

const log = createLogger('auth');

/**
 * Account & session layer (req. 20, 56, 58).
 *
 * Tokens never touch SQLite: they live in the platform secure store (Windows
 * credential manager / Android keystore / sessionStorage in the dev preview), and
 * the local `session` row keeps only non-secret metadata (expiry, device, user id)
 * so the UI can show sign-in state offline.
 *
 * The app is fully usable without an account — signing in only enables sync,
 * cloud AI and cross-device continuity.
 */

export interface AuthTokens {
  user_id: string;
  email: string;
  display_name?: string | null;
  plan?: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
}

export interface AuthTransport {
  register(input: { email: string; password: string; display_name?: string | null; device_id: string }): Promise<AuthTokens>;
  login(input: { email: string; password: string; device_id: string }): Promise<AuthTokens>;
  refresh(refreshToken: string, deviceId: string): Promise<AuthTokens>;
  logout(refreshToken: string): Promise<void>;
  deleteAccount(accessToken: string): Promise<{ receipt: string; deleted_at: string }>;
}

export interface AuthDeps {
  repos: Repos;
  secureStorage: SecureStorage;
  settings: SettingsService;
  deviceId: string;
  transport?: AuthTransport;
  /** Builds a transport on demand (e.g. once a server URL exists in settings). */
  transportFactory?: () => Promise<AuthTransport | null> | AuthTransport | null;
  backup?: BackupService;
}

export interface AuthState {
  authenticated: boolean;
  offlineOnly: boolean;
  email: string | null;
  displayName: string | null;
  userId: string | null;
  plan: string | null;
  serverUrl: string | null;
  expiresAt: string | null;
  expiresInMinutes: number | null;
  syncEnabled: boolean;
}

const ACCESS_KEY = 'lifementor.access_token';
const REFRESH_KEY = 'lifementor.refresh_token';
const REFRESH_SKEW_MS = 60_000;

export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  private async transport(): Promise<AuthTransport> {
    if (this.deps.transport) return this.deps.transport;
    const built = this.deps.transportFactory ? await this.deps.transportFactory() : null;
    if (built) return built;
    throw new AppError('unsupported', 'No LifeMentor server configured for sign-in', {
      userMessage: 'Sign-in needs a LifeMentor server URL (Settings → Sync). Everything else works offline without an account.',
    });
  }

  /** The session row for this device (the table is keyed by user id). */
  private async currentSession(): Promise<SessionRow | null> {
    const row = await this.deps.repos.session.findOne(
      { device_id: this.deps.deviceId }, { orderBy: { updated_at: 'desc' } },
    );
    return row ?? null;
  }

  // ─────────────────────────── account operations ───────────────────────────
  async signUp(input: { email: string; password: string; displayName?: string | null }): Promise<AuthState> {
    assertCredentials(input.email, input.password);
    const serverUrl = await this.serverUrl();
    const tokens = await (await this.transport()).register({
      email: normaliseEmail(input.email), password: input.password,
      display_name: input.displayName ?? null, device_id: this.deps.deviceId,
    });
    await this.persist(tokens, serverUrl, 'registered');
    return this.state();
  }

  async signIn(input: { email: string; password: string }): Promise<AuthState> {
    assertCredentials(input.email, input.password);
    const serverUrl = await this.serverUrl();
    const tokens = await (await this.transport()).login({
      email: normaliseEmail(input.email), password: input.password, device_id: this.deps.deviceId,
    });
    await this.persist(tokens, serverUrl, 'signed in');
    return this.state();
  }

  async signOut(options: { keepLocalData?: boolean } = {}): Promise<{ signedOut: true; localDataKept: boolean }> {
    const refresh = await this.deps.secureStorage.get(REFRESH_KEY);
    if (refresh) {
      try { await (await this.transport()).logout(refresh); } catch (error) {
        // Signing out must work offline too — the server session expires on its own.
        log.warn('server logout failed (continuing locally)', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.deps.secureStorage.remove(ACCESS_KEY);
    await this.deps.secureStorage.remove(REFRESH_KEY);
    const session = await this.currentSession();
    if (session) await this.deps.repos.session.hardDelete(session.user_id, { actor: 'user', sync: false });
    await this.deps.settings.setMany({ sync: { enabled: false, auto_sync: false } }, { actor: 'user' });
    void options;
    log.info('signed out', { localDataKept: true });
    return { signedOut: true, localDataKept: true };
  }

  /**
   * Account deletion (req. 56): export first, ask the server to wipe its copy,
   * then delete every local row, clear tokens and reset onboarding state.
   */
  async deleteAccount(options: { exportFirst?: boolean; confirmText?: string } = {}): Promise<{ deleted: true; receipt: string | null; exportPath: string | null }> {
    if (options.confirmText && !/delete/i.test(options.confirmText)) {
      throw AppError.validation('Confirmation text does not match');
    }
    const access = await this.deps.secureStorage.get(ACCESS_KEY);
    let receipt: string | null = null;
    if (access) {
      try {
        const result = await (await this.transport()).deleteAccount(access);
        receipt = result.receipt;
      } catch (error) {
        // The server copy must not survive a local deletion, so this is fatal unless offline.
        if (!isNetworkError(error)) throw error;
        log.warn('account deletion could not reach the server; local data will be deleted and the request retried on next sign-in', { error: messageOf(error) });
      }
    }

    const exportPath = options.exportFirst === false ? null : await (this.deps.backup?.exportToFile().then((r) => r.path).catch(() => null) ?? null);
    if (this.deps.backup) await this.deps.backup.deleteAllUserData({ exportFirst: false });
    else await this.wipeLocalRows();

    await this.deps.secureStorage.remove(ACCESS_KEY);
    await this.deps.secureStorage.remove(REFRESH_KEY);
    log.info('account deleted locally', { receipt: receipt ? 'received' : 'pending', exported: Boolean(exportPath) });
    return { deleted: true, receipt, exportPath };
  }

  // ─────────────────────────── tokens ───────────────────────────
  /** Access token, refreshed when close to expiry. Returns null when signed out. */
  async accessToken(): Promise<string | null> {
    const access = await this.deps.secureStorage.get(ACCESS_KEY);
    if (!access) return null;
    const session = await this.currentSession();
    if (!session?.access_expires_at) return access;
    const expiresAt = new Date(session.access_expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt - REFRESH_SKEW_MS > Date.now()) return access;
    return this.refresh();
  }

  /** Exchange the refresh token for a new pair. Offline → keep the old token. */
  async refresh(): Promise<string | null> {
    const refreshToken = await this.deps.secureStorage.get(REFRESH_KEY);
    if (!refreshToken) return null;
    try {
      const tokens = await (await this.transport()).refresh(refreshToken, this.deps.deviceId);
      await this.persist(tokens, await this.serverUrl(), 'refreshed');
      return tokens.access_token;
    } catch (error) {
      if (isNetworkError(error)) {
        log.warn('token refresh offline; keeping the current token', { error: messageOf(error) });
        return this.deps.secureStorage.get(ACCESS_KEY);
      }
      // A rejected refresh token means the session is gone server-side.
      log.warn('refresh rejected — clearing the local session', { error: messageOf(error) });
      await this.deps.secureStorage.remove(ACCESS_KEY);
      await this.deps.secureStorage.remove(REFRESH_KEY);
      const session = await this.currentSession();
      if (session) await this.deps.repos.session.hardDelete(session.user_id, { actor: 'system', sync: false });
      return null;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return Boolean(await this.deps.secureStorage.get(ACCESS_KEY));
  }

  async currentUser(): Promise<Account | null> {
    const session = await this.currentSession();
    if (!session?.user_id) return null;
    return (await this.deps.repos.account.byId(session.user_id)) ?? null;
  }

  async state(): Promise<AuthState> {
    const session = await this.currentSession();
    const account = session?.user_id ? await this.deps.repos.account.byId(session.user_id) : null;
    const authenticated = Boolean(await this.deps.secureStorage.get(ACCESS_KEY)) && Boolean(session);
    const settings = await this.deps.settings.all();
    const expiresAt = session?.access_expires_at ?? null;
    return {
      authenticated,
      offlineOnly: !authenticated,
      email: account?.email ?? null,
      displayName: account?.display_name ?? null,
      userId: account?.user_id ?? null,
      plan: account?.plan ?? null,
      serverUrl: account?.server_url ?? settings.sync.server_url,
      expiresAt,
      expiresInMinutes: expiresAt ? Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000)) : null,
      syncEnabled: settings.sync.enabled && authenticated,
    };
  }

  // ─────────────────────────── internals ───────────────────────────
  private async serverUrl(): Promise<string | null> {
    const settings = await this.deps.settings.all();
    return settings.sync.server_url;
  }

  private async persist(tokens: AuthTokens, serverUrl: string | null, reason: string): Promise<void> {
    await this.deps.secureStorage.set(ACCESS_KEY, tokens.access_token);
    await this.deps.secureStorage.set(REFRESH_KEY, tokens.refresh_token);

    const userId = tokens.user_id;
    const account = await this.deps.repos.account.byId(userId);
    const accountRow = {
      user_id: userId,
      email: normaliseEmail(tokens.email),
      display_name: tokens.display_name ?? account?.display_name ?? null,
      plan: tokens.plan ?? account?.plan ?? 'free',
      server_url: serverUrl ?? account?.server_url ?? null,
      last_login_at: nowIso(),
    };
    if (account) await this.deps.repos.account.update(userId, accountRow as never, { actor: 'user', reason: `account ${reason}`, sync: true });
    else await this.deps.repos.account.insert(accountRow as never, { actor: 'user', reason: `account ${reason}`, sync: true });

    // Session metadata only — never the tokens themselves.
    const existing = await this.deps.repos.session.byId(userId);
    const sessionRow = {
      user_id: userId,
      access_token: null,
      refresh_token: null,
      access_expires_at: tokens.access_expires_at,
      device_id: this.deps.deviceId,
      updated_at: nowIso(),
    };
    if (existing) await this.deps.repos.session.update(userId, sessionRow as never, { actor: 'user', sync: false, reason: `session ${reason}` });
    else await this.deps.repos.session.insert(sessionRow as never, { actor: 'user', sync: false, reason: `session ${reason}` });

    await this.deps.settings.setMany({ sync: { enabled: true, auto_sync: true, server_url: serverUrl } }, { actor: 'user' });
    log.info('auth session stored', { reason, userId, expiresAt: tokens.access_expires_at });
  }

  private async wipeLocalRows(): Promise<void> {
    await this.deps.repos.db.transaction(async () => {
      for (const repo of this.deps.repos.allRepos()) await repo.truncate();
    }, 'auth-wipe');
    try { await this.deps.repos.db.exec('VACUUM'); } catch { /* vacuum is best-effort */ }
    this.deps.settings.invalidate();
  }
}

// ─────────────────────────── HTTP transport ───────────────────────────
export interface HttpAuthTransportConfig {
  serverUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpAuthTransport implements AuthTransport {
  constructor(private readonly config: HttpAuthTransportConfig) {}

  private get baseUrl(): string { return this.config.serverUrl.replace(/\/$/, ''); }
  private get doFetch(): typeof fetch { return this.config.fetchImpl ?? fetch; }

  private async request<T>(path: string, body: unknown, token?: string | null): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
    try {
      const response = await this.doFetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? safeJson(text) : {};
      if (!response.ok) {
        const message = (parsed as { error?: string; message?: string }).error ?? (parsed as { message?: string }).message ?? `Request failed (${response.status})`;
        if (response.status === 401 || response.status === 403) throw AppError.unauthorized(message);
        if (response.status === 429) throw new AppError('rate_limited', message, { userMessage: 'Too many attempts. Please wait a moment and try again.' });
        if (response.status === 409) throw AppError.conflict(message);
        throw new AppError('network', message, { details: { status: response.status } });
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.network('Cannot reach the LifeMentor server', { cause: messageOf(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  register(input: { email: string; password: string; display_name?: string | null; device_id: string }): Promise<AuthTokens> {
    return this.request<AuthTokens>('/v1/auth/register', input);
  }

  login(input: { email: string; password: string; device_id: string }): Promise<AuthTokens> {
    return this.request<AuthTokens>('/v1/auth/login', input);
  }

  refresh(refreshToken: string, deviceId: string): Promise<AuthTokens> {
    return this.request<AuthTokens>('/v1/auth/refresh', { refresh_token: refreshToken, device_id: deviceId });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.request<{ ok: boolean }>('/v1/auth/logout', { refresh_token: refreshToken });
  }

  deleteAccount(accessToken: string): Promise<{ receipt: string; deleted_at: string }> {
    return this.request<{ receipt: string; deleted_at: string }>('/v1/account/delete', {}, accessToken);
  }
}

// ─────────────────────────── helpers ───────────────────────────
export function normaliseEmail(email: string): string { return email.trim().toLowerCase(); }

function assertCredentials(email: string, password: string): void {
  const address = normaliseEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(address)) {
    throw AppError.validation('That does not look like an email address', { field: 'email' });
  }
  if (password.length < 10) {
    throw new AppError('validation', 'Password is too short', {
      details: { field: 'password', min: 10 },
      userMessage: 'Use at least 10 characters — this password protects your sync and AI access.',
    });
  }
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'network' || error.code === 'rate_limited';
  return /fetch failed|network|abort|timeout|econnrefused|enotfound/i.test(messageOf(error));
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return {}; }
}

export type { Account, SessionRow };
