/**
 * updateDaily — the single orchestrator behind the smart hourly cron.
 *
 * It runs the same five phases every time, but a per-mode `PhaseConfig`
 * decides HOW MUCH of each phase actually fires. That's what lets one
 * hourly cron be cheap most of the time and thorough a few times a day.
 *
 * Modes
 *   Smart-cron tiers (chosen automatically by decideMode in cronState.ts):
 *     - light  — hourly tick. Ingest live/final HRs, refresh today's
 *                game statuses + weather. NO heavy enrichments, NO
 *                snapshot writes, NO summary rebuilds.
 *     - full   — heavy refresh (≈ every 6h). Wide schedule pull, all
 *                enrichments, summary rebuilds. The first `full` of the
 *                UTC day force-rebuilds today's snapshot (morning baseline).
 *     - night  — post-game finalization (once/day). Same as `full` plus
 *                a forced nightly snapshot rebuild.
 *   Legacy manual modes (kept for `npm run update:*`):
 *     - daily / morning / live — see phaseConfigFor() below.
 *
 * Pipeline (each step isolated — a failure in one never kills the run):
 *   1. Schedules   — enrich:schedule (narrow=today / wide=[yesterday,+3])
 *   2. Process     — processDate(yesterday) + processDate(today): ingest
 *                    HRs from live + final games (event_key dedup).
 *   3. Enrich      — probable pitchers, handedness, venues, pitcher-starts,
 *                    weather, players. Gated by config.heavyEnrichments.
 *   4. Snapshot    — none / skip-if-exists / force-today, per config.
 *   5. Summaries   — rebuildPlayerSummaries(yesterday + today), per config.
 *
 * No data is ever deleted. HR rows dedup by event_key, game rows upsert
 * null-safe. The `summary` block on the result feeds the cron-response JSON.
 */
import { enrichSchedule } from './enrichSchedule.js';
import { processDate, type ProcessDateResult } from './processDate.js';
import { enrichProbablePitchers } from './enrichProbablePitchers.js';
import { enrichHandedness } from './enrichHandedness.js';
import { enrichVenues } from './enrichVenues.js';
import { enrichPitcherStarts } from './enrichPitcherStarts.js';
import { enrichPlayers } from './enrichPlayers.js';
import { enrichWeather, type EnrichWeatherResult } from './enrichWeather.js';
import { enrichLineups, type EnrichLineupsResult } from './enrichLineups.js';
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';
import { snapshotHrTargets, type SnapshotResult } from './snapshotHrTargets.js';
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import {
  mlbToday,
  mlbDateContext,
  formatMlbDateContext,
  addDays as mlbAddDays,
  type MlbDateContext,
} from './lib/mlbDate.js';

export type UpdateMode = 'daily' | 'morning' | 'live' | 'night' | 'light' | 'full';

/** Drives which slice of each phase runs for a given mode. */
interface PhaseConfig {
  /** narrow = today only (cheap status refresh); wide = [yesterday, today+3]. */
  scheduleWindow: 'narrow' | 'wide';
  processYesterday: boolean;
  processToday: boolean;
  /** probable-pitchers + handedness + venues + pitcher-starts + players. */
  heavyEnrichments: boolean;
  /** none = skip; missing-only = cheap fill of today; refresh-all = wide re-pull. */
  weatherRefresh: 'none' | 'missing-only' | 'refresh-all';
  /** none = no writes; skip-if-exists = idempotent; force-today = rebuild today. */
  snapshot: 'none' | 'skip-if-exists' | 'force-today';
  rebuildSummaries: boolean;
}

