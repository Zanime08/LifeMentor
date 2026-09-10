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
| 4 | Database: schema, migrations, drivers, repositories, crash-safe persistence | ✅ done (26 tables at this phase; later phases added their own — the client schema is 50 tables today, the server store 12, node + wasm drivers, WAL, transactional writes) |
| 5 | Authentication: local session + server auth (scrypt, JWT, refresh rotation, devices) | ✅ done (`apps/server` + `AuthService`, 19 tests) |
| 6 | Windows + Android shell (Tauri `src-tauri`, Capacitor project, SQL adapters) | ✅ **projects ready** — `apps/desktop/src-tauri` (rusqlite, full `sql_*` invoke contract, NSIS bundle, capabilities, icons) + `apps/mobile` (Capacitor 8, `android/` Gradle project, notification permissions, icons) + shell platform adapters (store/preferences, native-scheduling notifications, dialog/fs, network). Both driver contracts pinned by CI tests (Rust/Android emulators). Binary builds need Rust/JDK — one command on a release machine / tag build (`docs/11-packaging.md`). |
| 7 | Onboarding: questionnaire + adaptive interview + user-model builder | ✅ done — service (10 tests) + two-stage web wizard (questionnaire → adaptive interview → profile review → confirm) |
| 8 | Profile + long-term memory + privacy controls | ✅ done — service + Memory Viewer UI ("What the AI knows about me": edit/delete/confirm) |
| 9 | Goals + tasks + calendar + projects | ✅ done — services + Goals/Calendar/Projects screens |
| 10 | Daily planner + adaptive rescheduling + strict mode + free time | ✅ done — service + Today screen (day plan, energy, strict-mode reasons) |
| 11 | AI Orchestrator + providers + tools + Context Engine | ✅ done (14 tests) + Mentor chat screen over the server gateway |
| 12 | Learning engine + spaced repetition + skills + assessments | ✅ done — service + Learning/Skills/Knowledge screens |
| 13 | Progress snapshots + weekly/monthly reviews + strategy | ✅ done — service + Progress screen (daily snapshots, charts, reviews) + Strategy. **Time-driven work is now automatic** (`dailyMaintenance`): missed days are backfilled on launch, the evening snapshot and the previous week/month reviews appear on their own, retention runs, one backup a day is taken — every step guarded and idempotent, failures reported instead of fatal (`packages/core/test/maintenance.test.ts`) |
| 14 | News engine | ✅ done — client service (sources/items/relevance/digest) + **server RSS poller**: 8 real feeds, 30-min polling, URL-hash dedup, urgency scoring, 60-day prune, honest empty/error states (no fake items). **Enrichment: LLM what/why/context when a cloud AI provider is configured** (cheap tier, structured output, 10s timeout, capped at 6 items/refresh — cost control §97), with the deterministic templates as the always-available fallback. |
| 15 | Notifications | ✅ **web push + FCM done** — client budget/quiet-hours/smart reminders + local scheduling; server: VAPID Web Push (subscribe/poll/deliver queue, urgent-news push with daily cap), **FCM v1 transport** (RS256 service-account JWT, token revocation, urgent = visible OS notification, data-only otherwise), service worker, polling fallback as the guaranteed path. Activation is external: a Firebase project for `ai.lifementor.app` + a server service account (docs/11 §FCM). |
| 16 | Sync + offline (queue, incremental push/pull, conflicts) | ✅ done end to end — client engine, server API, two-device integration test |
| 17 | Backup + restore + export/import + account deletion | ✅ done (local images, JSON archives, rotation, purge, **cloud backup slot**: client-side AES-GCM, server stores ciphertext + sha256, `POST/GET/DELETE /v1/backup`) |
| 18 | Testing (persistence, sync, AI, planner, learning, notifications, API, UI) | ✅ 159 automated tests passing (25 files: core + server + WASM driver durability + **Tauri/Capacitor driver contract tests** + browser bootstrap + push engine (incl. **FCM v1 unit + integration**) + **LLM news enrichment** + cloud backup + **planner phase gate** + **bundle boot test (builds `dist/main.mjs` and calls the running server)** + **packaged-archive test (self-contained start on an unconfigured machine)** + **client-bundle credential guard (scans the built client for keys/secrets, with a self-test)** + **`init:env` test** + **maintenance phase gate (snapshots/reviews/backup/retention on a real clock, 10 tests)** + **UI journey tests driving the real client under jsdom**) |
| 19 | Packaging (Windows NSIS/MSI, Android APK, server release bundle) | 🟡 **one command away** — `npm run package:server` produces a self-contained server archive (single 2 MB `.mjs`, launcher, autostart script, README) that starts on a machine with no dependencies and writes its own stable `.env`; the Windows NSIS installer and the signed APK are built by `release.yml` (Rust/JDK) and attached to the GitHub Release by the `publish` job, with a server bundle artifact next to them — `docs/11-packaging.md` |
| 20 | Polishing (UI density, empty states, error copy, perf, a11y, hardening) | 🟡 in progress — error copy, toast a11y, icon-button audit, empty states, performance audit, **UI test layer** and the hardening round below are done; deep profiling on a real device is left |

