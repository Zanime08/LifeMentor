import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { CalendarEvent, EventKind, EventPriority } from '../domain/types';
import { newId } from '../util/id';
import { addMinutes, dayKey, timeToMinutes } from '../util/time';
import { AppError } from '../util/result';

export const CreateEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['class', 'work', 'meeting', 'commute', 'errand', 'training', 'social', 'health', 'exam', 'free', 'other']).default('other'),
  location: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  /** Local day (YYYY-MM-DD). Derived from `starts_at` when omitted. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** "HH:MM" local, or full ISO datetime. */
  start: z.string().min(5),
  end: z.string().min(5),
  all_day: z.boolean().default(false),
  priority: z.enum(['critical', 'normal', 'flexible']).default('normal'),
  source: z.enum(['manual', 'ai', 'import', 'external']).default('manual'),
  reminder_minutes: z.number().int().min(0).max(7 * 24 * 60).nullish(),
});
export type CreateEventInput = z.input<typeof CreateEventSchema>;
export const UpdateEventSchema = CreateEventSchema.partial();
export type UpdateEventInput = z.input<typeof UpdateEventSchema>;

export interface BusyBlock {
  id: string;
  title: string;
  kind: EventKind;
  priority: EventPriority;
  start: number; // minutes since local midnight
  end: number;
  all_day: boolean;
  immovable: boolean;
}

