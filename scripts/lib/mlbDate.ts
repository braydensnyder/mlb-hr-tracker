/**
 * mlbDate — single source of truth for "what date is it for MLB?"
 *
 * THE BUG WE'RE FIXING: `new Date().toISOString().slice(0, 10)` returns
 * the current UTC date. At 9 PM Pacific it's already tomorrow in UTC, so
 * the cron started processing the wrong date and the Dashboard defaulted
 * to a date that has zero games / zero HRs.
 *
 * This module fixes that by always anchoring "today" / "yesterday" to the
 * America/Los_Angeles wall clock — far enough west that even the latest
 * West Coast extra-inning game finishes before the date rolls over.
 *
 * Use these helpers EVERYWHERE the codebase needs an MLB-relative day
 * string. Direct `toISOString().slice(0, 10)` calls drift back to the
 * UTC bug — don't introduce them again.
 */

/** Format a Date in America/Los_Angeles as YYYY-MM-DD. */
export function ptDateString(d: Date = new Date()): string {
  // 'en-CA' produces YYYY-MM-DD natively, sidestepping locale parsing.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Format a Date in UTC as YYYY-MM-DD. Used only for diagnostic logging. */
export function utcDateString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The MLB "today" — the Pacific-time calendar date.
 *
 * This is what schedule pulls, processDate(), Dashboard default asOf, and
 * snapshot writes should all key off. Late-night Pacific games still fall
 * inside this date even though UTC has already rolled over.
 */
export function mlbToday(now: Date = new Date()): string {
  return ptDateString(now);
}

/** mlbToday() shifted back one day. */
export function mlbYesterday(now: Date = new Date()): string {
  return addDays(mlbToday(now), -1);
}

/** Add `delta` days to a YYYY-MM-DD string and return YYYY-MM-DD. */
export function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Diagnostic context used in cron logs + the cron response JSON. */
export interface MlbDateContext {
  /** Date the cron actually started, ISO timestamp (UTC). */
  cronStartedAt: string;
  /** Server-side UTC calendar date — what the buggy code used to use. */
  utcDate: string;
  /** America/Los_Angeles calendar date — the new source of truth. */
  ptDate: string;
  /** The date we're TARGETING for processing (= ptDate). */
  mlbTargetDate: string;
  /** mlbTargetDate - 1 day. */
  mlbYesterdayDate: string;
  /** True when the UTC and PT calendar dates disagree (i.e. late-night PT). */
  utcPtMismatch: boolean;
}

/** Build a `MlbDateContext` snapshot for the current moment. */
export function mlbDateContext(now: Date = new Date()): MlbDateContext {
  const utcDate = utcDateString(now);
  const ptDate = ptDateString(now);
  return {
    cronStartedAt: now.toISOString(),
    utcDate,
    ptDate,
    mlbTargetDate: ptDate,
    mlbYesterdayDate: addDays(ptDate, -1),
    utcPtMismatch: utcDate !== ptDate,
  };
}

/** Single-line summary of `MlbDateContext` for log lines. */
export function formatMlbDateContext(ctx: MlbDateContext): string {
  const flag = ctx.utcPtMismatch ? ' (UTC≠PT, late-night Pacific)' : '';
  return `cronStartedAt=${ctx.cronStartedAt} utcDate=${ctx.utcDate} ptDate=${ctx.ptDate} mlbTargetDate=${ctx.mlbTargetDate}${flag}`;
}