**Test suite today:** 159 tests, 25 files — `packages/core/test` (public API, persistence + WASM
driver durability, **Tauri and Capacitor driver contracts — the exact `sql_*` invoke shapes and
v8 plugin API the shells implement, run against emulated Rust/Android engines**, sync/backup/
recovery, auth, AI, onboarding), `apps/server/test` (auth API, sync API, AI gateway, news engine
— incl. **LLM enrichment: cheap-tier structured output, per-refresh cap, deterministic fallback**
— push engine — delivery, polling fallback, 410 handling, **FCM v1 (JWT signature, token exchange
+ caching, message shape, 404→drop, 401→re-exchange, end-to-end urgent/data-only delivery)**,
urgent-news cap — cloud backup — and a two-device end-to-end run over real HTTP) and
`apps/server/test` also builds and boots the production bundle (`dist/main.mjs`) on a real port,
and `apps/web/test` (browser bootstrap: the exact WASM + IndexedDB path the preview uses, including
an automatic backup of real data through the browser storage stack, offline AI degradation, offline sync, and data surviving a full restart;
plus **UI journey tests**: the real `App` + screens rendered under jsdom over a genuine
`LifeMentorApp` on a temp SQLite file — the whole first-run onboarding through the DOM, creating
and completing a task on the Today screen, a mentor chat that really executes a tool, a calendar
event that the planner never schedules over, and a restart that keeps every confirmed write).

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
* **Browser-level UI automation** (Playwright + a real Chromium) — the DOM/logic layer is now
  covered by the jsdom journey tests in CI, but only a real browser exercises the surface jsdom
  does not implement (service worker, Web Push, OPFS, IndexedDB); that stays the Playwright
  `ui-smoke` job in `release.yml`, which needs a machine with a browser.

## Next phases

1. **Windows binary — DONE** (CI, 2026-09-09): the release workflow (`on: push tags v*`)
   builds the NSIS installer on `windows-latest` → artifact `LifeMentor-Windows`
   (`LifeMentor_0.1.0_x64-setup.exe`). The native SQLite core (`apps/desktop/src-tauri/src/db.rs`,
   rusqlite 0.32) went through 6 compile-error fixes verified by the CI compiler — the contract
   is pinned by `packages/core/test/tauri-driver.test.ts`.
2. **Android APK — DONE** (first fully green run `34393940996`, `v0.1.0` @ `9aaa3e2`,
   2026-09-09): artifact `LifeMentor-Android` (signed release APK, ~9.2 MB). Pipeline: JDK 21 +
   Android SDK 36, `npm run shell:android` → `./gradlew assembleRelease`. Fixes on the way:
   JDK 21 (Capacitor 8 = `sourceCompatibility 21`), absolute keystore path (gradle `file()` is
   module-relative), `firebase-messaging` declared in `:app` (the push plugin hides it behind
   `implementation`). Release signing uses the `RELEASE_*` repo secrets; without them CI
   generates a throwaway key (this APK's update chain is bound to that key — store a permanent
   keystore). FCM activation is a separate external step: `GOOGLE_SERVICES_JSON_B64` repo secret
   + server `FIREBASE_*` env (docs/11 §8).
