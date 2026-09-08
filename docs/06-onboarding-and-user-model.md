# Onboarding, Adaptive Interview, User Model (Phases 7, 8; req. 1–4, 27, 74, 75)

## 1. Flow

```
Welcome → Basic Questionnaire → AI Analysis → Adaptive Questions → Review User Profile
        → Create Initial Goals → Create Initial Skill Map → Create Initial Plan → Dashboard
```
State is persisted after **every answer** (`onboarding_answers` + `app_state`), so closing the app
mid-onboarding resumes exactly where the user left off (req. 94).

## 2. Stage 1 — Basic questionnaire (universal, no assumptions)

| Block | Questions (multi-select / scale / free text) |
|---|---|
| **Personal situation** | age category, education level, current activity (work/study/both/none/other), family & social situation *(only what the user wants to share — every item has "prefer not to say")*, available hours per day, current obligations (fixed commitments + hours) |
| **Goals** | what do you want to achieve (free text + suggested areas), what do you want to avoid, who do you want to become, which problems do you want to solve |
| **Skills** | what you can already do, what you are learning now, what you want to master |
| **Interests** | technology, science, business, finance, sport, creativity, languages, history, health, other |
| **Lifestyle** | typical daily rhythm (wake/sleep/work blocks), study/work schedule, free time, main distractions |
| **Planning** | preferred planning style (strict / balanced / flexible), strictness level, desired free time per day, attitude to reminders (none / gentle / firm) |
| **Career & finance** | *no strategy assumed* — user picks: stable career, high income, own business, investments, multiple income sources, financial independence, other / not decided yet |

Rules: short (≈ 6 screens), skippable per question, no dark patterns, no forced personal data,
progress saved continuously, answers stored with `source='user_provided'`.

## 3. Stage 2 — Adaptive interview

`InterviewPlanner` analyses the answers and produces a **ranked gap list**:

| Gap detector | Example trigger | Example question |
|---|---|---|
| **Missing data** | available time not given | "How many hours a day can you realistically spend on your own development?" |
| **Contradiction** | "8 h college + 2 h commute" and "6 h/day for learning" | "Your day already has 10 fixed hours. Should we plan 1–2 focused hours instead of 6?" |
| **Vague goal** | "I want to earn well" | "What does 'earning well' mean to you: stability, high income, own business, or independence from one employer?" |
| **Conflicting goals** | "move abroad" + "stay close to family" | "These two pull in different directions. Which is the priority in the next 12 months?" |
| **Skill ambiguity** | "I know programming" | "What have you actually built or shipped? That sets your starting level." |
| **Unknown constraint** | no health/family constraints given but heavy plan | "Is there anything that regularly breaks your plans (health, family, shifts)?" |
| **Missing horizon** | goals without dates | "When would you like to see the first real result?" |

Selection policy:
* each candidate question gets `importance = gap_severity × model_impact × answerability`;
* ask at most **4–8** questions, stop early when the marginal value of the next question drops below
  a threshold (information gain), or when the user says "enough";
* every asked question is stored with its **rationale** and whether the answer changed the model
  (auditability + tuning);
* questions adapt to previous answers within the same session (the loop re-runs the gap detectors).

## 4. User model construction

`UserModelBuilder` merges questionnaire answers + interview answers + defaults into the model:

```
PROFILE · VALUES · GOALS · CONSTRAINTS · INTERESTS · SKILLS · KNOWLEDGE · PROJECTS ·
PREFERENCES · TIME_AVAILABILITY · MOTIVATION_FACTORS · DISTRACTIONS ·
LEARNING_PREFERENCES · CAREER_DIRECTION · FINANCIAL_DIRECTION
```
Every element is persisted in `profile_fields` as
`{ section, key, value, source, confidence, evidence, updated_at, version }`.

| source | meaning |
|---|---|
| `user_provided` | the user stated it (questionnaire, interview, chat, memory viewer) |
| `ai_inferred` | derived by the AI from user data — **always shown as an assumption** |
| `system_observed` | measured from behaviour (completion rates, best hours, postponements) |
| `unknown` | explicitly unknown; drives the next interview question |

`confidence ∈ {confirmed, inferred, uncertain}`. The AI never presents an inference as a fact (req. 28).

## 5. Confirmation screen (req. 75)

"Here is how I understood you." — grouped cards (goals, interests, priorities, skills, constraints,
preferences, assumptions). Each item: **Confirm / Edit / Delete / "That's wrong"**.
Assumptions are visually distinct (dashed border + "AI assumption" badge).
Only after confirmation does the system generate: initial goals (with the user, editable),
initial skill map, initial knowledge map seed, and the first daily plan. A `user_model_snapshots`
row freezes the confirmed model — the immutable starting point of the user's evolution history.

## 6. Continuous adaptation (req. 27, 80)

* Every conversation runs a cheap extraction pass → candidate memories/profile updates (`inferred`).
* Behaviour signals update `personalization_profile` (≥ 3 observations before a pattern is asserted).
* Weekly review checks goals for staleness; monthly review proposes strategy changes.
* Changes are written through `propose_profile_change` → confirmation card → `change_log` +
  `strategy_changes` (old value, new value, reason, date). Old data is never erased without history.
