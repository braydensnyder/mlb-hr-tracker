/**
 * mlbDate (frontend) — same intent as scripts/lib/mlbDate but lives in
 * src/ so the Vite build can import it without reaching across Node code.
 *
 * THE BUG WE'RE FIXING: every page used to compute "today" via
 * `new Date().toISOString().slice(0, 10)`, which returns the UTC date.
 * After ~5 PM Pacific in Daylight Time, UTC is already tomorrow — so
 * `?asOf=` defaulted to a date with zero games / zero HRs and the
 * Dashboard looked broken.
 *
 * Always use mlbToday() / mlbYesterday() in this codebase. They anchor
 * on the America/Los_Angeles wall clock, which lines up with how MLB
 * publishes schedules and lets the latest west-coast game finish before
 * the date rolls over.
 */

export function ptDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function mlbToday(now: Date = new Date()): string {
  return ptDateString(now);
}

export function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export function mlbYesterday(now: Date = new Date()): string {
  return addDays(mlbToday(now), -1);
}
