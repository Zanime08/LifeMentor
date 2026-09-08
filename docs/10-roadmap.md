# Roadmap & Phase Status (req. 91, 92)

Rule: **never move to the next phase with a broken previous one.** After each phase: run the app,
test it, fix bugs, check regressions, update docs.

| Phase | Deliverable | Status |
|---|---|---|
| 1 | Product specification (`docs/00-product-spec.md`) | ✅ done |
| 2 | Architecture + stack decision (`docs/01`, `docs/02`) | ✅ done |
| 3 | Repository structure (monorepo, workspaces, configs) | ✅ done |
| 4 | Database: schema, migrations, drivers, repositories, crash-safe persistence | ✅ done |
| 5 | Authentication: local session + server auth (scrypt, JWT, refresh rotation, devices) | ✅ done |
| 6 | Windows + Android shell (Tauri src-tauri, Capacitor project, SQL adapters) | ✅ code complete (binary build needs Rust/JDK on a release machine) |
| 7 | Onboarding: questionnaire + adaptive interview + model builder | ✅ done |
| 8 | Profile + long-term memory + Memory Viewer + privacy controls | ✅ done |
| 9 | Goals + tasks + calendar + projects | ✅ done |
| 10 | Daily planner + adaptive rescheduling + strict mode + free time | ✅ done |
| 11 | AI Orchestrator + providers + tools + Context Engine | ✅ done |
| 12 | Learning engine + spaced repetition + skills + assessments | ✅ done |
| 13 | Projects + skills + progress snapshots + reviews + strategy | ✅ done |
| 14 | News engine (sources, categories, urgent/digest, structuring) | ✅ done |
| 15 | Notifications (budget, quiet hours, smart reminders, scheduling) | ✅ done |
| 16 | Sync + offline (queue, incremental push/pull, conflicts) | ✅ done |
| 17 | Backup + restore + export/import + account deletion | ✅ done |
| 18 | Testing (persistence, sync, AI, planner, learning, notifications, API) | ✅ done |
| 19 | Packaging (Windows NSIS/MSI, Android APK, server release scripts) | 🟡 scripts + shell projects ready; binaries require Windows/Rust and JDK/Android SDK |
| 20 | Polishing (UI density, empty states, error copy, perf, a11y) | 🟡 ongoing |

## Post-MVP (req. 90)
Deeper weekly/monthly analytics, advanced personalization models, improved sync (delta compression,
CRDT option), Google/Outlook calendar, voice assistant, local AI models on device, desktop widgets,
system usage tracking, browser extension, wearables, email integration.

## How to run

```bash
npm install
npm run dev          # backend :8787 + web :5173 (live preview of the real app)
npm test             # full test suite
npm run build        # core + server + web production builds
```
Local data lives in `data/` (SQLite files) and is gitignored — it is *user data*, never source.
