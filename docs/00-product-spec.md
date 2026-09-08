# LifeMentor — Product Specification (Phase 1)

> AI Personal Development Operating System for Windows + Android.
> Not a chatbot. Not a task manager. A system that turns scattered desires into
> **goals → plans → actions → measurable progress → new options**.

---

## 1. Product thesis

Most productivity tools start from a template: "you are a student", "you are a founder",
"here is your morning routine". LifeMentor starts from **evidence about the actual person**.

```
collect data → analyse → ask targeted questions → build user model → build personal development system
```

Every recommendation the system makes must be traceable to a fact with a known source
(`user_provided` / `ai_inferred` / `system_observed` / `unknown`) and a known confidence
(`confirmed` / `inferred` / `uncertain`). The AI never silently rewrites what the user said.

## 2. Who it is for

Deliberately **unspecified at install time**. The onboarding questionnaire discovers:
life situation, goals, skills, interests, lifestyle, planning preferences,
career/financial direction. No profession, age, or goal set is assumed.

## 3. Core promise (the "must not break" list)

| # | Promise | Mechanism |
|---|---------|-----------|
| P1 | My data survives any crash, kill, reboot, power loss | Local SQLite, WAL, transaction-per-change, immediate commit |
| P2 | I can use the app with no internet | Local-first: DB is the working store, network is an enhancement |
| P3 | Phone and PC stay consistent | Versioned entities + sync queue + deterministic conflict resolution |
| P4 | The mentor remembers me across months | Long-term memory store (structured + semantic), not chat history |
| P5 | I can see, edit and delete everything the AI knows | Memory Viewer, export, account deletion |
| P6 | The plan respects my real life | Hard events have absolute priority; physical limits enforced; free time protected |
| P7 | No spam | Notification budget + quiet hours + smart reminders with context |
| P8 | I stay the decision maker | AI proposes, explains, asks; user confirms; strict mode asks "why?" instead of blocking |

## 4. Feature map

### 4.1 Onboarding (2 stages)
1. **Basic questionnaire** — universal blocks: personal situation, goals, skills, interests,
   lifestyle, planning preferences, financial/career direction.
2. **Adaptive interview** — the AI analyses answers, detects *gaps, contradictions, vague goals,
   goal conflicts, unknown constraints*, then asks only the questions that actually improve the model
   (typically 4–8, never 100).
3. **Model confirmation** — "Here is how I understood you" → user Confirms/Edits → only then the
   initial strategy, skill map and first plan are generated.

### 4.2 User model
`PROFILE, VALUES, GOALS, CONSTRAINTS, INTERESTS, SKILLS, KNOWLEDGE, PROJECTS, PREFERENCES,
TIME_AVAILABILITY, MOTIVATION_FACTORS, DISTRACTIONS, LEARNING_PREFERENCES, CAREER_DIRECTION,
FINANCIAL_DIRECTION` — each element carries source + confidence + evidence + timestamps.

### 4.3 Development system
* **Goals** — hierarchy Long-term → Medium-term → Project → Skill → Task; periodic goal review.
* **Skills** — level, confidence, evidence, weak points, next assessment. Level changes require evidence.
* **Learning** — learning paths → topics → progress → reviews (active recall + spaced repetition).
* **Projects** — goal, milestones, tasks, skills, deadline, status, progress.
* **Knowledge map** — nodes + relationships; the AI spots gaps and links domains.
* **Progress** — snapshots, weekly review, monthly strategy review.
* **Strategy engine** — 3–5y → 1y → 3mo → 1mo → 1w → today → now, all levels linked.

### 4.4 Execution system
* **Daily planner** — builds the day from calendar, obligations, tasks, deadlines, goals, energy,
  available time and preferences; never schedules over a real event; protects free time.
* **Adaptive rescheduling** — a new event/lateness rebuilds the rest of the day by priority
  (critical obligations → P0 → P1 → deadlines → development → free time), not by shifting everything.
* **Strict mode** — deleting/ skipping an important task requires a reason
  (`unexpected_event, lack_of_time, fatigue, illness, procrastination, other`);
  procrastination gets named honestly plus a minimal viable version of the task.

### 4.5 Information & communication
* **News engine** — external sources, categories (world, tech, AI, economy, business, science,
  geopolitics, programming), two levels: **Urgent** and **Daily digest**, each item structured as
  What happened / Why it matters / Context / Potential impact / Source.
* **Notifications** — `daily_plan, schedule_start, task_reminder, learning_review, important_news,
  goal_review, project_deadline, mentor_message, daily_digest`; budgeted, contextual, quiet-hours aware.

### 4.6 Data ownership
Export (portable JSON archive), import (validated, with pre-import backup and diff preview),
automatic local backups, delete account (cloud + local + credentials).

## 5. MVP definition (Phase 89)

**Core:** auth, onboarding + adaptive interview, profile, SQLite, cloud sync, autosave, backup.
**AI:** mentor, context engine, long-term memory, tools.
**Productivity:** goals, tasks, calendar, daily planner, projects.
**Development:** skills, learning paths, progress, knowledge map.
**Information:** news + daily digest.
**Communication:** notifications, proactive mentor messages.
**Platform:** Windows installer, Android APK.

Post-MVP: weekly/monthly reviews depth, advanced analytics, deeper personalization,
integrations (Google/Outlook calendar, wearables, voice, local AI, widgets, browser extension).

## 6. Explicit non-goals for MVP

* No mandatory app blocking / screen-time enforcement (attention is managed through schedule,
  reminders and behaviour analysis).
* No financial advice, no profit promises — financial *education* only.
* No "XP gamification" for its own sake.
* No AI decision monopoly: the AI must increase user autonomy, not replace it.

## 7. Product feel

The main question the UI answers at every level:
> **"What is happening in my life, and what should I do right now?"**

Navigation: `Dashboard · Mentor · Today · Calendar · Goals · Learning · Projects · Skills ·
Knowledge · News · Progress · Profile · Settings` (condensed to a bottom bar on mobile).
