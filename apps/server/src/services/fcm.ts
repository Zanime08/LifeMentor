/**
 * FCM v1 transport for Android devices (docs/08 §5, docs/11 §8).
 *
 * Firebase's v1 HTTP API: `POST /v1/projects/{projectId}/messages:send`, authenticated
 * with an OAuth2 access token exchanged from a short-lived RS256 JWT signed by the
 * Firebase service account (no google-auth SDK — node:crypto only, §96: zero extra deps).
 *
 * Credentials come from the server environment (FIREBASE_*), never from the client —
 * the Android shell only ever registers its FCM token. When no service account is
 * configured the client stays `enabled === false` and PushService falls back to the
 * polling path with an honest `push_error` instead of pretending.
 *
 * Design note (docs/08 §5, req. 86): only URGENT messages carry a `notification`
 * payload (visible OS banner when the app is closed). Everything else is data-only —
 * it reaches the app and passes the local notification gate (budget / quiet hours)
 * before anything is shown, so the device stays the final arbiter.
 */
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const JWT_TTL_SECONDS = 3600;

/** Service-account credentials for the FCM v1 API. */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FcmMessage {
  title: string;
  body?: string;
  /** string-valued data payload (FCM constraint) — the app routes it through its gate. */
  data?: Record<string, string>;
  /** urgent → visible notification payload (can wake the device); otherwise data-only. */
  urgent?: boolean;
}

export interface FcmSendResult {
  status: number;
  ok: boolean;
  /** true when the token is dead (UNREGISTERED / NOT_FOUND) — the subscription must be dropped. */
  gone: boolean;
  error?: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class FcmClient {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: FcmCredentials | null,
    /** injectable for tests; defaults to the global fetch */
    private readonly fetchImpl: typeof fetch = fetch,
    /** injectable clock in milliseconds */
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.creds !== null;
  }

  /** Mint the audience-scoped RS256 JWT the token endpoint exchanges for an access token. */
  mintJwt(iatSeconds: number): string {
    const creds = this.creds;
    if (!creds) throw new Error('FcmClient has no credentials');
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: creds.clientEmail,
      scope: MESSAGING_SCOPE,
      aud: TOKEN_URL,
      iat: iatSeconds,
      exp: iatSeconds + JWT_TTL_SECONDS,
    }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = b64url(signer.sign(creds.privateKey));
    return `${signingInput}.${signature}`;
  }

  /** Exchange the JWT for an OAuth2 access token; cached until ~60s before expiry. */
  private async ensureAccessToken(): Promise<string> {
    const cached = this.accessToken;
    if (cached && this.now() < cached.expiresAt) return cached.value;

    const iat = Math.floor(this.now() / 1000);
    const jwt = this.mintJwt(iat);
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (!res.ok || !json?.access_token) {
      throw new Error(`fcm token exchange failed: ${res.status} ${json?.error ?? 'unreachable'}`.trim());
    }
    this.accessToken = {
      value: json.access_token,
      expiresAt: this.now() + Math.max(60, (json.expires_in ?? JWT_TTL_SECONDS) - 60) * 1000,
    };
    return this.accessToken.value;
  }

  /**
   * Send one message to one device token.
   * 200/201 → queued by FCM (for urgent: shown by the OS when the app is closed).
   * 404 / UNREGISTERED → the token is dead → the caller drops the subscription.
   * 401/403 → our access token went stale → cache invalidated, next call re-exchanges.
   */
  async send(token: string, message: FcmMessage): Promise<FcmSendResult> {
    const creds = this.creds;
    if (!creds) return { status: 0, ok: false, gone: false, error: 'fcm not configured on the server' };

    const body: Record<string, unknown> = {
      token,
      data: { ...(message.data ?? {}) },
      android: { priority: message.urgent ? 'high' : 'normal', ttl: '24h' },
    };
    if (message.urgent) body.notification = { title: message.title, body: message.body ?? '' };

    let res: Response;
    try {
      const accessToken = await this.ensureAccessToken();
      res = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ message: body }),
      });
    } catch (error) {
      return { status: 0, ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (res.status === 200 || res.status === 201) return { status: res.status, ok: true, gone: false };

    let detail = '';
    try {
      const json = (await res.json()) as { error?: { message?: string } };
      detail = json?.error?.message ?? '';
    } catch { /* no body */ }

    if (res.status === 401 || res.status === 403) this.accessToken = null; // stale token — retry fresh next time

    const gone =
      res.status === 404
      || /UNREGISTERED|NOT_FOUND|MISCONFIGURED|INVALID_ARGUMENT.*token/i.test(detail);
    return { status: res.status, ok: false, gone, error: detail || `fcm responded ${res.status}` };
  }
}
