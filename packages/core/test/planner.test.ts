import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LifeMentorApp } from '../src/app';
import { LocalHeuristicProvider } from '../src/ai/providers/local';
import { assertNoCriticalOverlap } from '../src/planning/planner';
import { dayKey, timeToMinutes } from '../src/util/time';

/**
 * Phase gate for the daily planner (req. 30–34, 82–84, 96).
 *
 * The planner is the part of the product the user feels every day, and it is the only
 * component allowed to rewrite other people's rows: it decides which task gets which hour
 * and writes that back onto the tasks. So it is tested here on the things that actually
 * broke or could break the user's day:
 *
 *  • re-planning is idempotent — building or rebuilding the day twice must never fail, and
 *    must never write a second history row for the same task/day (this used to throw
 *    `UNIQUE constraint failed: task_history.id` and abort the whole save);
 *  • real events win — nothing is ever placed over a fixed commitment (req. 31);
 *  • the day is physically bounded — an overloaded day defers work instead of inventing hours
 *    (req. 83), and `deferred` never lists something that was in fact written;
 *  • free time is protected, not whatever is left (req. 34);
 *  • a rebuild late in the day never puts work into hours that are already gone (req. 33);
 *  • the plan survives a restart, because it lives on the tasks, not in a cache (req. 94).
 */

const dirs: string[] = [];
let seq = 0;

/** Every test gets its own database file: no test may inherit another test's schedule. */
function newDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifementor-planner-'));
  dirs.push(dir);
  return join(dir, `lifementor-${++seq}.sqlite`);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function openApp(dbPath = newDatabasePath()): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: dbPath, durability: 'paranoid' },
    deviceId: 'device-planner-test',
    ai: { provider: new LocalHeuristicProvider() },
  });
}

async function seed(app: LifeMentorApp, titles: string[], minutes = 60): Promise<string[]> {
  const goal = await app.services.goals.create({ title: 'Planner goal', horizon: 'long', area: 'career' });
  const ids: string[] = [];
  for (const title of titles) {
    const task = await app.services.tasks.create({ title, goal_id: goal.id, estimated_minutes: minutes, priority: 'P1' });
    ids.push(task.id);
  }
  return ids;
}

