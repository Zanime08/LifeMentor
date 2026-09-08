# Planner, Learning, Skills, Strategy, Reviews (Phases 10, 12, 13; req. 30–46, 76–84)

## 1. Daily planner (req. 30, 31, 33, 34, 82, 83, 84)

`PlannerService.buildDay(date)` — pure function over local data (works offline, deterministic, testable):

```
1. Collect hard constraints: calendar_events for the day (priority=critical → immovable),
   sleep window, commute, meals/errands, user's available-time settings.
2. Compute free capacity = waking hours − fixed blocks − protected free time (default 1–2 h)
   − buffers (default 10 min between blocks).
3. Candidate tasks: due today/tomorrow, scheduled today, overdue, goal/project next actions,
   due learning reviews.
4. Score each candidate:
     score = 0.30·importance + 0.22·urgency + 0.18·goal_alignment + 0.12·deadline_pressure
           + 0.08·skill_value + 0.05·energy_fit + 0.05·momentum(small wins first)
   (priority is NOT urgency-only — req. 82)
5. Greedy fill of remaining free slots respecting:
     • no overlap with any event (req. 31 — a 14:00 exam blocks 14:00 study, always)
     • energy profile: high-energy tasks in the user's best hours (from personalization, default morning)
     • task estimated_duration ≤ slot length; long tasks are split into "minimal viable slice"
     • daily realistic load cap = min(capacity, rolling 14-day average completion × 1.2) (req. 83)
     • at least one break per 90 minutes of focus, and the protected free-time block
6. Emit DayPlan { slots: [{start,end,task|event|free|break}], deferred: [task+reason],
     overload_warning?, free_minutes, focus_minutes }
```
If the day cannot fit everything, the planner says so explicitly and lists what was deferred and why
("no time left after your 8 h of classes") instead of silently dropping tasks.

### Adaptive rescheduling (req. 33)
`PlannerService.rebuildRemainingDay(now, change)` — triggered by lateness, a new event,
a cancellation or a manual edit. Order of re-insertion:
**critical obligations → P0 → P1 → deadline-bound → development/learning → free time.**
It does *not* mechanically shift everything later: it re-scores, drops low-value blocks first,
merges adjacent free time, and protects the free-time block and sleep.

### Strict mode (req. 32)
If a task with `strict_flag` (or P0/deadline-bound) is deleted/skipped, the app asks for a reason:
`unexpected_event | lack_of_time | fatigue | illness | procrastination | other`.
* Legitimate reason → reschedule with an adapted plan + empathetic note.
* `procrastination` → the mentor names it directly, without shaming, and offers the **minimal version**
  ("just 10 minutes: open the file and write the function signature") + a new concrete slot.
All reasons are stored in `task_history` and feed the personalization engine.

### Free time (req. 34, 35)
Default protected free time 1–2 h/day (user setting), excluding commute/food/chores.
No mandatory app blocking — attention is managed via schedule, reminders and behaviour analysis.

## 2. Learning engine (req. 38, 39)

"I want to learn X" →
1. **Level assessment** (3–6 targeted questions or evidence from past work) → starting level.
2. **Path generation**: `learning_path` → ordered `learning_topics` with `depends_on`,
   estimated minutes, resources, and the *why* of each topic; linked to goals/skills/projects.
3. **Practice binding**: each topic produces tasks (`study`, `practice`, `test`, `recall`) that land
   in the daily planner like any other task.
4. **Active learning mix**: explanation → questions → test → practice project → repetition.
5. **Spaced repetition**: SM-2-style scheduling in `learning_reviews`
   (`interval_days`, `ease`, `repetitions`, `lapses`, `due_at`); graded answers
   (0–5) update intervals; lapses shorten them; due reviews are surfaced in Today and as notifications.
6. **Progress**: `learning_progress` rows (minutes, score, kind) → topic % → path % → skill evidence.

## 3. Skills (req. 40, 41)

`skills(level 0–100, confidence, weak_points, evidence, last_assessment_at, next_assessment_at)`.
Level changes **only** through a `skill_assessments` row with an evidence reference:
`project | practice | test | exam | task | explanation | real_result`.
`SkillService.assess()` records `level_before`, `level_after`, and requires `evidence_ref` —
the AI cannot raise a level because it "feels" so. Next assessment date is suggested from
volatility + usage (skills decay: unused skills get a review reminder, not a silent downgrade).

## 4. Knowledge map (req. 43)

`knowledge_nodes` + `knowledge_relationships(prerequisite|related|part_of|applies)` +
`knowledge_node_links` to goals/skills/topics/projects. Seeded from the user's interests and skills,
grown by learning paths and AI suggestions. The map view highlights: mastered areas, gaps
(prerequisites missing), bridges between domains ("your statistics knowledge unlocks ML"),
and next-best nodes by goal alignment.

## 5. Projects (req. 42)

`projects(goal_id, milestones, tasks, skills, deadline, status, progress)`.
Progress = weighted milestone completion + task completion. A project always answers
"which goal does this serve, which skills does it build". Stalled projects (no activity 14 days)
are flagged in the weekly review with options: restart smaller, pause, archive, or kill.

## 6. Progress, reviews, strategy (req. 76–81)

* **Progress** = levels, charts, milestones, skill assessments, snapshots — never meaningless XP.
* **Weekly review** (`weekly_reviews`): what worked, what didn't, what changed, what is blocking,
  what improved, what to do next week — the AI looks for *patterns* (e.g. "tasks scheduled after 20:00
  are completed 3× less often"), not just restated statistics.
* **Monthly review** (`monthly_reviews`): goals, skills, projects, priority shifts, strategy proposal.
* **Goal review** (`goal_reviews`): relevance, progress, inactivity, conflicts, realism, interest drift.
* **Strategy engine**: `strategy_items` across horizons `3-5y → 1y → 3mo → 1mo → 1w → today → now`,
  each linked to a goal so any today-task can be traced up to a life direction and any life direction
  can be traced down to today's actions. Changes are recorded in `strategy_changes`
  (old_goal, new_goal, reason, date) — immutable evolution history (req. 81).

## 7. Career, finance, options (req. 44–46)

`CareerEngine` analyses interests, skills, evidence (projects/portfolio), and market context
(from the news/knowledge layers) and builds **several** parallel paths rather than forcing one choice:
`Career + Freelance + Business + Digital products + Investments`. Each option is compared on
**risk, required knowledge, time, capital, potential income range, complexity, reversibility** —
with explicit uncertainty and *no* promise that all options are equally good.
Financial content is educational (financial literacy, personal finance, economic thinking,
investment literacy, risk management, entrepreneurship, sales, product creation, capital management)
and never presented as guaranteed returns or personalised financial advice.
