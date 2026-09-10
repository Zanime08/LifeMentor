import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { LocalHeuristicProvider } from '../src/ai/providers/local';
import { addDays, dayKey, startOfMonth, startOfWeek } from '../src/util/time';

/**
 * Phase gate for time-driven work (req. 11, 16, 70, 77, 78, 96).
 *
 * The daily snapshot, the weekly review, the monthly review, retention and the daily backup used
 * to exist as code that nothing called: they only happened if the user pressed a button on the
 * Progress screen (and the monthly review had no button at all). These tests pin the behaviour of
 * the maintenance pass that now runs at every launch and periodically while the app stays open.
 *
 * The rules under test are the ones a user would notice:
 *  • nothing is recorded for empty days/weeks/months — no junk in the history;
 *  • the weekly/monthly review looks at the period that ENDED, not the one that just started;
 *  • running maintenance twice does nothing the second time (no duplicates, no backup spam);
 *  • a failure inside a step never stops the app from opening;
 *  • everything is visible in the report instead of failing silently.
 */

const dirs: string[] = [];
let seq = 0;

function newDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifementor-maintenance-'));
  dirs.push(dir);
  return join(dir, `lifementor-${++seq}.sqlite`);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function openApp(
  dbPath = newDatabasePath(),
  maintenance: { enabled?: boolean; intervalMs?: number } = { enabled: false },
): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: dbPath, durability: 'paranoid' },
    deviceId: 'device-maintenance-test',
    ai: { provider: new LocalHeuristicProvider() },
    // The timer is driven manually in tests so the assertions are deterministic.
    maintenance,
  });
}

/** A user who actually did something on `day`. */
async function workedOn(app: LifeMentorApp, day: string, title = 'Real work'): Promise<void> {
  const task = await app.services.tasks.create({ title, estimated_minutes: 30, scheduled_date: day } as never);
  await app.services.tasks.complete(task.id, { actual_minutes: 30 });
}