function phaseConfigFor(mode: UpdateMode): PhaseConfig {
  switch (mode) {
    case 'light':
      // Hourly tick — keep the app fresh, do NOTHING heavy.
      return {
        scheduleWindow: 'narrow',
        processYesterday: true,
        processToday: true,
        heavyEnrichments: false,
        weatherRefresh: 'missing-only',
        snapshot: 'none',
        rebuildSummaries: false,
      };
    case 'full':
      // Heavy refresh every ~6h. Snapshot behavior (force vs skip) is
      // decided by the caller via the `forceSnapshot` flag and passed
      // through opts — see updateDaily().
      return {
        scheduleWindow: 'wide',
        processYesterday: true,
        processToday: true,
        heavyEnrichments: true,
        weatherRefresh: 'refresh-all',
        snapshot: 'skip-if-exists', // overridden to force-today when forceSnapshot
        rebuildSummaries: true,
      };
    case 'night':
      // Post-game finalization — process finals, rebuild, lock the
      // nightly snapshot.
      return {
        scheduleWindow: 'wide',
        processYesterday: true,
        processToday: true,
        heavyEnrichments: true,
        weatherRefresh: 'refresh-all',
        snapshot: 'force-today',
        rebuildSummaries: true,
      };
    case 'morning':
      // Legacy manual: pregame baseline, today's games not yet played.
      return {
        scheduleWindow: 'wide',
        processYesterday: true,
        processToday: false,
        heavyEnrichments: true,
        weatherRefresh: 'refresh-all',
        snapshot: 'force-today',
        rebuildSummaries: true,
      };
    case 'live':
      // Legacy manual: midday refresh, preserve baseline snapshot.
      return {
        scheduleWindow: 'wide',
        processYesterday: true,
        processToday: true,
        heavyEnrichments: true,
        weatherRefresh: 'refresh-all',
        snapshot: 'none',
        rebuildSummaries: true,
      };
    case 'daily':
    default:
      // Legacy manual full pass.
      return {
        scheduleWindow: 'wide',
        processYesterday: true,
        processToday: true,
        heavyEnrichments: true,
        weatherRefresh: 'refresh-all',
        snapshot: 'skip-if-exists',
        rebuildSummaries: true,
      };
  }
}

export interface StepLog {
  step: string;
  durationMs: number;
  ok: boolean;
  /** Either the function's return value (when ok) or the error message (when failed). */
  detail?: unknown;
}

/** Roll-up of the actual-results ingest across yesterday + today, fed
 *  to the cron-response JSON and used by the Dashboard status card. */
export interface ActualResultsSummary {
  date: string;
  yesterday: ProcessDateResult | null;
  today: ProcessDateResult | null;
}

/** Flat, dashboard-friendly metrics — exactly the fields the cron
 *  response surfaces. */
export interface RunSummary {
  mode: UpdateMode;
  gamesChecked: number;
  liveGamesProcessed: number;
  finalGamesProcessed: number;
  HRsInserted: number;
  duplicatesSkipped: number;
  /** Games whose weather columns we attempted to refresh this run. */
  weatherChecked: number;
  /** Games whose weather columns we successfully wrote this run. */
  weatherUpdated: number;
  /** Games in the window that have non-null weather AFTER this run
   *  (i.e. how many games the dashboard can show weather for). */
  gamesWithWeather: number;
  /** Subset of gamesWithWeather flagged as dome / closed-roof. */
  domeOrRoofGames: number;
  /** Per-game weather fetch failures (non-fatal). */
  weatherErrors: number;
  summariesRebuilt: number;
  snapshotsCreated: number;
  snapshotsSkipped: number;
  /** Freshest home_runs.created_at seen this run (latest actual HR). */
  lastUpdatedAt: string | null;
}

export interface UpdateDailyResult {
  mode: UpdateMode;
  today: string;
  yesterday: string;
  scheduleWindow: { start: string; end: string };
  totalDurationMs: number;
  steps: StepLog[];
  failures: { step: string; error: string }[];
  actualResults: ActualResultsSummary;
  summary: RunSummary;
  /** UTC vs Pacific date snapshot captured at run start. Surfaced in the
   *  cron response so we can spot timezone drift in production logs. */
  dateContext: MlbDateContext;
}

export interface UpdateDailyOptions {
  /** When true (and the mode's config allows a snapshot), the snapshot
   *  phase FORCE-rebuilds today's snapshot instead of skip-if-exists.
   *  decideMode() sets this for the first `full` run of the UTC day. */
  forceSnapshot?: boolean;
}

