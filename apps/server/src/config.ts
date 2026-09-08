import { z } from 'zod';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Server configuration (docs/08 §2, §3, §8).
 *
 * Everything secret comes from the environment — never from a client request and never from a
 * file inside the user's data directory. In development a JWT secret is generated on the fly
 * (and the log says so); in production a missing secret is a hard startup failure, because a
 * predictable secret would let anyone mint a valid access token.
 */

const booleanish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));

const numberish = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: numberish(8787),
  DATABASE_PATH: z.string().default('data/server.sqlite'),
  DATABASE_IN_MEMORY: booleanish.default(false),

  JWT_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL_SECONDS: numberish(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: numberish(30),

  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  BODY_LIMIT_BYTES: numberish(2 * 1024 * 1024),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // AI gateway — keys live only here (req. 20, 58)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_BASE_URL: z.string().optional(),
  AI_MODEL_CHEAP: z.string().optional(),
  AI_MODEL_MID: z.string().optional(),
  AI_MODEL_STRONG: z.string().optional(),
  AI_DAILY_TOKEN_BUDGET: numberish(400_000),
  AI_MAX_INPUT_CHARS: numberish(200_000),

  // Web Push (docs/08 §5): VAPID key pair. In development a throwaway pair is generated
  // per run (and the log says so); set stable keys for production so subscriptions survive
  // a restart (generate: npm run vapid:keys --workspace @lifementor/server).
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:dev@lifementor.local'),
  /** Max important-news pushes per user per day — a hard anti-spam cap (req. 86). */
  NEWS_PUSH_DAILY_CAP: numberish(3),

  // rate limits (per IP, per window)
  RATE_LIMIT_WINDOW_MS: numberish(60_000),
  RATE_LIMIT_AUTH: numberish(10),
  RATE_LIMIT_SYNC: numberish(120),
  RATE_LIMIT_AI: numberish(30),
  RATE_LIMIT_GENERAL: numberish(300),
});

export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databasePath: string;
  databaseInMemory: boolean;
  jwtSecret: string;
  jwtSecretGenerated: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  corsOrigins: string[];
  bodyLimitBytes: number;
  logLevel: string;
  ai: {
    openaiKey: string | null;
    openaiBaseUrl: string | null;
    anthropicKey: string | null;
    anthropicBaseUrl: string | null;
    googleKey: string | null;
    googleBaseUrl: string | null;
    models: { cheap?: string; mid?: string; strong?: string };
    dailyTokenBudget: number;
    maxInputChars: number;
  };
  rateLimit: { windowMs: number; auth: number; sync: number; ai: number; general: number };
  push: {
    vapidPublicKey: string | null;
    vapidPrivateKey: string | null;
    vapidPublicGenerated: boolean;
    vapidSubject: string;
    newsDailyCap: number;
  };
}

export class ConfigError extends Error {}

/**
 * Generate a VAPID P-256 key pair the same way `web-push` does: the public key is the
 * uncompressed point (0x04 ‖ X ‖ Y, 65 bytes) in base64url, the private key the scalar `d`.
 * Both formats are what `web-push.setVapidDetails` validates and what
 * `PushManager.subscribe({ applicationServerKey })` expects in the browser.
 */
export function generateVapidKeys(): { public_key: string; private_key: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { public_key: pub.toString('base64url'), private_key: Buffer.from(jwk.d, 'base64url').toString('base64url') };
}

/** Parse and validate the environment. Throws `ConfigError` with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid server configuration — ${issues}`);
  }
  const raw = parsed.data;

  let jwtSecret = raw.JWT_SECRET ?? '';
  let generated = false;
  if (!jwtSecret) {
    if (raw.NODE_ENV === 'production') {
      throw new ConfigError('JWT_SECRET is required in production (at least 16 characters).');
    }
    jwtSecret = randomBytes(48).toString('base64url');
    generated = true;
  }

  // VAPID: a stable pair is needed for subscriptions to survive a restart. In development a
  // throwaway pair is generated per run (and main.ts logs that); in production both are required.
  let vapidPublic = raw.VAPID_PUBLIC_KEY ?? '';
  let vapidPrivate = raw.VAPID_PRIVATE_KEY ?? '';
  let vapidGenerated = false;
  if (!vapidPublic || !vapidPrivate) {
    if (raw.NODE_ENV === 'production') {
      throw new ConfigError('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required in production (npm run vapid:keys).');
    }
    ({ public_key: vapidPublic, private_key: vapidPrivate } = generateVapidKeys());
    vapidGenerated = true;
  }

  return {
    env: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    databasePath: raw.DATABASE_PATH,
    databaseInMemory: raw.DATABASE_IN_MEMORY,
    jwtSecret,
    jwtSecretGenerated: generated,
    accessTokenTtlSeconds: raw.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
    corsOrigins: raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    bodyLimitBytes: raw.BODY_LIMIT_BYTES,
    logLevel: raw.LOG_LEVEL,
    ai: {
      openaiKey: raw.OPENAI_API_KEY ?? null,
      openaiBaseUrl: raw.OPENAI_BASE_URL ?? null,
      anthropicKey: raw.ANTHROPIC_API_KEY ?? null,
      anthropicBaseUrl: raw.ANTHROPIC_BASE_URL ?? null,
      googleKey: raw.GOOGLE_API_KEY ?? null,
      googleBaseUrl: raw.GOOGLE_BASE_URL ?? null,
      models: { cheap: raw.AI_MODEL_CHEAP, mid: raw.AI_MODEL_MID, strong: raw.AI_MODEL_STRONG },
      dailyTokenBudget: raw.AI_DAILY_TOKEN_BUDGET,
      maxInputChars: raw.AI_MAX_INPUT_CHARS,
    },
    rateLimit: {
      windowMs: raw.RATE_LIMIT_WINDOW_MS,
      auth: raw.RATE_LIMIT_AUTH,
      sync: raw.RATE_LIMIT_SYNC,
      ai: raw.RATE_LIMIT_AI,
      general: raw.RATE_LIMIT_GENERAL,
    },
    push: {
      vapidPublicKey: vapidPublic,
      vapidPrivateKey: vapidPrivate,
      vapidPublicGenerated: vapidGenerated,
      vapidSubject: raw.VAPID_SUBJECT,
      newsDailyCap: raw.NEWS_PUSH_DAILY_CAP,
    },
  };
}

/** True when at least one cloud provider key is configured. */
export function hasCloudAI(config: ServerConfig): boolean {
  return Boolean(config.ai.openaiKey || config.ai.anthropicKey || config.ai.googleKey);
}
