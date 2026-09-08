# AI Layer (Phases 11, 8; requirements 20–29, 95, 97, 99)

## 1. Provider abstraction (req. 21)

```ts
export interface AIProvider {
  readonly id: string;                       // 'openai' | 'anthropic' | 'google' | 'local-heuristic'
  readonly capabilities: { streaming, structured, embeddings, tools, maxContextTokens };
  generate(req: GenerationRequest): Promise<GenerationResult>;
  stream(req: GenerationRequest, onDelta: (d: StreamDelta) => void): Promise<GenerationResult>;
  generateStructured<T>(req: GenerationRequest, schema: ZodSchema<T>): Promise<T>;   // validated, retried
  embed(texts: string[]): Promise<number[][]>;
}
```
Adapters: **OpenAI-compatible** (OpenAI, Azure, OpenRouter, local llama.cpp/Ollama servers),
**Anthropic**, **Google Gemini**, and **LocalHeuristicProvider** — a deterministic, offline engine
that implements the same interface with rule/template-based analysis (used when no key or no
network; explicitly labelled in the UI as "offline mentor", never pretending to be a cloud model).

`generateStructured` always: builds a JSON-schema-constrained prompt → parses → **Zod-validates** →
on failure retries once with the validation error appended → then throws a typed `AIStructuredError`.
No unvalidated model output ever reaches the DB.

Model routing (cost control, req. 97):
| Task | Tier |
|---|---|
| fact extraction, classification, tagging, title generation | `cheap` |
| daily plan narrative, reminder text, news structuring | `mid` |
| adaptive interview, weekly/monthly review, strategy, conflict explanation | `strong` |

## 2. Orchestrator (req. 22, 24)

`AIOrchestrator` owns the loop: build context → call provider → if tool calls returned, validate
+ execute via `ToolRegistry` → append results → loop (max 6 iterations, hard token budget) →
persist messages, memories, change_log.

Guarantees:
* the model receives **only** the context packet, never the DB, never credentials;
* the model can only invoke **whitelisted tools** with Zod-validated arguments;
* every tool call is logged (`messages.tool_calls`, `change_log.actor='ai'`) and attributed;
* tools that modify user-stated facts require `confirmation='explicit'` → they produce a
  **proposal card** instead of writing, unless the user already confirmed in-conversation;
* runaway loops, oversized payloads and provider errors are caught, degraded and reported.

## 3. Tool catalogue (req. 23)

Read tools: `get_user_profile`, `get_user_memory`, `get_goals`, `get_skills`, `get_schedule`,
`get_tasks`, `get_project`, `get_learning_context`, `get_progress_summary`, `get_recent_news`,
`get_important_news`, `search_memory`.
Write tools: `create_goal`, `update_goal`, `archive_goal`, `assess_skill`, `create_task`,
`update_task`, `complete_task`, `reschedule_task`, `create_calendar_event`, `update_calendar_event`,
`rebuild_schedule`, `create_learning_path`, `update_learning_progress`, `schedule_review`,
`create_project`, `update_project`, `create_notification`, `save_memory`, `update_memory`,
`delete_memory`, `propose_profile_change`, `record_behavior_signal`.

Each tool declares `{ name, description, inputSchema, risk: 'read'|'write'|'critical',
requiresConfirmation, execute(ctx, input) }`. `critical` tools touching goals/strategy/profile
always go through the confirmation path (req. 28).

## 4. Context Engine (req. 25, 26)

`ContextEngine.build(intent, budgetTokens)` assembles a **selective** packet:

```
PROFILE (compact, confirmed facts first)
CURRENT GOALS (active, top-N by priority/horizon)
TODAY SCHEDULE (events + planned slots, next 24h)
ACTIVE TASKS (due/next, not the whole backlog)
CURRENT PROJECT (one, the most relevant)
RELEVANT SKILLS (linked to current goals/tasks)
RECENT PROGRESS (last snapshot deltas, streaks, completion rate)
RELEVANT MEMORY (retrieved, not the whole history)
CURRENT LEARNING CONTEXT (path + due reviews)
CONSTRAINTS & PREFERENCES (time availability, strictness, free-time target, quiet hours)
```
Retrieval is hybrid:
* **Structured retrieval** for goals/tasks/schedule/skills/projects/dates (SQL, indexed).
* **Semantic retrieval** for past conversations and memories: cosine similarity over embeddings
  when a provider supports `embed()`; otherwise BM25-ish keyword scoring over `memories`/`messages`
  (the engine works offline without embeddings — degraded but functional).
* **Recency + importance weighting**: `score = 0.55·similarity + 0.25·importance + 0.20·recency`,
  with `use_count` boosting and `superseded_by` excluding outdated facts.
* **Budgeting**: each section has a token share; overflow is compressed (summarise older items)
  rather than truncated blindly. Contexts are cached by `(intent, user model hash, day)` for reuse.

## 5. Memory system (req. 5, 27, 28, 99)

Kinds: `fact, preference, goal_change, decision, event, insight, behavior, skill_evidence`.
Each memory: content, section, importance, `source` (`user_provided|ai_inferred|system_observed`),
`confidence` (`confirmed|inferred|uncertain`), provenance (`memory_sources`), validity window,
`superseded_by` (old facts are never destroyed silently), usage counters.

Write paths:
1. **Onboarding** → `user_provided`, `confirmed`.
2. **Conversation extraction** → the orchestrator runs a cheap extraction pass over each exchange,
   producing candidate memories with `ai_inferred` + `uncertain|inferred`.
3. **Behaviour observation** → `system_observed` from real events (task completions, postponements,
   review scores, time-of-day performance). A pattern is only promoted after **≥ 3 consistent
   observations** (req. 29 — no conclusions from a single event).
4. **User edits** in the Memory Viewer → `user_provided`, `confirmed`, and any contradicting
   AI memory is superseded with a reason.

Adaptation: `PersonalizationEngine` recomputes derived signals (best study hours, preferred formats,
most-postponed task types, realistic daily load, plan-accuracy ratio) from `behavior_signals`
and stores them in `personalization_profile` — always with `evidence_count` and `confidence`,
surfaced in the UI as "observed" rather than "fact".

## 6. Proactivity without spam (req. 85, 86, 50)

`NotificationService` enforces a **daily budget** (default 6, user-configurable), quiet hours,
per-type enable flags, dedup (same entity+type within N hours), and a scoring gate:
`score = importance·0.4 + urgency·0.3 + goal_alignment·0.2 + novelty·0.1`; only items above the
threshold and within budget are delivered. Each notification carries **context**
("In 10 minutes Python starts. Today's task: finish the auth function."), not a bare alarm.

## 7. What the AI is not allowed to do

* execute SQL or arbitrary code;
* read files, network or other users' data;
* overwrite a user-stated fact without a confirmation record;
* schedule over a real calendar event or beyond physical limits;
* promise financial returns or give guaranteed financial advice (education only, req. 44);
* become the sole decision maker — every proposal explains its reasoning and is reversible (req. 71).
