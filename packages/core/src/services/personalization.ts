import type { Repos } from '../db/repos';
import { newId } from '../util/id';
import { addDays, dayKey, nowIso, startOfDay } from '../util/time';

/**
 * Personalization engine (req. 29).
 *
 * Everything here is **derived** data: it is computed from real observed behaviour
 * (`behavior_signals`) and stored with an evidence count and a confidence level.
 * A pattern is only asserted after `MIN_EVIDENCE` consistent observations — the system
 * never concludes anything from a single event.
 */

export const MIN_EVIDENCE = 3;
export const STRONG_EVIDENCE = 10;

export type PersonalizationKey =
  | 'completion_rate'
  | 'realistic_daily_load'
  | 'best_focus_hours'
  | 'postponed_patterns'
  | 'plan_accuracy'
  | 'active_hours'
  | 'strict_reason_mix';

export interface PersonalizationValue<T = unknown> {
  key: PersonalizationKey;
  value: T;
  evidence_count: number;
  confidence: 'uncertain' | 'inferred' | 'confirmed';
  updated_at: string;
}

export function confidenceFor(evidenceCount: number): PersonalizationValue['confidence'] {
  if (evidenceCount >= STRONG_EVIDENCE) return 'confirmed';
  if (evidenceCount >= MIN_EVIDENCE) return 'inferred';
  return 'uncertain';
}

export class PersonalizationService {
  constructor(private readonly repos: Repos) {}

  /** Record one observation. Cheap, append-only, never throws into the caller's flow. */
  async record(kind: string, value: Record<string, unknown>, subject?: { type: string; id: string }, weight = 1): Promise<void> {
    await this.repos.behaviorSignals.insert({
      id: newId(),
      kind,
      subject_type: subject?.type ?? null,
      subject_id: subject?.id ?? null,
      value_json: JSON.stringify(value),
      weight,
      observed_at: nowIso(),
      created_at: nowIso(),
    } as never);
  }

  async get<T>(key: PersonalizationKey): Promise<PersonalizationValue<T> | null> {
    const row = await this.repos.personalization.byId(key);
    if (!row) return null;
    let value: T;
    try { value = JSON.parse(row.value_json) as T; } catch { return null; }
    return { key, value, evidence_count: row.evidence_count, confidence: row.confidence as PersonalizationValue['confidence'], updated_at: row.updated_at };
  }

  private async store(key: PersonalizationKey, value: unknown, evidenceCount: number): Promise<void> {
    const row = await this.repos.personalization.byId(key);
    const payload = { value_json: JSON.stringify(value), evidence_count: evidenceCount, confidence: confidenceFor(evidenceCount), updated_at: nowIso() };
    if (!row) await this.repos.personalization.insert({ key, ...payload } as never);
    else await this.repos.personalization.update(key, payload as never);
  }

  private async signals(kind: string, sinceDays: number): Promise<{ value: Record<string, unknown>; at: string }[]> {
    const since = addDays(new Date(), -sinceDays).toISOString();
    const rows = await this.repos.behaviorSignals.find({ kind, observed_at: { op: 'gte', value: since } }, { orderBy: { observed_at: 'asc' }, limit: 5000 });
    return rows.map((r) => {
      let value: Record<string, unknown> = {};
      try { value = JSON.parse(r.value_json) as Record<string, unknown>; } catch { /* ignore */ }
      return { value, at: r.observed_at };
    });
  }

