import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LifeMentorApp, NOTIFICATION_TYPES } from '@lifementor/core';

/**
 * The notification gate (req. 84–87, 43): enabled? quiet hours? duplicate? daily budget?
 *
 * The rules live in the engine, but the *values* come from the user: «Настройки → Уведомления»
 * writes the global settings. These tests pin the wiring between the two — the place where a real
 * bug lived: per-type rows created on the first launch copied the global settings and then shadowed
 * every later change, so moving quiet hours did nothing at all.
 */

let dir: string;
const path = (name: string) => join(dir, `${name}.sqlite`);

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'lifementor-notify-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function open(name: string): Promise<LifeMentorApp> {
  return LifeMentorApp.create({
    driverOptions: { kind: 'node', path: path(name), durability: 'paranoid' },
    deviceId: `device-${name}`,
    maintenance: { enabled: false },
    backup: { onFirstLaunch: false },
  });
}

/** A quiet window of ±30 minutes around `at`, as "HH:MM". */
function around(at: Date, minutes: number): string {
  const shifted = new Date(at.getTime() + minutes * 60_000);
  return `${String(shifted.getHours()).padStart(2, '0')}:${String(shifted.getMinutes()).padStart(2, '0')}`;
}

describe('notification preferences', () => {
  it('honours the quiet hours the user set — including after a restart (req. 85)', async () => {
    const app = await open('quiet');
    const now = new Date();
    // The user puts quiet hours around the current moment: a non-urgent notification must wait.
    await app.services.settings.setMany({ notifications: { quiet_start: around(now, -30), quiet_end: around(now, 30) } });
    const insideQuiet = await app.services.notifications.create({
      type: 'task_reminder', title: 'Напоминание', body: 'Через 10 минут: дописать функцию авторизации', importance: 0.5,
      dedupe_key: 'task_reminder:task-1',
    });
    expect(insideQuiet.delivered, JSON.stringify(insideQuiet)).toBe(true);
    const moved = (await app.repos.notifications.find({ dedupe_key: 'task_reminder:task-1' }, { limit: 1 }))[0];
    expect(new Date(moved!.scheduled_at).getTime()).toBeGreaterThan(Date.now() + 60_000);

    await app.close();

    // The same database after a restart: the settings must still be the ones that apply.
    const reopened = await open('quiet');
    const other = new Date();
    // Quiet hours that do NOT contain the current moment: the notification goes out right away.
    await reopened.services.settings.setMany({ notifications: { quiet_start: around(other, 120), quiet_end: around(other, 180) } });
    const outside = await reopened.services.notifications.create({
      type: 'task_reminder', title: 'Напоминание', body: 'Через 10 минут: дописать функцию авторизации', importance: 0.5,
      dedupe_key: 'task_reminder:task-2',
    });
    expect(outside.delivered, JSON.stringify(outside)).toBe(true);
    const sent = new Date((await reopened.repos.notifications.find({ dedupe_key: 'task_reminder:task-2' }, { limit: 1 }))[0]!.scheduled_at).getTime();
    expect(Math.abs(sent - Date.now())).toBeLessThan(60_000);

    await reopened.close();
  }, 60_000);

  it('refuses to bury a real, urgent event in quiet hours (req. 86)', async () => {
    const app = await open('urgent');
    const now = new Date();
    await app.services.settings.setMany({ notifications: { quiet_start: around(now, -30), quiet_end: around(now, 30) } });
    const decision = await app.services.notifications.create({
      type: 'schedule_start', title: 'Экзамен', body: 'Через 10 минут начинается экзамен по математике', importance: 0.95,
      dedupe_key: 'schedule_start:exam-1',
    });
    expect(decision.delivered).toBe(true);
    const scheduled = (await app.repos.notifications.find({ dedupe_key: 'schedule_start:exam-1' }, { limit: 1 }))[0]!;
    expect(Math.abs(new Date(scheduled.scheduled_at).getTime() - Date.now())).toBeLessThan(60_000);
    await app.close();
  }, 60_000);

  it('counts the daily budget the user set, and stops at it (req. 86)', async () => {
    const app = await open('budget');
    await app.services.settings.setMany({ notifications: { quiet_start: null, quiet_end: null, daily_budget: 2 } });
    const first = await app.services.notifications.create({ type: 'mentor_message', title: 'Первое', body: 'Контекст первого сообщения', importance: 0.5, dedupe_key: 'mentor:1' });
    const second = await app.services.notifications.create({ type: 'mentor_message', title: 'Второе', body: 'Контекст второго сообщения', importance: 0.5, dedupe_key: 'mentor:2' });
    const third = await app.services.notifications.create({ type: 'goal_review', title: 'Третье', body: 'Контекст третьего сообщения', importance: 0.5, dedupe_key: 'goal:1' });

    expect(first.delivered).toBe(true);
    expect(second.delivered).toBe(true);
    expect(third).toMatchObject({ delivered: false, reason: 'budget_exhausted' });
    const status = await app.services.notifications.budgetStatus();
    expect(status).toMatchObject({ used: 2, limit: 2, remaining: 0 });
    await app.close();
  }, 60_000);

  it('silences one kind without touching the others, and survives a restart (req. 85)', async () => {
    const app = await open('pertype');
    await app.services.settings.setMany({ notifications: { quiet_start: null, quiet_end: null, daily_budget: 10 } });
    await app.services.notifications.setTypeEnabled('important_news', false);
    // The values the user did not customize stay untouched: quiet hours and budget still come from
    // Settings, not from the row written above.
    await app.services.settings.setMany({ notifications: { daily_budget: 3 } });

    const news = await app.services.notifications.create({ type: 'important_news', title: 'Новость', body: 'Важное событие с объяснением, почему оно важно', importance: 0.6, dedupe_key: 'news:1' });
    expect(news).toMatchObject({ delivered: false, reason: 'type_disabled' });
    const reminder = await app.services.notifications.create({ type: 'task_reminder', title: 'Задача', body: 'Через 10 минут: дописать функцию авторизации', importance: 0.5, dedupe_key: 'task_reminder:task-3' });
    expect(reminder.delivered).toBe(true);
    await app.close();

    const reopened = await open('pertype');
    const stillSilent = await reopened.services.notifications.create({ type: 'important_news', title: 'Новость', body: 'Важное событие с объяснением, почему оно важно', importance: 0.6, dedupe_key: 'news:2' });
    expect(stillSilent).toMatchObject({ delivered: false, reason: 'type_disabled' });
    const prefs = await reopened.services.notifications.preferences();
    expect(prefs.important_news).toMatchObject({ enabled: 0 });
    // …and the budget the user set in Settings still applies to the other types.
    expect((await reopened.services.notifications.budgetStatus()).limit).toBe(3);
    await reopened.close();
  }, 60_000);

  it('writes the reminders a Russian reader can read (req. 6, 87)', async () => {
    const app = await open('plan-ru');
    await app.services.settings.setMany({ ai: { language: 'ru' }, profile: { locale: 'ru' } });
    const plan = {
      day: '2026-09-11',
      slots: [
        { start: '09:00', end: '10:00', kind: 'task' as const, title: 'Прочитать главу 3', taskId: 'task-1', priority: 'P1' as const,
          note: 'due today · serves a goal', note_items: [{ code: 'due_today' as const }, { code: 'serves_goal' as const }] },
        { start: '10:00', end: '10:10', kind: 'break' as const, title: 'Break', generated_title: { code: 'break' as const, params: { minutes: 10 } } },
        { start: '12:00', end: '13:00', kind: 'event' as const, title: 'Экзамен', eventId: 'event-1', immovable: true,
          note: 'fixed commitment — nothing is scheduled over this', note_items: [{ code: 'fixed_commitment' as const }] },
      ],
      deferred: [{ task_id: 'task-2', title: 'Позвонить в деканат', reason: 'less than 10 minutes of capacity left', reason_items: [{ code: 'no_room' as const }] }],
      focus_minutes: 60, free_minutes: 90, fixed_minutes: 120, capacity_minutes: 300, overload: true,
      warnings: ['You asked for 6h of work but the day realistically holds 3h after 5h of fixed commitments. 2 item(s) moved off today.'],
      warning_items: [{ code: 'overload' as const, params: { demanded: 360, capacity: 180, fixed: 300, deferred: 1 } }],
      generated_at: new Date().toISOString(),
    };
    const created = await app.services.notifications.scheduleFromPlan(plan, { leadMinutes: 10 });
    const rows = await app.repos.notifications.find({ cancelled_at: null }, { limit: 20 });

    // The reminder the OS shows for a block the engine named itself is Russian…
    const review = created.find((n) => n.type === 'daily_plan')!;
    expect(review.title).toContain('Сегодня');
    expect(review.body).toContain('Первое: 09:00 Прочитать главу 3.');
    expect(review.body).toContain('защищённого свободного времени');
    expect(review.body).toContain('1 пункт не вошёл в день.');
    // …including the honest warning about the day being overloaded, which used to be English.
    expect(review.body).toContain('Вы просили 6 ч работы');
    expect(review.body).not.toContain('item(s)');

    const task = rows.find((n) => n.entity_id === 'task-1')!;
    expect(task.body).toContain('Начинается в 09:00');
    expect(task.body).toContain('Почему сейчас: срок сегодня · работает на цель');
    const event = rows.find((n) => n.entity_id === 'event-1')!;
    expect(event.body).toContain('жёсткое обязательство');

    // An English reader still gets English.
    await app.services.settings.setMany({ ai: { language: 'en' }, profile: { locale: 'en' } });
    await app.services.notifications.cancelFor('task', 'task-1');
    const english = await app.services.notifications.scheduleFromPlan({ ...plan, day: '2026-09-12' }, { leadMinutes: 10 });
    const englishReview = english.find((n) => n.type === 'daily_plan')!;
    expect(englishReview.title).toContain('Today:');
    expect(englishReview.body).toContain('First: 09:00 Прочитать главу 3.');
    await app.close();
  }, 60_000);

  it('removes the per-type rows an older version froze at first launch (migration)', async () => {
    const app = await open('frozen');
    // Exactly what the old `ensureDefaults()` wrote: a row per type carrying the global values.
    const global = await app.services.settings.get('notifications');
    await app.services.settings.set('flags', { notification_preferences_reconciled: false });
    for (const type of ['*', ...NOTIFICATION_TYPES]) {
      await app.repos.notificationPreferences.insert({
        type, enabled: 1, channels: JSON.stringify(global.channels),
        quiet_start: '22:30', quiet_end: '07:30', daily_budget: 6,
      } as never, { actor: 'system' });
    }
    expect(Object.keys(await app.services.notifications.preferences()).length).toBe(NOTIFICATION_TYPES.length + 1);

    await app.services.notifications.ensureDefaults();

    // The frozen rows are gone, and the user's own settings rule again.
    expect(await app.services.notifications.preferences()).toEqual({});
    await app.services.settings.setMany({ notifications: { quiet_start: around(new Date(), 120), quiet_end: around(new Date(), 180), daily_budget: 2 } });
    const decision = await app.services.notifications.create({ type: 'mentor_message', title: 'Проверка', body: 'Контекст сообщения наставника', importance: 0.5, dedupe_key: 'mentor:migration' });
    expect(decision.delivered).toBe(true);
    const scheduled = (await app.repos.notifications.find({ dedupe_key: 'mentor:migration' }, { limit: 1 }))[0]!;
    expect(Math.abs(new Date(scheduled.scheduled_at).getTime() - Date.now())).toBeLessThan(60_000);
    expect((await app.services.notifications.budgetStatus()).limit).toBe(2);
    await app.close();
  }, 60_000);
});
