# Architecture (Phase 2)

## 1. Layer model

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ PRESENTATION   apps/web (React) · apps/desktop (Tauri) · apps/mobile (Cap.) │
│                screens, navigation, design system, platform adapters          │
├──────────────────────────────────────────────────────────────────────────────┤
│ APPLICATION    packages/core/src/services/*  (use-cases, transactions)        │
│                GoalService TaskService CalendarService ProjectService         │
│                SkillService LearningService PlannerService NewsService        │
│                NotificationService MemoryService OnboardingService            │
│                ProgressService StrategyService BackupService AccountService   │
├──────────────────────────────────────────────────────────────────────────────┤
│ INTELLIGENCE   packages/core/src/ai/*                                         │
│                AIOrchestrator · ContextEngine · ToolRegistry · Providers       │
│                MemoryEngine · PersonalizationEngine · PromptBudget             │
├──────────────────────────────────────────────────────────────────────────────┤
│ DOMAIN         packages/core/src/domain/*  (entities, invariants, value types) │
├──────────────────────────────────────────────────────────────────────────────┤
│ PERSISTENCE    packages/core/src/db/*  schema · migrations · repositories      │
│                SqlDriver interface → node / tauri / capacitor / wasm           │
├──────────────────────────────────────────────────────────────────────────────┤
│ PLATFORM       sync queue · change log · snapshots · logging · secure storage  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows point downward only. The AI layer never touches SQL; it calls
Application services through registered tools. The UI never touches SQL either — it calls services.

## 2. AI request flow (requirement 22)

```
User (UI)
  ↓  MentorService.chat(sessionId, text)
AI Interface (chat/session, streaming)
  ↓
AI Orchestrator  ── decides: answer | tool loop | structured extraction
  ↓
Context Engine   ── builds a *selective*, token-budgeted context packet
  ↓                 (profile, active goals, today's schedule, next tasks,
AI Provider         relevant skills, recent progress, retrieved memories)
  ↓
Tool Calls (validated by Zod, whitelisted, user-scoped, never raw SQL)
  ↓
Application Services (single transaction per mutation)
  ↓
SQLite (WAL, foreign keys, busy timeout) → change_log + sync_queue
```

Rules:
* **No raw SQL from AI** (req. 24). Tools are the only mutation path; each tool declares its
  Zod input schema, its risk level and whether it requires user confirmation.
* **No silent fact changes** (req. 28). Tools that alter an existing user-stated fact write
  `confidence='inferred'` + a `change_log` entry and raise a confirmation card in the UI.
* **Cost control** (req. 97): context packet is budgeted per request; cheap model for
  extraction/classification, strong model for reasoning; identical contexts are cached;
  chat history is truncated to a sliding window + retrieved memories, never the whole DB.

## 3. Data classification (req. 98)

| Class | Examples | Storage | Lifetime |
|---|---|---|---|
| **Source of truth** | profile, goals, tasks, events, projects, skills, memories, settings | SQLite tables | permanent, versioned, synced |
| **Derived** | progress snapshots, weekly/monthly reviews, personalization signals, digests | SQLite tables (`*_snapshots`, `reviews`, `signals`) | recomputable, never authoritative |
| **Temporary** | AI context cache, embeddings cache, in-flight sync batches | cache tables / memory | disposable |

Derived data is always reproducible from source-of-truth; deleting it must never lose user data.

## 4. Repository layout (req. 64, 13)

```
LifeMentor/
├── docs/                       # product spec, architecture, schema, roadmap (this folder)
├── packages/core/              # THE domain: platform-independent TypeScript
│   └── src/
│       ├── domain/             # entities, ids, invariants, enums
│       ├── db/                 # SqlDriver, schema DDL, migrations, repositories
│       ├── services/           # application use-cases (transaction boundaries)
│       ├── ai/                 # providers, orchestrator, tools, context engine, prompts
│       ├── memory/             # memory engine, retrieval, decay, confirmation states
│       ├── planning/           # daily planner, rescheduler, strict mode, free time
│       ├── learning/           # paths, topics, spaced repetition, assessments
│       ├── strategy/           # horizons, reviews, option building
│       ├── news/               # sources, categorisation, urgency, digest
│       ├── notifications/      # budget, quiet hours, smart reminders, scheduling
│       ├── sync/               # queue, incremental sync, conflict resolution
│       ├── backup/             # export, import, snapshots, integrity, recovery
│       ├── onboarding/         # questionnaire, adaptive interview, model builder
│       ├── platform/           # node / wasm / tauri / capacitor drivers + adapters
│       └── util/               # ids, time, logging, result types, validation
├── apps/
│   ├── server/                 # Fastify backend: auth, sync, AI gateway, news, push
│   ├── web/                    # React UI (shared by desktop & mobile shells)
│   ├── desktop/                # Tauri 2 shell → Windows installer (src-tauri, Rust SQLite bridge)
│   └── mobile/                 # Capacitor shell → Android APK (native SQLite, notifications)
├── scripts/                    # packaging & release scripts (Windows / Android / server)
└── tools/                      # CLI: integrity check, migrations, backup, demo seed
```

## 5. Runtime topologies

**Windows / Android (production)**
```
UI (WebView) → core services → SqlDriver(tauri|capacitor) → native SQLite file (local, WAL)
                       ↘ SyncEngine ⇄ HTTPS ⇄ backend ⇄ (accounts, sync store, AI gateway, news, push)
```
Everything the user sees is rendered from the local DB. Network failures degrade features,
never block reads/writes.

**Backend**
```
Fastify: /auth /sync /ai /news /notifications /backup /account
        → server-side SQLite (WAL) per environment → optional Postgres later
        → AIProvider adapters holding the secret keys (env/KMS, never client-side)
```

## 6. Cross-cutting concerns

* **Identity**: UUIDv7-like time-ordered ids generated client-side (`util/id.ts`) so records can be
  created offline and still merge deterministically.
* **Versioning**: every synced entity has `id, created_at, updated_at, version, deleted, sync_state`.
* **Auditability**: `change_log` records before/after for critical entities; `daily_snapshots`
  freeze the day's state for history, statistics and AI context.
* **Error handling**: services return typed `Result<T, AppError>`; the UI shows human messages;
  every error is logged with a correlation id; crash reports are opt-in and secret-free.
* **Security**: tokens in OS secure storage (Keychain/Credential Manager/Keystore via platform
  adapter), HTTPS only, server-side authorization on every request, input validation at the edge,
  rate limiting, per-user row scoping in every repository query.
* **Testability**: the whole core runs headless against in-memory SQLite — persistence, sync,
  conflicts, planner, learning, notifications and AI tool-calling are unit/integration tested.