function toMinutes(value: string): number {
  if (/^\d{2}:\d{2}$/.test(value)) return timeToMinutes(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw AppError.validation(`Invalid time: ${value}`);
  return d.getHours() * 60 + d.getMinutes();
}

function toLocalDateTime(day: string, value: string): string {
  // Accept "HH:MM" (stored as a local datetime on `day`) or a full datetime string.
  return /^\d{2}:\d{2}$/.test(value) ? `${day}T${value}:00` : value;
}

/**
 * Calendar = reality. The planner treats these blocks as hard constraints (req. 31):
 * nothing the AI schedules may overlap a `critical` event, and exams/work/commute always win.
 */
export class CalendarService {
  constructor(private readonly repos: Repos) {}

  async create(input: CreateEventInput, ctx: WriteContext = USER_WRITE): Promise<CalendarEvent> {
    const parsed = CreateEventSchema.parse(input);
    const day = parsed.day ?? dayKey(parsed.start);
    const startMin = parsed.all_day ? 0 : toMinutes(parsed.start);
    let endMin = parsed.all_day ? 24 * 60 : toMinutes(parsed.end);
    if (endMin <= startMin) {
      if (parsed.all_day) endMin = 24 * 60;
      else throw AppError.validation('An event must end after it starts.');
    }
    const event = await this.repos.calendarEvents.insert({
      id: newId('event'),
      title: parsed.title,
      kind: parsed.kind,
      location: parsed.location ?? null,
      notes: parsed.notes ?? null,
      day_key: day,
      starts_at: toLocalDateTime(day, parsed.start),
      ends_at: toLocalDateTime(day, parsed.end),
      all_day: parsed.all_day ? 1 : 0,
      priority: parsed.priority,
      source: parsed.source,
      reminder_minutes: parsed.reminder_minutes ?? null,
    } as never, { ...ctx, reason: 'event created' });
    return event;
  }

  async update(id: string, patch: UpdateEventInput, ctx: WriteContext = USER_WRITE): Promise<CalendarEvent> {
    const before = await this.repos.calendarEvents.byId(id);
    if (!before) throw AppError.notFound('event', id);
    const record: Record<string, unknown> = {};
    const day = patch.day ?? before.day_key;
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.kind !== undefined) record.kind = patch.kind;
    if (patch.location !== undefined) record.location = patch.location ?? null;
    if (patch.notes !== undefined) record.notes = patch.notes ?? null;
    if (patch.priority !== undefined) record.priority = patch.priority;
    if (patch.source !== undefined) record.source = patch.source;
    if (patch.reminder_minutes !== undefined) record.reminder_minutes = patch.reminder_minutes ?? null;
    if (patch.all_day !== undefined) record.all_day = patch.all_day ? 1 : 0;
    const start = patch.start ?? before.starts_at.slice(11, 16);
    const end = patch.end ?? before.ends_at.slice(11, 16);
    const startMin = record.all_day === 1 ? 0 : toMinutes(start);
    const endMin = record.all_day === 1 ? 24 * 60 : toMinutes(end);
    if (endMin <= startMin && record.all_day !== 1) throw AppError.validation('An event must end after it starts.');
    record.day_key = day;
    record.starts_at = toLocalDateTime(day, start);
    record.ends_at = toLocalDateTime(day, end);

    const updated = await this.repos.calendarEvents.update(id, record as never, { ...ctx, reason: ctx.reason ?? 'event updated' });
    if (!updated) throw AppError.notFound('event', id);
    return updated;
  }

  async remove(id: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const event = await this.repos.calendarEvents.byId(id);
    if (!event) return false;
    await this.repos.calendarEvents.softDelete(id, { ...ctx, reason: 'event removed' });
    return true;
  }

  async get(id: string): Promise<CalendarEvent | null> { return (await this.repos.calendarEvents.byId(id)) ?? null; }

  async listDay(day: string): Promise<CalendarEvent[]> {
    return this.repos.calendarEvents.find({ day_key: day }, { orderBy: { starts_at: 'asc' }, limit: 200 });
  }

  async listRange(fromDay: string, toDay: string): Promise<CalendarEvent[]> {
    return this.repos.calendarEvents.find(
      { day_key: { op: 'between', value: [fromDay, toDay] } },
      { orderBy: { day_key: 'asc', starts_at: 'asc' }, limit: 1000 },
    );
  }

  async upcoming(hours = 24, from = new Date()): Promise<CalendarEvent[]> {
    const days = Math.ceil(hours / 24) + 1;
    const out: CalendarEvent[] = [];
    for (let i = 0; i < days; i++) out.push(...await this.listDay(dayKey(addMinutes(from, i * 24 * 60))));
    const limit = from.getTime() + hours * 60_000;
    return out
      .filter((e) => new Date(e.starts_at).getTime() >= from.getTime() - 60_000 && new Date(e.starts_at).getTime() <= limit)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  /** Sorted busy blocks for a day, in minutes since local midnight. */
  async busyBlocks(day: string): Promise<BusyBlock[]> {
    const events = await this.listDay(day);
    return events
      .map((e) => {
        const start = e.all_day ? 0 : Math.max(0, toMinutes(e.starts_at.slice(11, 16)));
        const end = e.all_day ? 24 * 60 : Math.min(24 * 60, toMinutes(e.ends_at.slice(11, 16)));
        return {
          id: e.id, title: e.title, kind: e.kind, priority: e.priority,
          start, end: Math.max(end, start + 5), all_day: e.all_day === 1,
          immovable: e.priority === 'critical' || ['class', 'exam', 'work', 'meeting', 'commute', 'health'].includes(e.kind),
        };
      })
      .sort((a, b) => a.start - b.start);
  }

  /** Free windows inside [fromMin, toMin] after subtracting busy blocks. */
  async freeWindows(day: string, fromMin: number, toMin: number): Promise<{ start: number; end: number }[]> {
    const blocks = (await this.busyBlocks(day)).filter((b) => b.end > fromMin && b.start < toMin);
    const windows: { start: number; end: number }[] = [];
    let cursor = fromMin;
    for (const block of blocks) {
      if (block.start > cursor) windows.push({ start: cursor, end: Math.min(block.start, toMin) });
      cursor = Math.max(cursor, block.end);
    }
    if (cursor < toMin) windows.push({ start: cursor, end: toMin });
    return windows.filter((w) => w.end - w.start >= 10);
  }

  /** Overlapping events for a candidate slot — used by the planner and by manual entry. */
  async findConflicts(day: string, startMin: number, endMin: number, excludeId?: string): Promise<CalendarEvent[]> {
    const events = await this.listDay(day);
    return events.filter((e) => {
      if (e.id === excludeId) return false;
      const s = e.all_day ? 0 : toMinutes(e.starts_at.slice(11, 16));
      const en = e.all_day ? 24 * 60 : toMinutes(e.ends_at.slice(11, 16));
      return s < endMin && en > startMin;
    });
  }

  async nextEvent(from = new Date()): Promise<CalendarEvent | null> {
    const upcoming = await this.upcoming(72, from);
    return upcoming[0] ?? null;
  }

  /** Compact rendering for the AI context engine. */
  async contextText(day = dayKey(), extraDays = 1): Promise<string> {
    const lines: string[] = [];
    for (let i = 0; i <= extraDays; i++) {
      const d = dayKey(addMinutes(new Date(`${day}T00:00:00`), i * 24 * 60));
      const events = await this.listDay(d);
      if (!events.length) continue;
      lines.push(`${d === day ? 'Today' : d} (${d}):`);
      for (const e of events) {
        const time = e.all_day ? 'all day' : `${e.starts_at.slice(11, 16)}–${e.ends_at.slice(11, 16)}`;
        lines.push(`  - ${time} ${e.title} [${e.kind}${e.priority === 'critical' ? ', critical' : ''}]`);
      }
    }
    return lines.join('\n');
  }

  async totalFixedMinutes(day: string): Promise<number> {
    const blocks = await this.busyBlocks(day);
    let total = 0;
    let lastEnd = -1;
    for (const b of blocks) { // merge overlaps so double-booked time is not counted twice
      const start = Math.max(b.start, lastEnd);
      if (b.end > start) total += b.end - start;
      lastEnd = Math.max(lastEnd, b.end);
    }
    return total;
  }
}