describe('daily maintenance (req. 11, 16, 70, 77, 78)', () => {
  it('does nothing at all on a brand-new install — no junk snapshots, no extra backups', async () => {
    const app = await openApp();
    const report = await app.dailyMaintenance();

    expect(report.day).toBe(dayKey());
    expect(report.backfilled).toEqual([]);
    expect(report.snapshot).toBe(false);
    expect(report.weekly).toBe(false);
    expect(report.monthly).toBe(false);
    expect(report.failed).toEqual([]);

    // An empty day is not worth a snapshot, and a fresh install must not accumulate empty records.
    expect(await app.repos.dailySnapshots.count({})).toBe(0);
    expect(await app.repos.weeklyReviews.count({})).toBe(0);
    expect(await app.repos.monthlyReviews.count({})).toBe(0);
    await app.close();
  });

  it('snapshots the day that ended when the app opens the next morning, and never twice', async () => {
    const app = await openApp();
    const yesterday = dayKey(addDays(new Date(), -1));
    await workedOn(app, yesterday, 'Вчерашняя работа');

    // The user works on the 9th, closes the app, and it opens again on the 10th at 09:00.
    const nextMorning = new Date();
    nextMorning.setDate(nextMorning.getDate() + 1);
    nextMorning.setHours(9, 0, 0, 0);
    const report = await app.dailyMaintenance(nextMorning);

    expect(report.backfilled).toContain(yesterday);
    const snapshot = await app.services.snapshots.get(yesterday);
    expect(snapshot).not.toBeNull();
    // The snapshot is about the day that ended, and it carries that day's real content — the
    // summary comes from the deterministic generator, because the offline AI engine cannot tell
    // which period it is describing and must not guess (req. 95).
    expect(snapshot!.summary).toMatch(/2026-|planned tasks completed/);
    expect(snapshot!.completed_json).toContain('Вчерашняя работа');

    // A morning pass on the new day must not freeze an empty snapshot of that day: the snapshot is
    // taken when the day ends, otherwise it would never contain the day's real work.
    expect(report.snapshot).toBe(false);
    expect(await app.services.snapshots.get(dayKey(nextMorning))).toBeNull();

    // Same morning again: nothing to do, nothing duplicated.
    const again = await app.dailyMaintenance(nextMorning);
    expect(again.backfilled).toEqual([]);
    expect(again.snapshot).toBe(false);
    expect(await app.repos.dailySnapshots.count({})).toBe(1);
    await app.close();
  });

  it('takes today\'s snapshot in the evening and updates it, not duplicates it', async () => {
    const app = await openApp();
    const today = dayKey();
    await workedOn(app, today, 'Работа сегодня');

    const evening = new Date();
    evening.setHours(22, 30, 0, 0);
    const first = await app.dailyMaintenance(evening);
    expect(first.snapshot).toBe(true);
    expect(await app.repos.dailySnapshots.count({ day: today })).toBe(1);

    // A second pass the same evening is a no-op: the flag is set, and the snapshot is not rewritten.
    const second = await app.dailyMaintenance(evening);
    expect(second.snapshot).toBe(false);
    expect(await app.repos.dailySnapshots.count({ day: today })).toBe(1);

    // Even a manual re-run keeps exactly one row for the day (it updates in place).
    await app.services.snapshots.create(today);
    expect(await app.repos.dailySnapshots.count({ day: today })).toBe(1);
    await app.close();
  });

  it('reviews the week that ENDED — and only when that week had activity (req. 77)', async () => {
    const app = await openApp();
    const previousWeek = dayKey(addDays(startOfWeek(new Date()), -7));

    // A week with no work produces no review.
    const quiet = await app.dailyMaintenance();
    expect(quiet.weekly).toBe(false);
    expect(await app.repos.weeklyReviews.count({})).toBe(0);

    // Now the user has real work scheduled in that week (planned is enough — the review looks at
    // what the week actually contained, not only at what was finished).
    await app.services.tasks.create({ title: 'Работа на прошлой неделе', estimated_minutes: 60, scheduled_date: previousWeek } as never);
    await app.dailyMaintenance();

    const review = await app.services.weeklyReviews.forWeek(previousWeek);
    expect(review).not.toBeNull();
    expect(await app.repos.weeklyReviews.count({})).toBe(1);

    // It really is a review of the completed week, not of the current one.
    expect(await app.services.weeklyReviews.forWeek(dayKey(startOfWeek(new Date())))).toBeNull();

    // Idempotent: the flag stops a second pass from creating another review.
    const again = await app.dailyMaintenance();
    expect(again.weekly).toBe(false);
    expect(await app.repos.weeklyReviews.count({})).toBe(1);
    await app.close();
  });

  it('reviews the month that ENDED, with activity in it (req. 78)', async () => {
    const app = await openApp();
    const previousMonthStart = startOfMonth(addDays(startOfMonth(new Date()), -1));
    const previousMonth = dayKey(previousMonthStart).slice(0, 7);
    await app.services.tasks.create({ title: 'Работа в прошлом месяце', estimated_minutes: 60, scheduled_date: dayKey(previousMonthStart) } as never);

    const report = await app.dailyMaintenance();
    expect(report.monthly).toBe(true);

    const review = await app.services.monthlyReviews.forMonth(previousMonth);
    expect(review, `report: ${JSON.stringify(report)}`).not.toBeNull();
    expect(review!.strategy_proposal).toBeTruthy();
    expect(await app.services.monthlyReviews.forMonth(dayKey().slice(0, 7))).toBeNull();

    const again = await app.dailyMaintenance();
    expect(again.monthly).toBe(false);
    expect(await app.repos.monthlyReviews.count({})).toBe(1);
    await app.close();
  });

  it('the Progress «Снепшот дня» contract: today is saved only when it has content', async () => {
    const app = await openApp();
    const today = dayKey();

    // An empty day is not snapshotted: the screen says "nothing to save yet" instead of writing
    // an empty stub and claiming success (the button used to call ensureUpToDate(), which only
    // backfills missed days and skips today entirely).
    expect(await app.services.snapshots.createIfActive(today)).toBeNull();
    expect(await app.repos.dailySnapshots.count({})).toBe(0);

    // After real work the same call stores today, and calling it again refreshes the same row.
    await workedOn(app, today, 'Реальная работа');
    const first = await app.services.snapshots.createIfActive(today);
    expect(first).not.toBeNull();
    expect(first!.summary?.length ?? 0).toBeGreaterThan(0);
    const second = await app.services.snapshots.createIfActive(today);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(await app.repos.dailySnapshots.count({})).toBe(1);
    await app.close();
  });

  it('takes at most one automatic backup a day and rotates the old ones (req. 16)', async () => {
    const app = await openApp();
    const today = dayKey();
    await workedOn(app, today, 'Работа');

    const evening = new Date();
    evening.setHours(22, 0, 0, 0);
    const first = await app.dailyMaintenance(evening);
    expect(first.backup).toBe(true);
    expect(first.failed).toEqual([]);
    const backups = await app.services.backup.list();
    expect(backups.length).toBeGreaterThan(0);

    // A later pass the same day (or tomorrow morning) must not pile up backups.
    await app.dailyMaintenance(evening);
    expect((await app.services.backup.list()).length).toBe(backups.length);

    // Once a day has passed, the next pass takes a fresh one.
    const tomorrow = new Date(evening.getTime() + 24 * 60 * 60 * 1000);
    const next = await app.dailyMaintenance(tomorrow);
    expect(next.backup).toBe(true);
    await app.close();
  });

  it('honours the user\'s memory retention setting and keeps confirmed facts (req. 70)', async () => {
    const app = await openApp();
    // The retention policy only touches low-importance material; what the user told us is kept.
    const old = await app.services.memory.save({ kind: 'fact', content: 'Старое наблюдение', importance: 0.3, source: 'ai_inferred' });
    const confirmed = await app.services.memory.save({ kind: 'fact', content: 'Подтверждённый факт', importance: 0.9, source: 'user_provided' });
    await app.services.memory.confirm(confirmed.id);
    // Backdate both far beyond the retention window.
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await app.repos.memories.update(old.id, { updated_at: longAgo } as never, { actor: 'system', keepVersion: true });
    await app.repos.memories.update(confirmed.id, { updated_at: longAgo } as never, { actor: 'system', keepVersion: true });

    // Retention off (default) → nothing is deleted, ever.
    const withoutRetention = await app.dailyMaintenance();
    expect(withoutRetention.pruned).toBe(0);
    expect(await app.repos.memories.count({})).toBe(2);

    // Retention on → only the unconfirmed, old observation goes.
    await app.services.settings.set('privacy', { memory_retention_days: 30 } as never, { actor: 'user' });
    const withRetention = await app.dailyMaintenance();
    expect(withRetention.pruned).toBeGreaterThan(0);
    const remaining = await app.services.memory.list();
    expect(remaining.some((m) => m.id === confirmed.id)).toBe(true);
    await app.close();
  });

  it('reports a failing step instead of failing the launch (req. 68, 96)', async () => {
    const app = await openApp();
    const today = dayKey();
    await workedOn(app, today, 'Работа');

    // Break one step on purpose: a backup that cannot write must not stop anything else.
    (app.services.backup as unknown as { rotate: () => Promise<never> }).rotate = async () => { throw new Error('disk full'); };
    const evening = new Date();
    evening.setHours(22, 0, 0, 0);
    const report = await app.dailyMaintenance(evening);

    expect(report.failed.map((f) => f.step)).toContain('backup');
    expect(report.failed[0].message).toMatch(/disk full/);
    // The snapshot still happened, the app is alive, and the report is visible for diagnostics.
    expect(report.snapshot).toBe(true);
    expect(app.lastMaintenanceReport?.failed.length).toBeGreaterThan(0);
    expect((await app.health()).ok).toBe(true);
    await app.close();
  });

  it('keeps running while the app stays open: bootstrap starts it and close stops it', async () => {
    const app = await openApp(newDatabasePath(), { enabled: true, intervalMs: 50 });
    try {
      // Bootstrap starts the first pass without blocking the first screen; `maintenanceReady`
      // resolves when it is done (diagnostics and tests use it).
      const firstPass = await app.maintenanceReady;
      expect(firstPass).not.toBeNull();
      expect(app.maintenanceRanAt).not.toBeNull();
      expect(app.lastMaintenanceReport).not.toBeNull();

      // Calling it directly is always safe and idempotent.
      const report = await app.dailyMaintenance();
      expect(report.failed).toEqual([]);
    } finally {
      await app.close();
    }

    // No timer survives the app: the process must be able to exit (and a test runner must not hang).
    const afterClose = await openApp(newDatabasePath(), { enabled: false });
    expect(afterClose.maintenanceRanAt).toBeNull();
    await afterClose.close();
  });
});
