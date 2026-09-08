# Backend, Security, Privacy, News, Notifications (Phases 5, 14, 15; req. 19, 20, 47–50, 57–59, 67, 69, 70)

## 1. Responsibilities of the server

The client is local-first; the server exists only for things that **must** be shared or secret:

| Domain | Endpoints |
|---|---|
| **Auth** | `POST /v1/auth/register` `login` `refresh` `logout` `POST /v1/auth/password/change` `DELETE /v1/account` |
| **Sync** | `POST /v1/sync/push` `GET /v1/sync/pull?since=` `GET /v1/sync/status` `POST /v1/sync/conflicts/:id/resolve` |
| **AI gateway** | `POST /v1/ai/chat` (streaming SSE) `POST /v1/ai/structured` `POST /v1/ai/embed` — provider keys stay here |
| **News** | `GET /v1/news/feed?category=&since=` `GET /v1/news/digest?day=` `GET /v1/news/urgent` `POST /v1/news/preferences` |
| **Notifications** | `POST /v1/notifications/push-token` `GET /v1/notifications/pending` `POST /v1/notifications/:id/delivered` |
| **Backup** | `POST /v1/backup` (encrypted blob) `GET /v1/backup/latest` `DELETE /v1/backup` |
| **Devices** | `GET/DELETE /v1/devices` |
| **Health** | `GET /v1/health` `GET /v1/version` |

Everything else (planning, learning, memory retrieval, snapshots) runs **on the client**.

## 2. Authentication & sessions (req. 57)

* Password hashing: **scrypt** (`node:crypto`, N=16384, r=8, p=1) with per-user salt — no extra native dep.
* Access token: short-lived JWT (15 min, HMAC via `@fastify/jwt`); refresh token: opaque random 256-bit,
  hashed at rest, rotating, device-bound, revocable (`DELETE /v1/devices/:id`).
* Client stores tokens in OS secure storage (Windows Credential Manager / Android Keystore) via
  `PlatformAdapter.secureStorage`; the browser dev preview falls back to `sessionStorage` + in-memory.
* Every request is authorized: `userId` comes from the token, never from the body; repositories are
  scoped by `user_id` on the server.
* Rate limiting (`@fastify/rate-limit`): 10/min on auth endpoints, 120/min on sync, 30/min on AI,
  with per-IP and per-user buckets; validation with Zod at the edge; strict JSON body size limits;
  CORS allow-list; helmet-style security headers; audit log of auth events (no secrets logged).

## 3. AI key protection (req. 20, 58)

* Provider keys live **only** in server env/KMS (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).
* Clients call `/v1/ai/*` with their user JWT; the server authenticates, rate-limits, applies a
  per-user daily token budget, then calls the provider.
* The server strips/never logs secrets; AI request logs keep `{user_id, model, tokens, latency,
  tool_names, error}` — no key material (req. 69).
* Offline / no-account mode: the client uses the **local heuristic provider** — no key needed.

## 4. News engine (req. 47, 48)

* Server-side `NewsService` polls configured sources (RSS/Atom/API) with `etag`/`If-Modified-Since`,
  deduplicates by `(source_id, external_id)` and by URL/title similarity.
* Each item is enriched (cheap model tier or heuristic fallback) into:
  `what_happened, why_it_matters, context, potential_impact, source, category, urgency, relevance`.
* Categories: world, technology, ai, economy, business, science, geopolitics, programming.
* Two levels: **Urgent** (high-impact, time-sensitive; pushed as a notification within budget) and
  **Digest** (one daily bundle at the user's chosen time).
* Clients cache the last fetched items locally → readable offline; relevance is re-ranked per user
  using interests/goals (local scoring, no extra round-trip).

## 5. Notifications (req. 49, 50, 86, 87)

Types: `daily_plan, schedule_start, task_reminder, learning_review, important_news, goal_review,
project_deadline, mentor_message, daily_digest`.

Delivery paths:
* **Local scheduling** (primary): the client schedules OS notifications from the day plan
  (Windows toast via Tauri plugin; Android via local notifications + exact alarms) — works offline.
* **Push** (secondary): server → FCM/Web Push for time-critical items when the app is closed
  (urgent news, deadline warnings, mentor proactivity the user enabled).

Smart gating: importance + urgency + time-of-day + quiet hours + previous notifications +
daily budget + dedup window. Every notification includes **context** and a **direct action**
(open task, snooze 10 min, mark done, "not now"). The user controls everything in
`Settings → Notifications` (per type, per channel, quiet hours, budget, proactive mentor on/off).

## 6. Logging & crash reports (req. 68, 69)

* Client: ring-buffer log (`util/logging`) → rotated local files (`logs/app-*.log`), categories
  `app | db | sync | ai | planner | notification | crash`. Crash reports include stack, route,
  DB schema version, last 50 log lines — **no personal content, no tokens** — and are sent only
  if the user opted in (`settings.telemetry`).
* Server: structured JSON logs (pino via Fastify) with request ids; sync logs; AI usage logs;
  auth audit logs. Retention 30 days by default.

## 7. Privacy controls (req. 70)

`Settings → Privacy` exposes: what the AI knows (Memory Viewer with edit/delete/confirm/mark-wrong),
AI memory on/off, per-category memory retention, telemetry opt-in/out, cloud sync on/off
(app stays fully usable locally), cloud backup on/off + delete cloud backup, export all data,
delete account (with export offer + explicit warning + receipt).

## 8. Deployment without Docker for the user (req. 17, 18, 67)

* **Windows**: `LifeMentorSetup.exe` (Tauri NSIS) — installs WebView2 if missing, creates shortcuts,
  registers autostart optionally. No terminal, no runtime installs, no Docker.
* **Android**: `LifeMentor.apk` (or store `.aab`) — standard install, runtime permissions requested
  in-context (notifications, exact alarms, boot).
* **Server**: a single Node service (`npm run start` → bundled `dist/main.mjs`) behind HTTPS
  (systemd / Windows Service / managed Node host / container **on the operator side only**).
  The operator's deployment choice is invisible to the end user; the client only knows one base URL,
  shipped in the installer config.