// Date math is delegated to scripts/lib/mlbDate so every script keys off
// the SAME notion of "today" — the America/Los_Angeles calendar date,
// not the server's UTC clock.
const addDays = mlbAddDays;

async function runStep<T>(name: string, fn: () => Promise<T>, log: StepLog[]): Promise<T | null> {
  const t0 = Date.now();
  console.log(`\n--- ${name}`);
  try {
    const out = await fn();
    const durationMs = Date.now() - t0;
    log.push({ step: name, durationMs, ok: true, detail: out });
    console.log(`    ✓ done in ${(durationMs / 1000).toFixed(1)}s`);
    return out;
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    log.push({ step: name, durationMs, ok: false, detail: msg });
    console.error(`    ✗ FAILED after ${(durationMs / 1000).toFixed(1)}s: ${msg}`);
    return null;
  }
}

export async function updateDaily(
  mode: UpdateMode = 'daily',
  opts: UpdateDailyOptions = {},
): Promise<UpdateDailyResult> {
  const t0 = Date.now();
  const startDate = new Date(t0);
  // Anchor the run on the Pacific calendar date — see scripts/lib/mlbDate.ts
  // for why we don't trust new Date().toISOString() here.
  const dateContext = mlbDateContext(startDate);
  const today = dateContext.mlbTargetDate;
  const yesterday = dateContext.mlbYesterdayDate;
  const tomorrow = addDays(today, 1);
  const plus3 = addDays(today, 3);

  const cfg = phaseConfigFor(mode);
  // `full` mode's snapshot behavior depends on whether this is the
  // morning baseline run — caller passes forceSnapshot for that.
  const effectiveSnapshot: PhaseConfig['snapshot'] =
    mode === 'full' && opts.forceSnapshot ? 'force-today' : cfg.snapshot;

  const schedStart = cfg.scheduleWindow === 'wide' ? yesterday : today;
  const schedEnd = cfg.scheduleWindow === 'wide' ? plus3 : today;

  console.log(`\n████████████████████████████████████████████████████`);
  console.log(`  HR Tracker — update:${mode}`);
  console.log(`  ${formatMlbDateContext(dateContext)}`);
  console.log(`  today=${today}  yesterday=${yesterday}`);
  if (dateContext.utcPtMismatch) {
    console.log(
      `  ⚠ UTC date (${dateContext.utcDate}) differs from Pacific date (${dateContext.ptDate}). ` +
        `Targeting MLB date = ${today} (Pacific).`,
    );
  }
  console.log(`  schedule window=${schedStart} → ${schedEnd} (${cfg.scheduleWindow})`);
  console.log(`  heavy enrichments=${cfg.heavyEnrichments}  weather=${cfg.weatherRefresh}  ` +
    `snapshot=${effectiveSnapshot}  summaries=${cfg.rebuildSummaries}`);
  console.log(`████████████████████████████████████████████████████`);

  const steps: StepLog[] = [];

  // -------------------------------------------------------------
  // 1. Pull schedules
  // -------------------------------------------------------------
  console.log(`\n[1/5] Pull schedules (${schedStart} → ${schedEnd})`);
  await runStep(
    `enrich:schedule ${schedStart} → ${schedEnd}`,
    () => enrichSchedule({ start: schedStart, end: schedEnd }),
    steps,
  );

  // -------------------------------------------------------------
  // 2. Process games — live + final HR ingestion.
  // -------------------------------------------------------------
  console.log(`\n[2/5] Process games (live + final)`);
  let yesterdayResult: ProcessDateResult | null = null;
  let todayResult: ProcessDateResult | null = null;

  if (cfg.processYesterday) {
    yesterdayResult = await runStep(
      `processDate(yesterday=${yesterday})`,
      async () => {
        const r = await processDate(yesterday);
        logProcessResult(r);
        if (r.liveGamesChecked === 0 && r.finalGamesProcessed === 0 && r.alreadyProcessed === r.totalGames) {
          console.log(`    yesterday fully ingested — all ${r.totalGames} game(s) processed`);
        } else if (r.liveGamesChecked + r.pendingPregame > 0) {
          console.log(
            `    yesterday still has ${r.liveGamesChecked + r.pendingPregame} game(s) not yet final — will re-check next tick`,
          );
        }
        return r;
      },
      steps,
    );
  } else {
    console.log(`    (yesterday skipped — mode=${mode})`);
  }

  if (cfg.processToday) {
    todayResult = await runStep(
      `processDate(today=${today})`,
      async () => {
        const r = await processDate(today);
        logProcessResult(r);
        return r;
      },
      steps,
    );
  } else {
    console.log(`    (today skipped — mode=${mode}, games not yet played)`);
  }

  // -------------------------------------------------------------
  // 3. Enrich data — gated by config.
  //    Weather always runs (it's cheap + isolated); the heavy
  //    /v1/people-style loops only run when heavyEnrichments=true.
  // -------------------------------------------------------------
  console.log(`\n[3/5] Enrich data (heavy=${cfg.heavyEnrichments})`);
  let weatherResult: EnrichWeatherResult | null = null;

  if (cfg.heavyEnrichments) {
    await runStep(
      `enrich:probable-pitchers ${schedStart} → ${schedEnd}`,
      () => enrichProbablePitchers({ start: schedStart, end: schedEnd }),
      steps,
    );
    await runStep(`enrich:handedness (limit 100)`, () => enrichHandedness({ limit: 100 }), steps);
    await runStep(`enrich:venues (limit 30)`, () => enrichVenues({ limit: 30 }), steps);
    await runStep(
      `enrich:pitcher-starts (${addDays(today, -14)} → ${today})`,
      () => enrichPitcherStarts({ start: addDays(today, -14), end: today }),
      steps,
    );
    // Players: heaviest loop. Skip on night to keep the finalize run fast.
    if (mode !== 'night') {
      await runStep(
        `enrich:players (limit 100, refresh ≥7d)`,
        () => enrichPlayers({ limit: 100, refreshDays: 7 }),
        steps,
      );
    } else {
      console.log(`    (skipping enrich:players on night mode)`);
    }
  } else {
    console.log(`    (heavy enrichments skipped — mode=${mode}, light tick)`);
  }

  // Weather — light tick does a cheap "missing only / today only" fill;
  // full/night do a wide refresh-all so live conditions update.
  if (cfg.weatherRefresh === 'missing-only') {
    weatherResult = await runStep(
      `enrich:weather (${today}, missing-only)`,
      () => enrichWeather({ start: today, end: today, refreshAll: false }),
      steps,
    );
  } else if (cfg.weatherRefresh === 'refresh-all') {
    weatherResult = await runStep(
      `enrich:weather (${schedStart} → ${schedEnd}, refresh-all)`,
      () => enrichWeather({ start: schedStart, end: schedEnd, refreshAll: true }),
      steps,
    );
  } else {
    console.log(`    (weather refresh skipped — mode=${mode})`);
  }

  // Lineups — cheap, runs on EVERY tier (including light) so confirmed
  // batting orders land as soon as MLB posts them and HR Targets can
  // filter out non-starters. Only checks today + tomorrow (the window
  // where lineups matter); skips final/confirmed games internally.
  let lineupsResult: EnrichLineupsResult | null = null;
  lineupsResult = await runStep(
    `enrich:lineups (${today} → ${tomorrow})`,
    () => enrichLineups({ start: today, end: tomorrow }),
    steps,
  );
  if (lineupsResult) {
    console.log(
      `    lineups — ${lineupsResult.lineupsConfirmed} confirmed, ` +
        `${lineupsResult.stillPending} pending, ${lineupsResult.deadGames} dead game(s)`,
    );
  }

  console.log(`    live preview updated — underlying data refreshed (saved snapshot untouched)`);

  // -------------------------------------------------------------
  // 4. Snapshot HR Targets — config-driven.
  //    none           → preserve the baseline (light / legacy live)
  //    skip-if-exists → idempotent, pre-game-only (legacy daily / full non-morning)
  //    force-today    → rebuild today's snapshot (morning baseline / night finalize)
  // -------------------------------------------------------------
  console.log(`\n[4/5] Snapshot HR Targets — ${effectiveSnapshot}`);
  let snapshotsCreated = 0;
  let snapshotsSkipped = 0;

  if (effectiveSnapshot === 'none') {
    console.log(`    no snapshot writes — preserving baseline (mode=${mode})`);
    steps.push({
      step: `snapshot:hr-targets — skipped (mode=${mode}, preserving baseline)`,
      durationMs: 0,
      ok: true,
      detail: { skipped: true, reason: `${mode} mode preserves baseline` },
    });
    snapshotsSkipped += 1;
  } else {
    const forceToday = effectiveSnapshot === 'force-today';
    if (forceToday) {
      console.log(`    force-rebuild today's snapshot, skip-if-exists tomorrow`);
    } else {
      console.log(`    skip-if-exists + pre-game-only for today + tomorrow`);
    }
    const todaySnap = await runStep(
      `snapshot:hr-targets(${today})${forceToday ? ' [force=true]' : ''}`,
      () => snapshotHrTargets(today, { force: forceToday, skipIfGamesStarted: !forceToday }),
      steps,
    );
    const tomorrowSnap = await runStep(
      `snapshot:hr-targets(${tomorrow})`,
      () => snapshotHrTargets(tomorrow, { force: false, skipIfGamesStarted: true }),
      steps,
    );
    for (const snap of [todaySnap, tomorrowSnap] as (SnapshotResult | null)[]) {
      if (!snap) continue;
      if (snap.skipped || snap.inserted === 0) snapshotsSkipped += 1;
      else snapshotsCreated += 1;
    }
  }

  // -------------------------------------------------------------
  // 5. Rebuild summaries — config-driven (skipped on light ticks).
  // -------------------------------------------------------------
  console.log(`\n[5/5] Rebuild summaries (${cfg.rebuildSummaries ? 'on' : 'skipped — light tick'})`);
  let summariesRebuilt = 0;
  if (cfg.rebuildSummaries) {
    const ySummary = await runStep(
      `rebuildPlayerSummaries(${yesterday})`,
      () => rebuildPlayerSummaries(yesterday),
      steps,
    );
    const tSummary = await runStep(
      `rebuildPlayerSummaries(${today})`,
      () => rebuildPlayerSummaries(today),
      steps,
    );
    if (ySummary != null) summariesRebuilt += 1;
    if (tSummary != null) summariesRebuilt += 1;
  } else {
    console.log(`    (summary rebuilds skipped — mode=${mode})`);
  }

  // -------------------------------------------------------------
  // Diagnostic — read back what landed in Supabase.
  // -------------------------------------------------------------
  await logSnapshotDiagnostics(today, tomorrow);

  // -------------------------------------------------------------
  // Wrap-up + summary roll-up
  // -------------------------------------------------------------
  const totalDurationMs = Date.now() - t0;
  const failures = steps
    .filter((s) => !s.ok)
    .map((s) => ({ step: s.step, error: String(s.detail) }));

  const pd = [yesterdayResult, todayResult].filter((r): r is ProcessDateResult => r != null);
  const sumField = (f: (r: ProcessDateResult) => number) => pd.reduce((acc, r) => acc + f(r), 0);
  const latestUpdated = pd
    .map((r) => r.latestHrCreatedAt)
    .filter((s): s is string => !!s)
    .sort()
    .pop() ?? null;

  const summary: RunSummary = {
    mode,
    gamesChecked: sumField((r) => r.totalGames),
    liveGamesProcessed: sumField((r) => r.liveGamesChecked),
    finalGamesProcessed: sumField((r) => r.finalGamesProcessed),
    HRsInserted: sumField((r) => r.homeRunsInserted),
    duplicatesSkipped: sumField((r) => r.duplicatesSkipped),
    weatherChecked: weatherResult?.weatherChecked ?? 0,
    weatherUpdated: weatherResult?.weatherFilled ?? 0,
    gamesWithWeather: weatherResult?.gamesWithWeather ?? 0,
    domeOrRoofGames: weatherResult?.domeOrRoofGames ?? 0,
    weatherErrors: weatherResult?.failures.length ?? 0,
    summariesRebuilt,
    snapshotsCreated,
    snapshotsSkipped,
    lastUpdatedAt: latestUpdated,
  };

  console.log(`\n████████████████████████████████████████████████████`);
  console.log(`  active mode: ${mode}`);
  console.log(`  update:${mode} complete in ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  ${steps.length} step(s) run, ${failures.length} failed`);
  console.log(
    `  summary — gamesChecked=${summary.gamesChecked} live=${summary.liveGamesProcessed} ` +
      `final=${summary.finalGamesProcessed} HRs=${summary.HRsInserted} ` +
      `dupes=${summary.duplicatesSkipped} ` +
      `weatherChecked=${summary.weatherChecked} weatherUpdated=${summary.weatherUpdated} ` +
      `gamesWithWeather=${summary.gamesWithWeather} dome=${summary.domeOrRoofGames} ` +
      `weatherErrors=${summary.weatherErrors} ` +
      `summaries=${summary.summariesRebuilt} snapCreated=${summary.snapshotsCreated} ` +
      `snapSkipped=${summary.snapshotsSkipped}`,
  );
  if (failures.length > 0) {
    for (const f of failures) console.log(`    ✗ ${f.step}: ${f.error}`);
  } else {
    console.log(`  All steps ok ✓`);
  }
  console.log(`████████████████████████████████████████████████████\n`);

  return {
    mode,
    today,
    yesterday,
    scheduleWindow: { start: schedStart, end: schedEnd },
    totalDurationMs,
    steps,
    failures,
    actualResults: {
      date: today,
      yesterday: yesterdayResult,
      today: todayResult,
    },
    summary,
    dateContext,
  };
}

