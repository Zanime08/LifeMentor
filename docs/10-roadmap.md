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
| 6 | Windows + Android shell (Tauri `src-tauri`, Capacitor project, SQL adapters) | ✅ **projects ready** — `apps/desktop/src-tauri` (rusqlite, full `sql_*` invoke contract, NSIS bundle, capabilities, icons) + `apps/mobile` (Capacitor 8, `android/` Gradle project, notification permissions, icons) + shell platform adapters (store/preferences, native-scheduling notifications, dialog/fs, network). Both driver contracts pinned by CI tests (Rust/Android emulators). Binary builds need Rust/JDK — one command on a release machine / tag build (`docs/11-packaging.md`). |
| 7 | Onboarding: questionnaire + adaptive interview + user-model builder | ✅ done — service (10 tests) + two-stage web wizard (questionnaire → adaptive interview → profile review → confirm) |
| 8 | Profile + long-term memory + privacy controls | ✅ done — service + Memory Viewer UI ("What the AI knows about me": edit/delete/confirm) |
| 9 | Goals + tasks + calendar + projects | ✅ done — services + Goals/Calendar/Projects screens |
| 10 | Daily planner + adaptive rescheduling + strict mode + free time | ✅ done — service + Today screen (day plan, energy, strict-mode reasons) |
| 11 | AI Orchestrator + providers + tools + Context Engine | ✅ done (14 tests) + Mentor chat screen over the server gateway |
| 12 | Learning engine + spaced repetition + skills + assessments | ✅ done — service + Learning/Skills/Knowledge screens |
| 13 | Progress snapshots + weekly/monthly reviews + strategy | ✅ done — service + Progress screen (daily snapshots, charts, reviews) + Strategy |
| 14 | News engine | ✅ done — client service (sources/items/relevance/digest) + **server RSS poller**: 8 real feeds, 30-min polling, URL-hash dedup, urgency scoring, deterministic what/why/context enrichment, 60-day prune, honest empty/error states (no fake items). LLM-based enrichment: not connected (deterministic text instead). |
| 15 | Notifications | ✅ **web push + FCM done** — client budget/quiet-hours/smart reminders + local scheduling; server: VAPID Web Push (subscribe/poll/deliver queue, urgent-news push with daily cap), **FCM v1 transport** (RS256 service-account JWT, token revocation, urgent = visible OS notification, data-only otherwise), service worker, polling fallback as the guaranteed path. Activation is external: a Firebase project for `ai.lifementor.app` + a server service account (docs/11 §FCM). |
| 16 | Sync + offline (queue, incremental push/pull, conflicts) | ✅ done end to end — client engine, server API, two-device integration test |
| 17 | Backup + restore + export/import + account deletion | ✅ done (local images, JSON archives, rotation, purge, **cloud backup slot**: client-side AES-GCM, server stores ciphertext + sha256, `POST/GET/DELETE /v1/backup`) |
| 18 | Testing (persistence, sync, AI, planner, learning, notifications, API) | ✅ 118 automated tests passing (17 files: core + server + WASM driver durability + **Tauri/Capacitor driver contract tests** + browser bootstrap + push engine (incl. **FCM v1 unit + integration**) + cloud backup) |
| 19 | Packaging (Windows NSIS/MSI, Android APK, server release bundle) | 🟡 **one command away** — server bundles to `dist/main.mjs` and runs; shell projects + CI release workflow (`release.yml`: tests → NSIS .exe on windows-latest, APK on ubuntu-latest) are in place; the binaries are produced on a machine with Rust/JDK (or by tagging `v*`) — `docs/11-packaging.md` |
| 20 | Polishing (UI density, empty states, error copy, perf, a11y) | ⬜ not started |

**Test suite today:** 118 tests, 17 files — `packages/core/test` (public API, persistence + WASM
driver durability, **Tauri and Capacitor driver contracts — the exact `sql_*` invoke shapes and
v8 plugin API the shells implement, run against emulated Rust/Android engines**, sync/backup/
recovery, auth, AI, onboarding), `apps/server/test` (auth API, sync API, AI gateway, news engine,
push engine — delivery, polling fallback, 410 handling, **FCM v1 (JWT signature, token exchange
+ caching, message shape, 404→drop, 401→re-exchange, end-to-end urgent/data-only delivery)**,
urgent-news cap — cloud backup — and a two-device end-to-end run over real HTTP) and
`apps/web/test` (browser bootstrap: the exact WASM + IndexedDB path the preview uses, including
first-launch backup, offline AI degradation, offline sync, and data surviving a full restart).

## What is deliberately NOT built yet

* **The actual `.exe`/`.apk` binaries** — everything up to the compiler is in place (shell
  projects, CI release workflow, icons, signing hooks); producing the binaries needs Rust
  (Windows) and the Android SDK (APK), which are release-machine / CI-tag concerns
  (`docs/11-packaging.md`).
* **FCM activation is an external credential, not code** — the full FCM path is implemented and
  tested (server FCM v1 sender with service-account JWT + token revocation; Android
  `@capacitor/push-notifications` + a native `LifeMentorFcmService` that shows the OS notification
  when the app is closed). Turning it on needs a free Firebase project for `ai.lifementor.app`
  (`google-services.json`) and a server service account — we cannot create those here. Without
  them the app is honest: no FCM token, and every notification still arrives via polling.
* **LLM-based news enrichment** — the server poller enriches with deterministic what/why/context
  text today; swapping in the AI gateway for per-item enrichment is a small addition.
* **UI-level automated tests** (Playwright) — engine and API are covered; the 13 web screens are
  exercised manually against the running dev preview.

## Next phases

1. **Produce the binaries**: tag a `v*` (CI builds the NSIS `.exe` + APK) or run the one-command
   builds on a machine with Rust / JDK (docs/11-packaging.md). For FCM in the shipped APK, also
   set the `GOOGLE_SERVICES_JSON_B64` repository secret and the server's `FIREBASE_*` env.
2. **LLM-based news enrichment** — swap the deterministic what/why/context text for the AI
   gateway on the server poller (small, isolated change).
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

npm test                    # 109 tests (core + server + shell driver contracts + web bootstrap)
npm run typecheck           # tsc --noEmit over the whole monorepo
npm run db:integrity        # server database diagnostics

# Shells (release machine — see docs/11-packaging.md):
npm run shell:android       # web build + cap sync android (then gradlew assembleRelease)
npm run shell:windows       # tauri build → NSIS .exe (needs Rust)
```

Environment: copy `.env.example`; `JWT_SECRET` is required in production, provider keys are
optional (without them the AI gateway serves the offline heuristic engine and says so).

Local data lives in `data/` (SQLite files), `backups/` and `exports/` — all gitignored, because
that is *user data*, never source. `npm run clean` removes build output only and refuses to touch
those directories.
