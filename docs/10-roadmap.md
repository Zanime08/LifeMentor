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
| 7 | Onboarding: questionnaire + adaptive interview + user-model builder | ✅ service done (10 tests) · ⬜ UI pending |
| 8 | Profile + long-term memory + privacy controls | ✅ service done · ⬜ Memory Viewer UI pending |
| 9 | Goals + tasks + calendar + projects | ✅ services done · ⬜ UI pending |
| 10 | Daily planner + adaptive rescheduling + strict mode + free time | ✅ service done · ⬜ UI pending |
| 11 | AI Orchestrator + providers + tools + Context Engine | ✅ done (14 tests) |
| 12 | Learning engine + spaced repetition + skills + assessments | ✅ service done · ⬜ UI pending |
| 13 | Progress snapshots + weekly/monthly reviews + strategy | ✅ services done · ⬜ UI pending |
| 14 | News engine | 🟡 **partial** — client-side sources/items/relevance/digest are done; **server-side polling + AI enrichment is not built** |
| 15 | Notifications | 🟡 **partial** — budget, quiet hours, smart reminders and the local OS scheduling bridge are done; **server push (FCM / Web Push) is not built** |
| 16 | Sync + offline (queue, incremental push/pull, conflicts) | ✅ done end to end — client engine, server API, two-device integration test |
| 17 | Backup + restore + export/import + account deletion | ✅ done (local images, JSON archives, rotation, purge) |
| 18 | Testing (persistence, sync, AI, planner, learning, notifications, API) | 🟡 86 automated tests passing (core + server); UI tests come with the UI |
| 19 | Packaging (Windows NSIS/MSI, Android APK, server release bundle) | 🟡 **partial** — the server bundles to `dist/main.mjs` and runs; desktop/mobile packaging needs the shell projects (phase 6) and a machine with Rust/JDK |
| 20 | Polishing (UI density, empty states, error copy, perf, a11y) | ⬜ not started |

**Test suite today:** 86 tests, 9 files — `packages/core/test` (persistence, sync/backup/recovery,
auth, AI, onboarding, public API) and `apps/server/test` (auth API, sync API, AI gateway, and a
two-device end-to-end run over real HTTP).

## What is deliberately NOT built yet

* **The user interface.** No screen exists yet: `apps/web` is a workspace placeholder. Everything
  above is the engine — real, tested, and reachable through `LifeMentorApp` — but a person cannot
  click it yet. This is the next phase.
* **Desktop/mobile shell projects** (`src-tauri`, Capacitor `android/`), therefore no `.exe`/`.apk`.
  Binary builds additionally require Rust and the Android SDK, which are release-machine concerns.
* **Server-side news polling and enrichment**, and **push notification delivery** (FCM/Web Push).
  Both are designed in `docs/08` §4–5 and both have working client-side halves.
* **Cloud backup storage** (`POST /v1/backup`): local backups, exports and restore are complete;
  uploading an encrypted blob to the server is not implemented.

## Next phases

1. **Web UI** (`apps/web`, React + Vite): today view, goals, tasks, calendar, learning, memory
   viewer, onboarding wizard, sync/backup screens, settings — wired to `LifeMentorApp` over the
   wasm driver, with the server for auth/sync/AI. This is also the preview that runs in a browser.
2. **Desktop + mobile shells** (Tauri 2 / Capacitor) reusing the same UI bundle.
3. **Server news + push notifications**, cloud backup upload.
4. **Packaging**: NSIS installer, APK/AAB, server release bundle + install docs.
5. **Polish & hardening**: a11y pass, empty states, error copy, performance, more tests.

## How to run (what actually works today)

```bash
npm install

# backend (Fastify + SQLite): auth, sync, AI gateway
npm run dev:server          # tsx watch, http://localhost:8787
npm run build:server        # bundle → apps/server/dist/main.mjs
npm start                   # run the bundle

npm test                    # 86 tests (core + server)
npm run typecheck           # tsc --noEmit over the whole monorepo
npm run db:integrity        # server database diagnostics
```

Environment: copy `.env.example`; `JWT_SECRET` is required in production, provider keys are
optional (without them the AI gateway serves the offline heuristic engine and says so).

Local data lives in `data/` (SQLite files), `backups/` and `exports/` — all gitignored, because
that is *user data*, never source. `npm run clean` removes build output only and refuses to touch
those directories.
