/**
 * `@lifementor/server` public surface.
 *
 * The HTTP app is built by `buildServer()` so tests and the CLI can drive the exact production
 * server in-process (`app.inject(...)`), while `main.ts` is only the process wrapper that reads
 * the environment and binds a port.
 */
export { loadConfig, hasCloudAI, ConfigError, type ServerConfig } from './config';
export { buildServer, type BuildOptions, type BuiltServer } from './app';
export { createContext, SERVER_NAME, SERVER_VERSION, type ServerContext } from './context';
export { ServerDb, SERVER_SCHEMA_VERSION } from './db';
export { SERVER_SCHEMA_SQL } from './db/schema';
export { AuditLog, type AuditEvent, type AuditEntryInput } from './services/audit';
export { AiGateway, buildProvider, parseRequest, GenerationRequestSchema, EmbedRequestSchema, type GatewayUsage } from './services/ai-gateway';
export { SyncStore, type SyncStatus, type StoredEntity, type FeedRow } from './services/sync-store';
export { TokenService, hashToken, type JwtSigner, type TokenPair, type AccessTokenClaims } from './services/tokens';
export { UserStore, normaliseEmail, toPublic, type PublicUser, type UserRow } from './services/users';
export { hashPassword, verifyPassword, assertPassword, encodeParams } from './services/passwords';
export { statusForError, errorBody, registerErrorHandling } from './http/errors';
export { authenticate, bearerToken, requestDeviceId, clientIp } from './http/auth';