function logProcessResult(r: ProcessDateResult) {
  console.log(
    `    games: ${r.finalGamesProcessed} final newly processed (${r.alreadyProcessed} already done), ` +
      `${r.liveGamesChecked} live checked, ${r.pendingPregame} pregame · ` +
      `${r.homeRunsInserted} new HR(s), ${r.duplicatesSkipped} dupe(s), ${r.pitcherStartsInserted} starter row(s)`,
  );
  if (r.latestHrCreatedAt) {
    console.log(`    latest HR created_at — ${r.latestHrCreatedAt}`);
  }
}

/**
 * End-of-run sanity dump: query hr_target_snapshots for today and tomorrow
 * and print exactly what landed in Supabase.
 */
async function logSnapshotDiagnostics(today: string, tomorrow: string): Promise<void> {
  console.log(`\n--- snapshot diagnostics (read-back from Supabase)`);
  for (const d of [today, tomorrow]) {
    try {
      const { data, error, count } = await supabaseAdmin
        .from('hr_target_snapshots')
        .select('snapshot_date, snapshot_type', { count: 'exact' })
        .eq('target_date', d)
        .order('snapshot_date', { ascending: false })
        .limit(1);
      if (error) {
        console.warn(`    [${d}] read-back FAILED: ${error.message}`);
        continue;
      }
      const rows = (data ?? []) as { snapshot_date: string; snapshot_type: string }[];
      if (rows.length === 0 || (count ?? 0) === 0) {
        console.log(`    [${d}] no snapshot rows in DB`);
        continue;
      }
      const newest = rows[0];
      console.log(
        `    [${d}] ${count} row(s) — snapshot_date=${newest.snapshot_date} ` +
          `snapshot_type=${newest.snapshot_type}`,
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`    [${d}] read-back threw: ${m}`);
    }
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      console.log(`    home_runs newest created_at: (unavailable)`);
    } else {
      console.log(`    home_runs newest created_at: ${(data as { created_at: string }).created_at}`);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`    home_runs read-back threw: ${m}`);
  }
}
