# Technology Stack Decision (Phase 2, requirement 66)

The app must ship as **a normal Windows installer** and **a normal Android APK**, be
**local-first on SQLite**, work **offline**, support **notifications**, and keep
**one codebase** maintainable by a small team.

## 1. Options considered

| Option | Windows quality | Android quality | SQLite | One codebase | Binary size / runtime | Verdict |
|---|---|---|---|---|---|---|
| **A. Native pair** (WinUI 3 + Jetpack Compose) | Excellent | Excellent | Excellent (native) | ❌ two teams, two logics | Small | Rejected: duplicated domain logic = duplicated bugs, 2× cost |
| **B. Flutter** | Good (desktop still second-class: tray, autostart, OS notifications, installer polish) | Excellent | Good (`sqflite`/`drift`) | ✅ | ~25 MB | Strong candidate. Rejected: Dart-only; the AI/service layer and the backend would need a second language; embedding the same UI in a web preview/CI is not possible |
| **C. React Native + RN-Windows** | Weak (rn-windows lags, fragile packaging) | Excellent | Good | ✅ | Medium | Rejected: Windows story is the weakest link |
| **D. .NET MAUI** | Good | Acceptable | Good (`sqlite-net`) | ✅ | Large | Rejected: Android maturity + toolchain weight, smaller ecosystem for AI/HTTP work |
| **E. Electron + Capacitor** | Excellent | Excellent | Excellent (`@capacitor-community/sqlite` on both) | ✅ | ❌ 90–120 MB installer, high RAM | Rejected on packaging/perf only — otherwise fine |
| **F. Tauri 2 (Windows) + Capacitor (Android) + shared TypeScript core + React UI** | Excellent (native WebView2, 3–10 MB installer, NSIS/MSI) | Excellent (native SQLite plugin, standard Gradle APK/AAB) | Excellent: real native SQLite on both platforms | ✅ one TS domain core, one React UI | Small | **SELECTED** |
| **G. Tauri 2 for both** (Windows + Android) | Excellent | Beta-grade mobile plugins | Needs Rust bridge | ✅ | Smallest | Rejected for MVP: mobile plugin ecosystem younger than Capacitor's; keep as a future consolidation (the core is driver-abstracted, so switching costs one adapter) |
| **H. PWA only** | n/a | n/a | WASM SQLite only | ✅ | — | Rejected: violates "installable native app", no reliable background notifications on iOS/Android, no true native file storage |

## 2. Decision

**Option F.**

```
┌─────────────────────────── one TypeScript domain core ───────────────────────────┐
│  @lifementor/core: schema · repositories · services · planner · learning ·        │
│                    memory · context engine · AI orchestrator · sync · backup      │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲                              ▲                               ▲
   SqlDriver: node                SqlDriver: tauri               SqlDriver: capacitor
   (node:sqlite, server/CLI/tests) (Rust rusqlite in WebView2)    (native SQLite plugin)
        ▲                              ▲                               ▲
   apps/server                    apps/desktop (Windows .exe)     apps/mobile (Android .apk)
                                    └────────── apps/web (React UI, shared) ──────────┘
```

### Why this wins on the required criteria
* **Windows quality** — Tauri produces a real installer (NSIS `LifeMentorSetup.exe` or MSI),
  uses the OS WebView2, ~5 MB, autostart/tray/single-instance plugins available.
* **Android quality** — Capacitor is a standard Android project: Gradle builds a signed
  `LifeMentor.apk` / `.aab`; full access to SQLite, notifications, boot receiver, background work.
* **SQLite support** — real native SQLite on both platforms (not WASM, not JSON).
  The browser build uses WASM SQLite (`sql.js`) **only** for dev preview and automated tests;
  production shells always use the platform driver.
* **Offline / local-first** — the domain core never talks HTTP for reads/writes; it talks to a
  `SqlDriver`. Network appears only in `SyncEngine`, `NewsClient`, `AIProvider`.
* **Notifications** — server pushes + platform schedulers (Windows toast via Tauri notification
  plugin, Android via `@capacitor/local-notifications` + FCM for push).
* **Performance** — no full-DB queries (indexed, paginated), incremental sync, cached context.
* **UI flexibility** — React + hand-written design system; one UI adapts desktop ↔ mobile layouts.
* **Maintainability** — a single language for client core, UI and backend; the core is testable
  headlessly in CI without any device or emulator.
* **Packaging** — standard installers, no Docker, no Node.js, no Python, no terminal for the user.
* **DX** — `npm run dev` gives a live preview of the *real* app (real DB, real services).

### Backend
**Fastify 5 + TypeScript**, sharing `@lifementor/core` types and validation with the client.
Server storage: SQLite (WAL) per deployment for MVP with a documented Postgres migration path
(schema is portable SQL; repositories go through one driver). The backend exists for
**auth, sync, AI gateway (provider keys never ship to the client), news ingestion, push fan-out,
backup storage**. The end user never sees or manages it.

### AI
Provider-agnostic `AIProvider` interface (`generate`, `stream`, `generateStructured`, `embed`)
with adapters for OpenAI-compatible, Anthropic, Google and a **local heuristic provider**
(deterministic, offline, used when no key/network is configured — a real implementation, not a stub).
All AI traffic from a client goes **through the server gateway**, so no secret key ever lives in
the Windows/Android binary.

## 3. Consequences / trade-offs accepted

1. Two thin platform shells (Rust bridge + Capacitor project) instead of one — cost is ~400 lines
   of adapter code each, hidden behind `SqlDriver`/`PlatformAdapter`.
2. WebView2 must be present on Windows 10/11 — the installer bootstraps it (standard Tauri behaviour).
3. `node:sqlite` is marked experimental in Node 22 — used only for server/CLI/tests; the shipped
   Windows client uses rusqlite (stable, bundled SQLite) and Android uses the platform SQLite.
4. React in a WebView is heavier than native rendering — mitigated by route-level code splitting,
   no giant lists without virtualization, and local reads only.

## 4. Versions pinned in this repository

Node ≥ 20.11 (dev), TypeScript 5.9, Vite 5, React 18, Fastify 5, Zod 3, Vitest 2,
Tauri 2 (desktop shell), Capacitor 6/7 (mobile shell), sql.js 1.12 (WASM driver for dev/test only).
