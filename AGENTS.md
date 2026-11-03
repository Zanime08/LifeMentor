# AGENTS.md — how to work in this repository

LifeMentor is an offline-first personal-development operating system: a local SQLite database that
holds goals, tasks, calendar, learning and long-term memory, an AI mentor on top of it, and a small
server for sync / news / notifications / the AI gateway. It ships as a Windows installer and an
Android APK; the end user never installs a database, Docker or a terminal.

Read `docs/10-roadmap.md` first — it is the honest state of the project (what is done, what is not).
`docs/00-product-spec.md` and `docs/02-architecture.md` explain why things are shaped the way they are.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | install everything (npm workspaces: `packages/core`, `apps/{server,web,desktop,mobile}`) |
| `npm test` | full suite — ~240 tests in ~45 s, real SQLite in temp dirs, no mocks of the database |
| `npx vitest run <path>` | one file, the fast loop while working |
| `npm run typecheck` | `tsc --noEmit` over the whole monorepo (alias: `npm run lint`) |
| `npm run dev:server` / `npm run dev:web` | API on :8787, client on :5173 (Vite proxies `/v1`) |
| `npm run package:server` | self-contained server archive in `release/server` (one ~2 MB `.mjs`) |
| `npm run build --workspace @lifementor/web` | client build (every screen is its own lazy chunk) |
| `npm run check:client-budget` / `check:client-secrets` | startup-size budget; no provider keys in the built client |
| `npm run ai:probe` | asks a real OpenAI-compatible endpoint whether it supports what the app uses (tools, json-schema, stream) |

Node 22+ is required to **run** the server (`node:sqlite`); `engines` allows 20.11 for building.

## Non-negotiable rules

These come from the product requirements and are not stylistic preferences:

1. **No fake features.** No `fakeData`, `mockAI`, `comingSoon`, `TODO`, placeholder screens. A feature
   either works or is documented as unfinished in the roadmap. Mocks are allowed **only** in tests.
2. **SQLite is the working store.** JSON appears only in export / import / backup / snapshot files.
   Never make a JSON file the source of truth for a feature.
3. **The AI never touches SQL.** It acts only through the 29 registered tools in
   `packages/core/src/ai/tools.ts`, and destructive ones need explicit user approval.
4. **Provider keys never reach the client.** They live in the server `.env`; the Windows/Android apps
   only know the server URL. `npm run check:client-secrets` enforces this.
5. **Crash-safe writes.** Every mutation goes through the repo/`WriteContext` layer (change journal,
   transaction). Do not write SQL directly from a screen or a service method that skipped the repo.
6. **Do not silently change confirmed facts.** Anything the AI infers is stored as `inferred`/
   `uncertain` and needs confirmation — see `docs/06-onboarding-and-user-model.md`.
7. **Copy is written twice on purpose.** The user reads Russian (or their own language) — strings for
   people live in `apps/web/src/lib/*-ru.ts`, `packages/core/src/planning/plan-text.ts` and
   `userMessage` on `AppError`. English text that remains is for the model, the logs and export.
   Never print a model instruction to the user.
8. **Never leave a phase broken.** After a change: `npm run typecheck`, `npm test`, and for UI work a
   real build. Do not rewrite working subsystems to make a new one easier.
9. **Test counts are tracked.** `README.md` and `docs/10-roadmap.md` state the number of tests and
   files; update both when the count changes.

## Where things live

```
packages/core/src/
  app.ts                 LifeMentorApp.create() — wires everything, `app.services` + `app.ai`
  db/                    driver factory (tauri → capacitor → wasm → node), repos, migrations, journal
  domain/types.ts        the entity types (no imports here on purpose)
  services/              goals, tasks, calendar, planner, learning, memory, notifications, sync, backup…
  planning/              planner + plan-text (PlanNote codes → localized sentences)
  ai/                    orchestrator, tools, context-engine, conversation, providers/{http,local,gateway}
apps/server/src/         Fastify: auth, sync, AI gateway, news poller, push, cloud backup, audit
apps/web/src/            React 18 + Vite; screens/ (lazy), lib/ (helpers + RU copy), core/ (bootstrap)
apps/desktop/src-tauri/  Rust shell (rusqlite, native notifications, NSIS)
apps/mobile/             Capacitor 8 + android/ Gradle project
docs/                    the design record — keep it truthful, it is part of the deliverable
```

## Testing conventions

* Every test runs a **real** `LifeMentorApp` on a real SQLite file in a temp dir — no database doubles.
* Web tests (`apps/web/test`) use `test/support/app-harness.ts`: `vi.mock('../src/core/app', () =>
  import('./support/app-harness'))`, then `bootstrapApp()`; `openApp()` stays `null` until `<App/>`
  renders. Import `userEvent` from `@testing-library/user-event`, not from `@testing-library/react`.
* Time-dependent tests must compute their dates (`dayKey(addDays(new Date(), 1))`). A hardcoded date
  turns a green test red the morning the calendar passes it.
* UI tests drive the real screens (jsdom) and assert what a user reads — Russian strings — not
  implementation details.

## Commit messages

`phase N: <what the user can now do>` in the same voice as `git log`. Say what was wrong before if it
was a bug; the history is read as the project's diary, not as a changelog of files.