describe('daily planner', () => {
  it('persists a plan and never writes the same history row twice (idempotent re-planning)', async () => {
    const app = await openApp();
    const day = dayKey();
    const ids = await seed(app, ['Write the chapter', 'Practise English', 'Review the budget']);
    await app.services.calendar.create({ title: 'Exam', kind: 'exam', priority: 'critical', day, start: '14:00', end: '15:00' });

    // First build.
    const first = await app.services.planner.buildDay(day);
    const placedFirst = first.slots.filter((s) => s.kind === 'task').length;
    expect(placedFirst).toBeGreaterThan(0);

    // Re-planning the same day (the user presses "Построить план" again, or the mentor does)
    // must succeed — it is the exact path that used to abort with a duplicate key.
    const second = await app.services.planner.buildDay(day);
    expect(second.slots.length).toBeGreaterThan(0);

    // And rebuilding the remainder of the day must succeed too.
    const rebuilt = await app.services.planner.rebuildRemainingDay();
    expect(rebuilt.day).toBe(day);

    // One `scheduled` history row per task per day — not one per rebuild.
    for (const id of ids) {
      const history = await app.services.tasks.history(id, 50);
      const planned = history.filter((h) => h.action === 'scheduled' && h.note?.startsWith('planner:'));
      expect(planned.length).toBeLessThanOrEqual(1);
    }
    expect(await app.repos.taskHistory.count({ action: 'scheduled' })).toBeLessThanOrEqual(placedFirst);

    await app.close();
  });

  it('never places work over a fixed commitment, and keeps it that way after a rebuild', async () => {
    const app = await openApp();
    const day = dayKey();
    await seed(app, ['Deep work', 'Reading', 'Practice']);
    const exam = await app.services.calendar.create({ title: 'Exam', kind: 'exam', priority: 'critical', day, start: '14:00', end: '15:00' });
    await app.services.calendar.create({ title: 'Commute home', kind: 'commute', day, start: '18:00', end: '19:00' });

    for (const plan of [
      await app.services.planner.buildDay(day),
      await app.services.planner.rebuildRemainingDay(),
      await app.services.planner.buildDay(day, { dryRun: true }),
    ]) {
      const busy = await app.services.calendar.busyBlocks(day);
      expect(assertNoCriticalOverlap(plan, busy), `plan overlapped a fixed event: ${JSON.stringify(plan.slots)}`).toEqual([]);
    }

    const busy = await app.services.calendar.busyBlocks(day);
    const block = busy.find((b) => b.id === exam.id);
    expect(block).toMatchObject({ start: 14 * 60, end: 15 * 60, immovable: true });
    await app.close();
  });

  it('caps an overloaded day instead of producing an impossible schedule, and reports it honestly', async () => {
    const app = await openApp();
    const day = dayKey();
    // 10 hours of commitments + 12 hours of work in a single day: physically impossible.
    await seed(app, Array.from({ length: 12 }, (_, i) => `Work block ${i + 1}`), 60);
    await app.services.calendar.create({ title: 'College', kind: 'class', priority: 'critical', day, start: '08:00', end: '14:00' });
    await app.services.calendar.create({ title: 'Work shift', kind: 'work', priority: 'critical', day, start: '15:00', end: '20:00' });

    const plan = await app.services.planner.buildDay(day);
    const plannedMinutes = plan.slots.filter((s) => s.kind === 'task').reduce((acc, s) => acc + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0);

    expect(plan.overload).toBe(true);
    expect(plan.warnings.length).toBeGreaterThan(0);
    // The fixed commitments already exceed the working day: the plan must stay minimal.
    expect(plannedMinutes).toBeLessThanOrEqual(plan.capacity_minutes + 10);
    expect(plan.deferred.length).toBeGreaterThan(0);

    // Truthfulness: nothing is listed as deferred if it was actually written to a task.
    const written = await app.repos.tasks.find({ scheduled_date: day, status: 'scheduled' }, { limit: 100 });
    const writtenIds = new Set(written.map((t) => t.id));
    expect(plan.deferred.filter((d) => writtenIds.has(d.task_id))).toEqual([]);
    for (const task of written) expect(task.scheduled_start).toBeTruthy();

    await app.close();
  });

  it('protects free time instead of filling the day (req. 34)', async () => {
    const app = await openApp();
    const day = dayKey();
    await seed(app, ['Small task'], 30);

    const plan = await app.services.planner.buildDay(day);
    const free = plan.slots.filter((s) => s.kind === 'free');
    expect(free.length).toBeGreaterThan(0);
    expect(plan.free_minutes).toBeGreaterThanOrEqual(60);
    await app.close();
  });

  it('rebuilds only what is left of a late day — never into hours that are already gone', async () => {
    const app = await openApp();
    const day = dayKey();
    await seed(app, ['Evening task', 'Another evening task'], 45);

    const now = new Date();
    now.setHours(19, 0, 0, 0);
    const plan = await app.services.planner.rebuildRemainingDay(now, 'user was late');

    expect(plan.day).toBe(day);
    for (const slot of plan.slots.filter((s) => s.kind === 'task')) {
      expect(timeToMinutes(slot.start)).toBeGreaterThanOrEqual(19 * 60);
    }
    await app.close();
  });

  it('keeps the persisted plan across a restart and reports it from the database (req. 94)', async () => {
    const dbPath = newDatabasePath();
    const app = await openApp(dbPath);
    const day = dayKey();
    await seed(app, ['Persisted task'], 45);
    const plan = await app.services.planner.buildDay(day);
    const slot = plan.slots.find((s) => s.kind === 'task');
    expect(slot).toBeTruthy();
    await app.close();

    // A new process, the same database.
    const reopened = await openApp(dbPath);
    const task = await reopened.services.tasks.get(slot!.taskId!);
    expect(task).toMatchObject({ scheduled_date: day, scheduled_start: slot!.start, scheduled_end: slot!.end, status: 'scheduled' });

    // The stored plan agrees with the tasks that carry a slot.
    const stored = await reopened.services.planner.lastPlan();
    expect(stored?.slots.some((s) => s.taskId === slot!.taskId)).toBe(true);
    const dayTasks = (await reopened.services.tasks.listForDay(day)).filter((t) => t.scheduled_start);
    expect(dayTasks.length).toBeGreaterThan(0);
    for (const t of dayTasks) {
      expect(stored?.slots.some((s) => s.taskId === t.id)).toBe(true);
    }
    await reopened.close();
  });

  it('is safe to run unattended: planning twice from two callers never corrupts the schedule', async () => {
    const app = await openApp();
    const day = dayKey();
    await seed(app, ['Concurrent A', 'Concurrent B'], 30);

    // Two callers at once (the dashboard and the mentor tool can both ask for a plan).
    const [a, b] = await Promise.all([
      app.services.planner.buildDay(day),
      app.services.planner.buildDay(day),
    ]);
    expect(a.slots.length).toBeGreaterThan(0);
    expect(b.slots.length).toBeGreaterThan(0);

    const tasks = await app.repos.tasks.find({ scheduled_date: day }, { limit: 50 });
    const starts = tasks.map((t) => t.scheduled_start).filter(Boolean);
    expect(new Set(starts).size).toBe(starts.length); // no two tasks share the same slot start
    expect(await app.db.integrityCheck()).toMatchObject({ ok: true });
    await app.close();
  });
});
