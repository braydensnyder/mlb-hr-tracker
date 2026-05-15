/**
 * cronState — read/write the `cron_state` singleton + the decideMode()
 * brain for the single smart hourly cron.
 *
 * The cron endpoint (`api/cron/update.ts`) calls these in order:
 *   1. acquireCronLock()  — atomic compare-and-set; false ⇒ another run
 *      is in flight, skip this tick.
 *   2. readCronState()    — load timestamps for the mode decision.
 *   3. decideMode()       — pure fn: (now, state) → { tier, forceSnapshot }.
 *   4. ...run updateDaily(tier)...
 *   5. releaseCronLock()  — clears the lock + records what ran.
 *
 * Everything degrades gracefully: if the `cron_state` table doesn't
 * exist yet (migration 009 not run), readCronState returns null,
 * acquireCronLock returns true (no locking), and decideMode treats a
 * null state as "no prior heavy run" → it picks a `full` tier. So the
 * system still works, just without throttling, until the migration lands.
 */
import { supabaseAdmin } from './supabaseAdmin.js';

export type SmartTier = 'light' | 'full' | 'night';

export interface CronState {
  id: number;
  last_run_at: string | null;
  last_run_mode: string | null;
  last_heavy_run_at: string | null;
  last_night_run_at: string | null;
  running: boolean;
  lock_acquired_at: string | null;
  run_count: number;
}

export interface ModeDecision {
  tier: SmartTier;
  /** When true, the snapshot phase FORCE-rebuilds today's snapshot
   *  (morning baseline / nightly finalize). When false it's skip-if-exists
   *  or a no-op depending on the tier. */
  forceSnapshot: boolean;
  /** Human-readable explanation — surfaced in the cron-response JSON. */
  reason: string;
}

/** A lock older than this many minutes is considered stale and can be
 *  stolen by a new run (covers a crashed / timed-out previous run). */
const LOCK_STALE_MINUTES = 15;

/** Heavy rebuilds (tier 'full') are throttled to at most once per this
 *  many hours. ≈ 4 heavy runs/day when the cron fires hourly. */
const HEAVY_INTERVAL_HOURS = 6;

/**
 * Read the singleton cron_state row. Returns null when the table is
 * missing (migration not yet applied) — callers treat that as stateless.
 */
export async function readCronState(): Promise<CronState | null> {
  const { data, error } = await supabaseAdmin
    .from('cron_state')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) return null; // table missing → behave statelessly
  return (data as CronState | null) ?? null;
}

/**
 * Atomic compare-and-set lock. Flips running=true ONLY IF the row is
 * currently free (running=false) OR the existing lock is stale. Returns
 * true when WE acquired it.
 *
 * If the table is missing, returns true (no locking available — better
 * to run than to wedge).
 */
export async function acquireCronLock(): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const staleThreshold = new Date(Date.now() - LOCK_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('cron_state')
    .update({ running: true, lock_acquired_at: nowIso })
    .eq('id', 1)
    // Acquire when free, OR when the held lock has gone stale.
    .or(`running.eq.false,lock_acquired_at.lt.${staleThreshold}`)
    .select();
  if (error) return true; // table missing → allow the run
  return (data?.length ?? 0) > 0;
}

/**
 * Release the lock + record what this run did. heavyRan / nightRan
 * advance the throttle timestamps that decideMode() reads next time.
 * Swallows errors (a missing table just means no state to persist).
 */
export async function releaseCronLock(opts: {
  tier: SmartTier;
  heavyRan: boolean;
  nightRan: boolean;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    // Read run_count so we can bump it (Supabase has no atomic increment
    // in the JS client without an RPC; a read-then-write race here is
    // harmless — the counter is purely informational).
    const { data } = await supabaseAdmin
      .from('cron_state')
      .select('run_count')
      .eq('id', 1)
      .maybeSingle();
    const nextCount = ((data as { run_count: number } | null)?.run_count ?? 0) + 1;

    const patch: Record<string, unknown> = {
      running: false,
      last_run_at: nowIso,
      last_run_mode: opts.tier,
      run_count: nextCount,
    };
    if (opts.heavyRan) patch.last_heavy_run_at = nowIso;
    if (opts.nightRan) patch.last_night_run_at = nowIso;

    await supabaseAdmin.from('cron_state').update(patch).eq('id', 1);
  } catch {
    // table missing / transient — non-fatal, the run already did its work
  }
}

/**
 * Decide what TIER of work to do, given the wall clock + last-run state.
 * Pure function — no I/O — so it's trivially testable.
 *
 * Priority:
 *   1. NIGHT  — once per UTC day, in the post-games window (07:00–13:00
 *               UTC ≈ midnight–6am ET, after even west-coast games end).
 *               Finalizes results + force-rebuilds the nightly snapshot.
 *   2. FULL   — heavy refresh, throttled to ≥ 6h since the last heavy run.
 *               The FIRST heavy run of the UTC day is the "morning
 *               baseline" and force-rebuilds today's snapshot.
 *   3. LIGHT  — the default hourly tick: ingest live/final HRs, refresh
 *               game statuses + weather, NO heavy rebuilds, NO snapshot writes.
 */
export function decideMode(now: Date, state: CronState | null): ModeDecision {
  const utcHour = now.getUTCHours();
  const todayUtc = now.toISOString().slice(0, 10);

  const lastHeavy = state?.last_heavy_run_at ? new Date(state.last_heavy_run_at) : null;
  const lastNight = state?.last_night_run_at ? new Date(state.last_night_run_at) : null;

  const hoursSinceHeavy = lastHeavy
    ? (now.getTime() - lastHeavy.getTime()) / 3_600_000
    : Infinity;
  const ranNightToday = lastNight
    ? lastNight.toISOString().slice(0, 10) === todayUtc
    : false;
  const heavyRanToday = lastHeavy
    ? lastHeavy.toISOString().slice(0, 10) === todayUtc
    : false;

  // 1. NIGHT — post-game window, once per day.
  if (utcHour >= 7 && utcHour <= 13 && !ranNightToday) {
    return {
      tier: 'night',
      forceSnapshot: true,
      reason: `post-game window (UTC ${utcHour}:00) — night/final not yet run today`,
    };
  }

  // 2. FULL — heavy refresh every ≥ 6h.
  if (hoursSinceHeavy >= HEAVY_INTERVAL_HOURS) {
    const isFirstHeavyToday = !heavyRanToday;
    return {
      tier: 'full',
      forceSnapshot: isFirstHeavyToday,
      reason: isFirstHeavyToday
        ? 'first heavy run of the UTC day → morning baseline (force snapshot)'
        : `${hoursSinceHeavy.toFixed(1)}h since last heavy run (≥ ${HEAVY_INTERVAL_HOURS}h)`,
    };
  }

  // 3. LIGHT — default hourly tick.
  return {
    tier: 'light',
    forceSnapshot: false,
    reason:
      hoursSinceHeavy === Infinity
        ? 'no prior heavy run on record — light tick (next full run will rebuild)'
        : `${hoursSinceHeavy.toFixed(1)}h since last heavy run (< ${HEAVY_INTERVAL_HOURS}h) — light tick`,
  };
}