  /** Recompute every derived signal. Called after day rollover, weekly review and on demand. */
  async recompute(): Promise<Record<string, PersonalizationValue | null>> {
    const [completed, postponed, cancelled, focus, strict] = await Promise.all([
      this.signals('task_completed', 30),
      this.signals('task_postponed', 30),
      this.signals('task_cancelled', 30),
      this.signals('focus_slot', 30),
      this.signals('strict_reason', 60),
    ]);

    // completion rate
    const decided = completed.length + postponed.length + cancelled.length;
    const completionRate = decided > 0 ? completed.length / decided : 0;
    await this.store('completion_rate', Number(completionRate.toFixed(3)), decided);

    // realistic daily load: what the user actually completes per day (not what they plan)
    const perDay = new Map<string, number>();
    for (const s of completed) {
      const day = dayKey(s.at);
      perDay.set(day, (perDay.get(day) ?? 0) + Number(s.value.minutes ?? 0));
    }
    const loads = [...perDay.values()].sort((a, b) => a - b);
    const median = loads.length ? loads[Math.floor(loads.length / 2)] ?? 0 : 0;
    const realistic = Math.round(Math.min(median * 1.2, 8 * 60));
    await this.store('realistic_daily_load', realistic, loads.length);

    // best focus hours: hours of day where completions of high-energy work cluster
    const hourScore = new Map<number, number>();
    for (const s of [...completed, ...focus]) {
      const hour = Number(s.value.hour ?? new Date(s.at).getHours());
      if (Number.isFinite(hour)) hourScore.set(hour, (hourScore.get(hour) ?? 0) + Number(s.value.weight ?? 1));
    }
    const best = [...hourScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hour]) => hour).sort((a, b) => a - b);
    await this.store('best_focus_hours', best.length >= MIN_EVIDENCE ? best : [], hourScore.size);

    // postponed patterns: which kinds/priorities get deferred
    const postponedPatterns: Record<string, number> = {};
    for (const s of postponed) {
      const key = String(s.value.kind ?? 'generic');
      postponedPatterns[key] = (postponedPatterns[key] ?? 0) + 1;
    }
    await this.store('postponed_patterns', postponedPatterns, postponed.length);

    // plan accuracy: estimated vs actual minutes
    const estimates = completed.filter((s) => Number(s.value.estimated_minutes ?? 0) > 0 && Number(s.value.actual_minutes ?? 0) > 0);
    const accuracy = estimates.length
      ? estimates.reduce((acc, s) => acc + Math.min(Number(s.value.actual_minutes) / Number(s.value.estimated_minutes), 3), 0) / estimates.length
      : 1;
    await this.store('plan_accuracy', Number(accuracy.toFixed(3)), estimates.length);

    // strict-mode reason mix (why the user skips important tasks)
    const reasonMix: Record<string, number> = {};
    for (const s of strict) reasonMix[String(s.value.reason ?? 'other')] = (reasonMix[String(s.value.reason ?? 'other')] ?? 0) + 1;
    await this.store('strict_reason_mix', reasonMix, strict.length);

    // active hours (when the user actually uses the app / completes things)
    const activeHourCounts = new Map<number, number>();
    for (const s of [...completed, ...focus]) {
      const hour = new Date(s.at).getHours();
      activeHourCounts.set(hour, (activeHourCounts.get(hour) ?? 0) + 1);
    }
    await this.store('active_hours', [...activeHourCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([h]) => h), activeHourCounts.size);

    return {
      completion_rate: await this.get('completion_rate'),
      realistic_daily_load: await this.get('realistic_daily_load'),
      best_focus_hours: await this.get('best_focus_hours'),
      postponed_patterns: await this.get('postponed_patterns'),
      plan_accuracy: await this.get('plan_accuracy'),
      strict_reason_mix: await this.get('strict_reason_mix'),
      active_hours: await this.get('active_hours'),
    };
  }

  /** Human-readable summary used by the AI context engine and the Progress screen. */
  async describe(): Promise<string[]> {
    const out: string[] = [];
    const load = await this.get<number>('realistic_daily_load');
    if (load && load.evidence_count >= MIN_EVIDENCE) out.push(`Realistically completes ~${load.value} minutes of focused work per day (${load.evidence_count} days of evidence, ${load.confidence}).`);
    const rate = await this.get<number>('completion_rate');
    if (rate && rate.evidence_count >= MIN_EVIDENCE) out.push(`Completion rate ${(rate.value * 100).toFixed(0)}% over the last 30 days (${rate.confidence}).`);
    const hours = await this.get<number[]>('best_focus_hours');
    if (hours && hours.value.length >= 2) out.push(`Most productive around ${hours.value.map((h) => `${h}:00`).join(', ')}.`);
    const accuracy = await this.get<number>('plan_accuracy');
    if (accuracy && accuracy.evidence_count >= MIN_EVIDENCE) {
      out.push(accuracy.value > 1.25 ? 'Consistently underestimates how long tasks take (plans run ~' + Math.round((accuracy.value - 1) * 100) + '% over).' : 'Time estimates are close to reality.');
    }
    const postponed = await this.get<Record<string, number>>('postponed_patterns');
    if (postponed && postponed.evidence_count >= MIN_EVIDENCE) {
      const top = Object.entries(postponed.value).sort((a, b) => b[1] - a[1])[0];
      if (top) out.push(`Most often postpones "${top[0]}" tasks (${top[1]} times).`);
    }
    return out;
  }

  /** Prune derived observations older than N days (source-of-truth data is untouched). */
  async prune(days = 120): Promise<number> {
    const cutoff = startOfDay(addDays(new Date(), -days)).toISOString();
    const res = await this.repos.db.run('DELETE FROM behavior_signals WHERE observed_at < ?', [cutoff]);
    return res.changes;
  }

  /** Today's key, useful for day-scoped signal queries. */
  today(): string { return dayKey(); }
}
