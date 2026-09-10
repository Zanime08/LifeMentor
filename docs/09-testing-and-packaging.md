# Testing & Packaging (Phases 18, 19; req. 17, 18, 65, 93)

## 1. Test strategy

| Layer | Tool | Runs where |
|---|---|---|
| Core domain/services/repositories | **Vitest** + in-memory SQLite (`node:sqlite`) | CI, no device |
| Persistence & crash safety | Vitest (file-backed SQLite, kill-mid-transaction, reopen) | CI |
| Sync & conflicts | Vitest (two independent client DBs + one server DB, offline/online cycles) | CI |
| AI orchestration | Vitest with a **deterministic scriptable provider** (mocks allowed in tests only, req. 95) | CI |
| Planner | Vitest scenario table (`packages/core/test/planner.test.ts`): idempotent re-planning, event insertion, overloaded day, free-time protection, late-day rebuild, restart, concurrent callers | CI |
| Server API | Vitest + Fastify `inject()` (auth, rate limit, sync, AI gateway, account deletion) | CI |
| UI | Vitest (jsdom) + Testing Library driving the **real client** — `App` + `AppProvider` + screens over a genuine `LifeMentorApp` on a temp SQLite file (`apps/web/test/ui-journey.test.tsx`): full first-run onboarding through the DOM, task create/complete, mentor chat with a real tool call, calendar event + planner safety net, restart with data intact | CI |
| Packaging | Windows install/run smoke test, Android install/run smoke test | release machine |

Command: `npm test` (all), `npm run test:core`, `npm run test:server`.

## 2. Required test matrix (req. 93)

* **Persistence**: create/update/delete, restart, crash recovery, WAL replay, migration up,
  integrity check, foreign-key violation handling, concurrent writers (busy timeout).
* **Sync**: online push/pull, offline queueing, reconnect flush, incremental cursor,
  conflict (completion vs postponement), delete-vs-update, field-level merge, idempotent re-push,
  rejected payload surfacing.
* **AI**: context building (budget, sections, relevance), tool calling (validation, whitelist,
  confirmation for critical tools), structured output (invalid JSON → retry → typed error),
  memory write/read/supersede, no-SQL guarantee (tool registry exposes no raw query).
* **Planner**: normal day, overloaded day (must defer + warn), event insertion (never overlaps a
  critical event), task postponement, adaptive rebuild order, free-time protection, energy fit,
  realistic load cap.
* **Learning**: path generation, dependency order, progress recording, spaced repetition intervals,
  lapse handling, assessment-driven level change (and refusal without evidence).
* **Notifications**: scheduling, budget cap, quiet hours, dedup, cancellation, contextual body.
* **Packaging**: Windows installer runs on a clean VM; Android APK installs and runs on a device/emulator.

## 3. Packaging — Windows (req. 17, 65)

```
apps/desktop/            # Tauri 2 shell
├── src-tauri/
│   ├── Cargo.toml       # tauri, rusqlite (bundled SQLite), tauri-plugin-notification/-autostart/-single-instance
│   ├── tauri.conf.json  # productName LifeMentor, identifier ai.lifementor.app, NSIS + MSI targets
│   ├── src/main.rs      # window, lifecycle, secure storage (Credential Manager)
│   └── src/db.rs        # sql_* commands: open/prepare/run/query/transaction/backup → real native SQLite
│   └── capabilities/    # least-privilege permissions
└── package.json         # tauri dev/build scripts
```
Build (on a Windows machine or CI with the Rust toolchain):
```
scripts/package-windows.sh   →  npm run build (web)  →  cargo tauri build  →  LifeMentorSetup.exe + .msi
```
The UI bundle is the same `apps/web` build; the SQLite driver is the Tauri adapter
(`packages/core/src/platform/tauri`), which calls the Rust `sql_*` commands — a real SQLite file in
`%APPDATA%/ai.lifementor.app/data/lifementor.sqlite` with WAL enabled.

## 4. Packaging — Android (req. 17, 65)

```
apps/mobile/             # Capacitor shell
├── capacitor.config.ts  # appId ai.lifementor.app, webDir ../../apps/web/dist
├── package.json         # @capacitor/android, @capacitor-community/sqlite, @capacitor/local-notifications,
│                        # @capacitor/preferences, @capacitor/network, @capacitor/push-notifications
└── android/             # generated Gradle project (gitignored) → app-release.apk / .aab
```
Build (machine with JDK 17 + Android SDK):
```
scripts/package-android.sh →  npm run build (web)  →  npx cap sync android
                          →  gradlew assembleRelease (+ apksigner with the release keystore)
                          →  LifeMentor.apk
```
SQLite driver: `packages/core/src/platform/capacitor` → `@capacitor-community/sqlite`
(native SQLite, WAL, transactions, `jeep-sqlite` not needed on Android). Notifications: local
notifications + exact alarms; push via FCM; boot receiver re-schedules today's reminders.

## 5. Server release

```
scripts/release-server.sh → npm run build → artifacts: dist bundle + migrations + systemd unit
                            (or Windows Service wrapper). Docker is optional and operator-side only.
```
Configuration via environment (`apps/server/.env.example`): `PORT`, `DATABASE_PATH`, `JWT_SECRET`,
`AI_PROVIDER`, provider keys, `NEWS_SOURCES`, `PUBLIC_WEB_ORIGIN`, `RATE_LIMIT_*`, `LOG_LEVEL`.

## 6. Definition of done for a phase (req. 92)

A phase is complete only when: the app starts, the phase's flows work end-to-end in the live build,
`npm test` is green, no regressions in earlier phases' tests, typecheck passes, and the docs
(architecture/schema/roadmap status) are updated in the same commit.
