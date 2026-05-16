/**
 * oddsCron — decides which odds snapshot type the next cron tick
 * should take, if any.
 *
 * Phase 1 cadence — MORNING ONLY (free-tier quota preservation):
 *   - 'morning'  → take when Pacific hour is 7..11 AND no morning row exists today
 *
 * Why one snapshot/day: The Odds API free tier = 500 requests/month.
 * Each snapshot ≈ 1 + (games today) credits ≈ 16/day with a full slate.
 * 16 × 30 days = 480/month, fits inside 500 with a small cushion. Three
 * snapshots/day would burn the quota in ~10 days. The window is widened
 * (7–11 PT instead of a tight 8–10) so a single missed cron tick — e.g.
 * a Vercel hiccup at 8:07 — still captures within the next hour.
 *
 * To re-enable midday / pregame later (e.g. on a paid tier), add entries
 * back to WINDOWS below and to the type union. The rest of the
 * snapshotOdds pipeline already handles all four bucket types.
 *
 * Rule of one-per-day per type: we check (target_date, snapshot_type)
 * existence in `odds_snapshots`. If any row of that type exists for
 * the date we skip.
 *
 * If the table doesn't exist (migration 011 not applied), the helper
 * returns `null` so the cron stays a no-op for odds.
 */
import { supabaseAdmin } from './supabaseAdmin.js';
import type { OddsSnapshotType } from '../snapshotOdds.js';

/** Snapshot bucket types the cron will currently consider. Keep this
 *  array in sync with WINDOWS below — add 'midday' / 'pregame' back
 *  here (and to WINDOWS) on a paid tier. */
type AutoBucket = 'morning';

export interface OddsSnapshotDecision {
  /** The bucket to fire, or null when nothing is due. */
  type: AutoBucket | null;
  /** Human-readable explanation surfaced in the cron response. */
  reason: string;
}

/** Hour in America/Los_Angeles (0..23) for the given Date. */
function ptHour(now: Date): number {
  const f = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'America/Los_Angeles',
  });
  return Number(f.format(now));
}

const WINDOWS: Record<AutoBucket, [number, number]> = {
  // Morning window widened to 7–11 PT so a missed tick still has a chance.
  morning: [7, 11],
};

async function alreadyTaken(date: string, type: OddsSnapshotType): Promise<boolean | null> {
  const { count, error } = await supabaseAdmin
    .from('odds_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('snapshot_type', type);
  if (error) {
    // Most likely cause: table doesn't exist yet.
    if (/odds_snapshots/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      return null;
    }
    console.warn(`[oddsCron] count probe failed: ${error.message}`);
    return null;
  }
  return (count ?? 0) > 0;
}

export async function decideOddsSnapshot(now: Date, date: string): Promise<OddsSnapshotDecision> {
  const hour = ptHour(now);
  const buckets = Object.keys(WINDOWS) as AutoBucket[];
  for (const t of buckets) {
    const [lo, hi] = WINDOWS[t];
    if (hour < lo || hour > hi) continue;
    const taken = await alreadyTaken(date, t);
    if (taken === null) {
      return { type: null, reason: `odds_snapshots table not available (migration 011?)` };
    }
    if (!taken) {
      return { type: t, reason: `PT hour ${hour} ∈ ${t} window, no ${t} row yet for ${date}` };
    }
  }
  return { type: null, reason: `PT hour ${hour} outside snapshot windows or all buckets already taken for ${date}` };
}
