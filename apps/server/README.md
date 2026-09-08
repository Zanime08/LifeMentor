# `@lifementor/server`

The only server-side component of LifeMentor. It exists for the three things that **must** be
shared or secret (docs/08): accounts, the sync change feed, and AI provider keys. Everything else
— planning, learning, memory retrieval, reviews, snapshots — runs on the user's device.

The server never interprets user content: synced entities are stored as opaque, versioned JSON
payloads scoped to a `user_id`. It has no SQL surface for "the user's goals", because it has no
idea what a goal is.

## Run it

```bash
npm install                                  # from the repository root
npm run dev:server                           # tsx watch  → http://localhost:8787
npm run build:server && npm start            # bundled    → apps/server/dist/main.mjs
npm test                                     # 36 server tests (auth, sync, AI gateway, e2e)
npm run db:integrity                         # database diagnostics
```

Configuration comes from the environment — see `.env.example` in the repository root.
`JWT_SECRET` is mandatory in production (the process refuses to start without it); provider keys
are optional, and without them the AI gateway serves the offline heuristic engine.

Storage is a single SQLite file (`DATABASE_PATH`, default `data/server.sqlite`) in WAL mode with
foreign keys enforced. It holds accounts, hashed refresh tokens, devices, the sync feed, AI usage
counters and the audit log — **not** the user's data, which lives on each device.

## Endpoints

| Area | Endpoint | Notes |
|---|---|---|
| Health | `GET /v1/health` `GET /v1/version` | public; integrity + provider state |
| Auth | `POST /v1/auth/register` `login` `refresh` `logout` | scrypt passwords, 15-min JWT, rotating device-bound refresh tokens |
| Auth | `POST /v1/auth/password/change` | invalidates every session |
| Account | `POST /v1/account/delete` | wipes all server-side rows, returns a receipt |
| Sync | `POST /v1/sync/push` | per-operation acks: `applied` / `conflict` (with the current payload) / `rejected` |
| Sync | `GET /v1/sync/pull?since=&limit=&device_id=` | append-only feed, cursor = `seq`, own-device changes filtered out |
| Sync | `GET /v1/sync/status` | entity/feed/device counters |
| Devices | `GET /v1/devices` `DELETE /v1/devices/:deviceId` | list and revoke |
| AI | `POST /v1/ai/generate` `structured` `embed` `stream` | keys stay here; per-user daily token budget; SSE for `stream` |
| AI | `GET /v1/ai/usage` | today's tokens and remaining budget |

Errors are always `{ "error": "...", "code": "...", "userMessage": "..." }` with a meaningful
status (400 validation, 401 unauthorized, 409 conflict, 429 rate limit, 502 provider failure).
Rate limits are per IP **and** per bearer token: 10/min auth, 120/min sync, 30/min AI.

## Conflict policy

The server is an optimistic-concurrency store, not a merge engine. A push whose `base_version` is
older than the stored version gets a `conflict` ack carrying the current payload; the **client**
then applies the documented rules (docs/04 §6): disjoint fields merge, a completion beats an open
edit, a delete beats an update, and critical entities (goals, strategy, profile facts, memories,
settings, skills, account) are never merged silently — they wait for the user.

## Layout

```
src/
  main.ts              process entry: env → server → listen → graceful shutdown
  app.ts               Fastify assembly (CORS, rate limit, JWT, security headers, routes)
  config.ts            zod-validated environment; refuses to start insecure in production
  context.ts           service container handed to every route
  db/                  server schema + a thin driver wrapper (reuses the core SQL driver)
  http/                auth preHandler, error → HTTP mapping
  routes/              auth.ts sync.ts ai.ts meta.ts
  services/            passwords (scrypt) tokens (JWT + refresh rotation) users
                       sync-store (entities + feed) ai-gateway (keys, budget, usage)
                       audit (event trail, secrets redacted)
  tools/integrity.ts   operator diagnostic
test/                  helpers.ts + auth/sync/ai-gateway/client-integration
```

`test/client-integration.test.ts` is the interesting one: it boots this server on a real socket and
drives two real `LifeMentorApp` clients (the same code that runs on Windows and Android) through
sign-up, sync, a two-device edit conflict, offline queueing, gateway AI and account deletion.
