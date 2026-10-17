import { TIMEZONE } from '../config';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, ...opts });
    cache.set(key, f);
  }
  return f;
}

/** "3 PM" */
export const formatHour = (ms: number) => fmt({ hour: 'numeric' }).format(ms);
/** "3:07 PM" */
export const formatClock = (ms: number) => fmt({ hour: 'numeric', minute: '2-digit' }).format(ms);
/** "Sat" */
export const formatWeekday = (ms: number) => fmt({ weekday: 'short' }).format(ms);
/** "Oct 18" */
export const formatMonthDay = (ms: number) => fmt({ month: 'short', day: 'numeric' }).format(ms);
/** "PDT" / "PST" */
export function tzAbbrev(ms: number): string {
  const part = fmt({ timeZoneName: 'short', hour: 'numeric' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'PT';
}
/** "Sat, Oct 18 · 3 PM PDT" */
export const formatValidTime = (ms: number) => `${formatWeekday(ms)}, ${formatMonthDay(ms)} · ${formatHour(ms)} ${tzAbbrev(ms)}`;
/** "Oct 18, 3:07 PM PDT" */
export const formatStamp = (ms: number) => `${formatMonthDay(ms)}, ${formatClock(ms)} ${tzAbbrev(ms)}`;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
export function localParts(ms: number): LocalParts {
  const parts = fmt({ year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}
export const localDayKey = (ms: number) => {
  const p = localParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
export const isSameLocalDay = (a: number, b: number) => localDayKey(a) === localDayKey(b);

/** "Today" / "Tomorrow" / "Mon" relative to `now` in California time. */
export function dayName(ms: number, now: number): string {
  if (isSameLocalDay(ms, now)) return 'Today';
  if (isSameLocalDay(ms, now + DAY_MS)) return 'Tomorrow';
  return formatWeekday(ms);
}

/** "12 min ago", "3 h ago", "2 d ago" (or "in 3 h" for future times). */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? ' ago' : '';
  const prefix = diff >= 0 ? '' : 'in ';
  if (abs < 60_000) return diff >= 0 ? 'just now' : 'in <1 min';
  if (abs < HOUR_MS) return `${prefix}${Math.round(abs / 60_000)} min${suffix}`;
  if (abs < 2 * DAY_MS) return `${prefix}${Math.round(abs / HOUR_MS)} h${suffix}`;
  return `${prefix}${Math.round(abs / DAY_MS)} d${suffix}`;
}

/** Day segments (California calendar days) covering [start, end] at hourly resolution. */
export interface DaySegment {
  key: string;
  startMs: number;
  endMs: number;
  startIndex: number;
  endIndex: number;
}
export function daySegments(startMs: number, stepMs: number, frames: number): DaySegment[] {
  const out: DaySegment[] = [];
  for (let i = 0; i < frames; i++) {
    const t = startMs + i * stepMs;
    const key = localDayKey(t);
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.endIndex = i;
      last.endMs = t;
    } else out.push({ key, startMs: t, endMs: t, startIndex: i, endIndex: i });
  }
  return out;
}

export const parseTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
export const toIso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