3. **Polish & hardening** (in progress, 2026-09-09):
   - **DONE — error copy**: `lib/errors.ts` `userError()` maps engine/server failures to short
     Russian sentences; all 23 raw `toast(e.message)` sites across 9 screens now go through
     `toastError` (technical detail stays in `console.warn`); server `userMessage` always wins.
   - **DONE — toast a11y**: toasts render in a persistent `role="status" aria-live="polite"`
     container (screen readers announce them); close buttons have accessible names.
   - **DONE — icon-button audit**: every icon-only button in the app now has an `aria-label`
     (shell nav/bell were already labelled; notifications popover close button fixed).
   - **DONE — Playwright UI smoke in CI**: `ui-smoke` job in `release.yml` boots the real dev
     stack (Vite + server, `/v1/health` readiness probe) in Chromium and verifies a fresh
     browser renders onboarding with zero uncaught page errors; traces retained on failure.
     CI-only (sandbox has no browser) — first run happens on the next tag / manual dispatch.
   - **DONE — performance static audit (§96)**: no `JSON.stringify` in render loops, `useMemo`
     on the compute-heavy screens, heavy work lives in the Rust/WASM layer. No action items.
   - **Audited, already fine**: empty states on all 13 screens (Russian title + hint + action).
   - **DONE — hardening round (2026-09-10)**, found by the new UI/planner tests:
     * the Today screen crashed with `UNIQUE constraint failed: task_history.id` when a plan was
       built twice (every "Построить план", mentor `plan_day`, or onboarding retry). Fixed at the
       root: one writer for the plan — `buildDay()` persists inside a single transaction and
       returns the stored plan, callers no longer persist it a second time, and the per-task
       history row is upserted instead of inserted.
     * `last_day_plan` was never written on a fresh database (`repo.update()` returns `undefined`
       for a missing row instead of throwing, so the `update().catch(insert)` fallback never ran) —
       the planner now checks and inserts.
     * concurrent plan builds (dashboard + Today + mentor in the same tick) died with
       `cannot start a transaction within a transaction`; `Database.transaction()` now claims the
       connection synchronously and `PlannerService` serialises its builds (`db.runExclusive`).
     * **time-driven work had no caller at all**: the daily snapshot, the weekly review, the
       monthly review and the automatic backup only happened if the user pressed a button (and the
       monthly review had no button). `dailyMaintenance()` now runs at every launch and every
       30 minutes, with device-local guard flags so nothing is duplicated; the monthly review is
       also reachable from the Progress screen.
     * **"backup performed" was never recorded**: rotation ran on every launch (it read
       `last_backup_at`, which nothing wrote), so the daily backup could pile up; a brand-new
       install also stored an image of an empty database. The timestamp is now written with the
       backup, and a pass with nothing to protect stores nothing.
     * nothing verified that a client build is free of credentials: the clients are built from
       `apps/web/dist`, so `npm run check:client-secrets` scans it (JavaScript, CSS, HTML, source
       maps, extensionless files — text is detected by content) for provider keys, JWT secrets,
       VAPID private keys and service-account files, and CI fails on a hit. The scanner carries a
       `--self-test` so the guard cannot silently stop matching.
     * the Progress screen's "Снепшот дня" button called `ensureUpToDate()`, which only backfills
       *missed* days and skips today — it reported success while creating nothing. It now saves
       today's snapshot explicitly (button label and behaviour agree), and says so when there is
       nothing to record yet.
     * building the day plan rewrote every task on every screen visit (`version` bump, `updated_at`,
       change-log row, sync operation) even when nothing changed, and the cached plan was rewritten
       each time because of its `generated_at` stamp; unchanged plans are now left alone.
     * **rotation deleted a manual backup taken seconds after a scheduled one**: the retention
       logic kept "one record per calendar day", so the second copy of a day was removed as junk.
       It now keeps the newest seven copies plus the newest of each of the last four weeks and
       three months — a fresh backup is never rotated away.
     * `deferred` could list a task that was in fact scheduled; the persisted plan is now read
       back from the database, so the UI, the AI context and the history always agree.
     * the Mentor screen took the whole chat down when `Element.scrollTo` was missing (older
       Android WebViews, non-browser DOM hosts) — guarded.
   - **Remaining**: deep performance profiling (separate phase, needs a real device).

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

# Windows, one local machine:
#   server.bat — double-click: dev server in a console window (close to stop)
#   install-autostart.bat — one-time: server starts at every logon, hidden,
#     production bundle, logs to server.log (remove: schtasks /Delete /TN
#     "LifeMentor Server" /F)
# Secrets (JWT_SECRET, provider keys, VAPID) go in a .env file in the repo
# root (copy .env.example) — read by the server, gitignored, never sent to clients.

npm test                    # 159 tests (core + server + shell driver contracts + web bootstrap + UI journeys)
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
