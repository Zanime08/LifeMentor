/**
 * Time helpers. Everything persisted is UTC ISO-8601; "day keys" are local-time
 * YYYY-MM-DD strings because a human day is a local concept (planner, snapshots,
 * notification budget all work on day keys).
 */

export type IsoDateString = string; // YYYY-MM-DDTHH:mm:ss.sssZ
export type DayKey = string; //        YYYY-MM-DD (local)

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function nowIso(): IsoDateString {
  return new Date().toISOString();
}

export function toIso(value: Date | number | string): IsoDateString {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d.toISOString();
}

export function fromIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateFromDayKey(day: DayKey, hour = 0, minute = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0);
}

/** Local day key for a given instant (defaults to now). */
export function dayKey(value: Date | string | number = new Date()): DayKey {
  const d = typeof value === 'string' || typeof value === 'number' ? new Date(value) : value;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function addDays(value: Date | string, days: number): Date {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMinutes(value: Date | string, minutes: number): Date {
  return new Date(new Date(value).getTime() + minutes * MINUTE);
}

export function startOfDay(value: Date | string = new Date()): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(value: Date | string = new Date()): Date {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Monday-based start of week. */
export function startOfWeek(value: Date | string = new Date()): Date {
  const d = startOfDay(value);
  const dow = (d.getDay() + 6) % 7;
  return addDays(d, -dow);
}

export function startOfMonth(value: Date | string = new Date()): Date {
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

export function isSameDay(a: Date | string, b: Date | string): boolean {
  return dayKey(a) === dayKey(b);
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / MINUTE);
}

export function clampMinutes(value: number, min = 0, max = 24 * 60): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

export function formatTime(value: Date | string): string {
  const d = new Date(value);
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`;
}

export function formatDayLabel(day: DayKey): string {
  const d = dateFromDayKey(day);
  const today = dayKey();
  if (day === today) return 'Today';
  if (day === dayKey(addDays(new Date(), 1))) return 'Tomorrow';
  if (day === dayKey(addDays(new Date(), -1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "HH:MM" <-> minutes since midnight. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${`${Math.floor(m / 60)}`.padStart(2, '0')}:${`${m % 60}`.padStart(2, '0')}`;
}

/** Local datetime string used for calendar_events.starts_at (sortable, human-editable). */
export function localDateTimeIso(value: Date | string = new Date()): string {
  const d = new Date(value);
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

export function daysUntil(value: Date | string, from: Date | string = new Date()): number {
  return Math.round((startOfDay(value).getTime() - startOfDay(from).getTime()) / DAY);
}

export function relativeDayLabel(value: Date | string, from: Date | string = new Date()): string {
  const n = daysUntil(value, from);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1) return `in ${n} days`;
  return `${Math.abs(n)} days ago`;
}
