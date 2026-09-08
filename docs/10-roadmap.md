# Roadmap & Phase Status (req. 91, 92)

Rule: **never move to the next phase with a broken previous one.** After each phase: run the app,
test it, fix bugs, check regressions, update docs.

This table is kept honest on purpose: a row is ✅ only when the code exists **and** is covered by a
test that runs in CI (`npm test`). "Service" means the logic layer in `@lifementor/core`; the UI
that exposes it is tracked separately, because a service without a screen is not a finished feature.

## Current state

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Product specification (`docs/00-product-spec.md`) | ✅ done |
| 2 | Architecture + stack decision (`docs/01`, `docs/02`) | ✅ done |
| 3 | Repository structure (monorepo, workspaces, configs) | ✅ done |
| 4 | Database: schema, migrations, drivers, repositories, crash-safe persistence | ✅ done (26 tables, node + wasm drivers, WAL, transactional writes) |
| 5 | Authentication: local session + server auth (scrypt, JWT, refresh rotation, devices) | ✅ done (`apps/server` + `AuthService`, 19 tests) |
| 6 | Windows + Android shell (Tauri `src-tauri`, Capacitor project, SQL adapters) | 🟡 **partial** — the SQL adapter bridges exist (`platform/tauri`, `platform/capacitor`); the shell projects themselves are not created yet |
| 7 | Onboarding: questionnaire + adaptive interview + user-model builder | ✅ done — service (10 tests) + two-stage web wizard (questionnaire → adaptive interview → profile review → confirm) |
| 8 | Profile + long-term memory + privacy controls | ✅ done — service + Memory Viewer UI ("What the AI knows about me": edit/delete/confirm) |
| 9 | Goals + tasks + calendar + projects | ✅ done — services + Goals/Calendar/Projects screens |
| 10 | Daily planner + adaptive rescheduling + strict mode + free time | ✅ done — service + Today screen (day plan, energy, strict-mode reasons) |
| 11 | AI Orchestrator + providers + tools + Context Engine | ✅ done (14 tests) + Mentor chat screen over the server gateway |
| 12 | Learning engine + spaced repetition + skills + assessments | ✅ done — service + Learning/Skills/Knowledge screens |
| 13 | Progress snapshots + weekly/monthly reviews + strategy | ✅ done — service + Progress screen (daily snapshots, charts, reviews) + Strategy |
| 14 | News engine | ✅ done — client service (sources/items/relevance/digest) + **server RSS poller**: 8 real feeds, 30-min polling, URL-hash dedup, urgency scoring, deterministic what/why/context enrichment, 60-day prune, honest empty/error states (no fake items). LLM-based enrichment: not connected (deterministic text instead). |
| 15 | Notifications | ✅ **web push done** — client budget/quiet-hours/smart reminders + local scheduling; server: VAPID Web Push (subscribe/poll/deliver queue, urgent-news push with daily cap), service worker, polling fallback. **FCM transport activates with the Android shell** (tokens already accepted + queued, delivered by polling meanwhile). |
| 16 | Sync + offline (queue, incremental push/pull, conflicts) | ✅ done end to end — client engine, server API, two-device integration test |
| 17 | Backup + restore + export/import + account deletion | ✅ done (local images, JSON archives, rotation, purge, **cloud backup slot**: client-side AES-GCM, server stores ciphertext + sha256, `POST/GET/DELETE /v1/backup`) |
| 18 | Testing (persistence, sync, AI, planner, learning, notifications, API) | ✅ 101 automated tests passing (14 files: core + server + WASM driver durability + browser bootstrap + push engine + cloud backup) |
| 19 | Packaging (Windows NSIS/MSI, Android APK, server release bundle) | 🟡 **partial** — the server bundles to `dist/main.mjs` and runs; desktop/mobile packaging needs the shell projects (phase 6) and a machine with Rust/JDK |
| 20 | Polishing (UI density, empty states, error copy, perf, a11y) | ⬜ not started |

**Test suite today:** 101 tests, 14 files — `packages/core/test` (public API, persistence + WASM
driver durability, sync/backup/recovery, auth, AI, onboarding), `apps/server/test` (auth API,
sync API, AI gateway, news engine, push engine — delivery, polling fallback, 410 handling, FCM
pending, urgent-news cap — cloud backup — and a two-device end-to-end run over real HTTP) and
`apps/web/test` (browser bootstrap: the exact WASM + IndexedDB path the preview uses, including
first-launch backup, offline AI degradation, offline sync, and data surviving a full restart).

## What is deliberately NOT built yet

* **Desktop/mobile shell projects** (`src-tauri`, Capacitor `android/`), therefore no `.exe`/`.apk`.
  The SQL adapter bridges exist (`platform/tauri`, `platform/capacitor`); binary builds additionally
  require Rust and the Android SDK, which are release-machine concerns.
* **FCM transport** — Web Push is fully delivered (service worker + server VAPID push + polling
  fallback). FCM registration tokens are already accepted and queued (`kind='fcm'`), but actual FCM
  delivery activates together with the Android shell; until then those notifications are delivered
  by polling with an honest `push_error` explaining why.
* **LLM-based news enrichment** — the server poller enriches with deterministic what/why/context
  text today; swapping in the AI gateway for per-item enrichment is a small addition.
* **UI-level automated tests** (Playwright) — engine and API are covered; the 13 web screens are
  exercised manually against the running dev preview.

## Next phases

1. **Desktop + mobile shells** (Tauri 2 / Capacitor) reusing the same UI bundle; the Android
   shell also activates the FCM push transport (tokens are already accepted and queued).
2. **Packaging**: NSIS installer, APK/AAB, server release bundle + install docs.
3. **Polish & hardening**: a11y pass, empty states, error copy, performance, Playwright UI tests.

## Web UI — what is built (`apps/web`, React + Vite, runs as the dev preview)

13 navigation screens + Auth + two-stage Onboarding, all wired to `LifeMentorApp` over the WASM
SQLite driver (real SQLite in WebAssembly, image persisted to IndexedDB) with the server for
auth/sync/AI/news: Dashboard, Mentor (chat + AI tools), Today (deterministic day plan + strict
mode), Calendar, Goals (hierarchy + reviews), Learning (paths + spaced repetition), Projects,
Skills (evidence-based), Knowledge (map + gaps), News (server RSS poller feed + digest), Progress
(daily snapshots, charts, weekly/monthly reviews, strategy layers with immutable change history),
Profile, and Settings (memory viewer, sync/backup/export-import, account deletion, diagnostics).

## How to run (what actually works today)

```bash
npm install

# backend (Fastify + SQLite): auth, sync, AI gateway, news poller
npm run dev:server          # tsx watch, http://localhost:8787
npm run dev:web             # web UI, http://localhost:5173 (proxies /v1 to the server)
npm run dev                 # both, in one terminal

npm run build:server        # bundle → apps/server/dist/main.mjs
npm start                   # run the bundle

npm test                    # 95 tests (core + server + web bootstrap)
npm run typecheck           # tsc --noEmit over the whole monorepo
npm run db:integrity        # server database diagnostics
```

Environment: copy `.env.example`; `JWT_SECRET` is required in production, provider keys are
optional (without them the AI gateway serves the offline heuristic engine and says so).

Local data lives in `data/` (SQLite files), `backups/` and `exports/` — all gitignored, because
that is *user data*, never source. `npm run clean` removes build output only and refuses to touch
those directories.
