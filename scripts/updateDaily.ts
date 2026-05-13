/**
 * updateDaily — single orchestrator that runs all daily-update steps in
 * a safe, idempotent order. Designed to be triggered manually or by cron /
 * GitHub Actions on a cadence like 8am / 12pm / 3pm / 10pm.
 *
 * Three modes (all safe to re-run):
 *   - daily   — full pass; processes BOTH yesterday and today
 *   - morning — pregame baseline; processes yesterday's finals + FORCE-rebuilds
 *               today's snapshot (clean baseline for the day)
 *   - live    — midday refresh; processes today only; preserves the morning
 *               baseline snapshot (NO snapshot writes)
 *   - night   — postgame finalization; processes today only + FORCE-updates
 *               today's snapshot with final post-game model output
 *
 * Pipeline (each step is isolated — a failure in one doesn't kill the run):
 *
 *   1. Schedules — refresh probable pitchers + venue for [yesterday, today+3]
 *       via enrich:schedule. NEVER overwrites existing probables with null
 *       (see upsertGameRows in lib/games.ts).
 *   2. Process completed games — processDate(yesterday) and/or processDate(today).
 *       Only finalized + un-processed games get HR + pitcher-start extraction.
 *   3. Enrich — probable-pitcher live-feed fallback, handedness, venues,
 *       pitcher-starts (last 14 days), players (capped per run so we don't
 *       hammer /v1/people).
 *   4. Rebuild summaries — rebuildPlayerSummaries for yesterday and today so
 *       the player_daily_summary cache stays current for any future consumer.
 *       The frontend itself reads from raw home_runs / pitcher_starts and
 *       picks up changes automatically on next page load.
 *
 * No data is ever deleted. HR rows are deduped by event_key. Game rows
 * are upserted with null-safe semantics. Cache tables can be wiped + rebuilt
 * only via the explicit `rebuild:all` command, which this orchestrator
 * never invokes.
 */
import { enrichSchedule } from './enrichSchedule.js';
import { processDate, type ProcessDateResult } from './processDate.js';
import { enrichProbablePitchers } from './enrichProbablePitchers.js';
import { enrichHandedness } from './enrichHandedness.js';
import { enrichVenues } from './enrichVenues.js';
import { enrichPitcherStarts } from './enrichPitcherStarts.js';
import { enrichPlayers } from './enrichPlayers.js';
import { rebuildPlayerSummaries } from './rebuildPlayerSummaries.js';
import { snapshotHrTargets } from './snapshotHrTargets.js';
import { supabaseAdmin } from './lib/supabaseAdmin.js';

export type UpdateMode = 'daily' | 'morning' | 'live' | 'night';

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
  /** Snapshot of the date this summary represents (today's actuals). */
  date: string;
  /** Same metrics for yesterday — useful when the user opens the
   *  Dashboard in the morning. null when yesterday wasn't processed. */
  yesterday: ProcessDateResult | null;
  /** Today's metrics. null when today wasn't processed (e.g. mode=morning). */
  today: ProcessDateResult | null;
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
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

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

export async function updateDaily(mode: UpdateMode = 'daily'): Promise<UpdateDailyResult> {
  const t0 = Date.now();
  const today = todayISO();
  const yesterday = addDays(today, -1);
  const plus3 = addDays(today, 3);

  console.log(`\n████████████████████████████████████████████████████`);
  console.log(`  HR Tracker — update:${mode}`);
  console.log(`  today=${today}  yesterday=${yesterday}  schedule window=${yesterday} → ${plus3}`);
  console.log(`████████████████████████████████████████████████████`);

  const steps: StepLog[] = [];

  // -------------------------------------------------------------
  // 1. Pull schedules
  // -------------------------------------------------------------
  console.log(`\n[1/4] Pull schedules (${yesterday} → ${plus3})`);
  await runStep(
    `enrich:schedule ${yesterday} → ${plus3}`,
    () => enrichSchedule({ start: yesterday, end: plus3 }),
    steps,
  );

  // -------------------------------------------------------------
  // 2. Process games — BOTH live + final.
  //    processDate is idempotent: completed games marked processed are
  //    skipped on subsequent runs; live games are re-checked every run
  //    and event_key dedup prevents duplicate HRs.
  // -------------------------------------------------------------
  console.log(`\n[2/4] Process games (live + final)`);
  let yesterdayResult: ProcessDateResult | null = null;
  let todayResult: ProcessDateResult | null = null;
  // yesterday's HR rows are needed for morning baselines + the full-pass daily
  // mode. Skip on live (mid-day) and night (yesterday is already final from
  // the morning run).
  if (mode === 'daily' || mode === 'morning') {
    yesterdayResult = await runStep(
      `processDate(yesterday=${yesterday})`,
      async () => {
        const r = await processDate(yesterday);
        logProcessResult(r);
        return r;
      },
      steps,
    );
  } else {
    console.log(`    (yesterday skipped — mode=${mode})`);
  }
  // today's HR rows are needed any time we expect games to be in-progress
  // or wrapping. Morning skips because games haven't happened yet.
  if (mode !== 'morning') {
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
    console.log(`    (today skipped — mode=morning, games not yet played)`);
  }

  // -------------------------------------------------------------
  // 3. Enrich data
  //    Each step is isolated and idempotent. Limits keep each cron tick
  //    short and polite to the public MLB API.
  // -------------------------------------------------------------
  console.log(`\n[3/4] Enrich data`);
  await runStep(
    `enrich:probable-pitchers ${yesterday} → ${plus3}`,
    () => enrichProbablePitchers({ start: yesterday, end: plus3 }),
    steps,
  );
  await runStep(
    `enrich:handedness (limit 100)`,
    () => enrichHandedness({ limit: 100 }),
    steps,
  );
  await runStep(
    `enrich:venues (limit 30)`,
    () => enrichVenues({ limit: 30 }),
    steps,
  );
  await runStep(
    `enrich:pitcher-starts (${addDays(today, -14)} → ${today})`,
    () => enrichPitcherStarts({ start: addDays(today, -14), end: today }),
    steps,
  );
  // Players: a heavier /v1/people loop. Skip on night runs to keep them fast.
  if (mode !== 'night') {
    await runStep(
      `enrich:players (limit 100, refresh ≥7d)`,
      () => enrichPlayers({ limit: 100, refreshDays: 7 }),
      steps,
    );
  } else {
    console.log(`    (skipping enrich:players on night mode)`);
  }

  // Marker phrase the operator can grep for. After phase 3 the underlying
  // tables (games, pitcher_starts, players, venues) that the HR Targets
  // "Live Preview" view reads from have been freshened. The saved snapshot
  // — phase 4 below — remains untouched unless --force is supplied.
  console.log(`    live preview updated — underlying data refreshed (saved snapshot untouched)`);

  // -------------------------------------------------------------
  // 4. Snapshot HR Targets — mode-aware lifecycle.
  //
  //    morning → FORCE rebuild today's snapshot. Clean pregame baseline.
  //              Tomorrow: skip-if-exists, pre-game-only (don't overwrite
  //              a tomorrow-baseline that a prior night/daily run already laid down).
  //    live    → NO-OP. Preserve the morning baseline so the dashboard's
  //              Saved-Snapshot view stays stable through the day. Live
  //              Preview on the UI still updates because the underlying
  //              data (games, pitcher_starts, players) was just refreshed
  //              in phase 3.
  //    night   → FORCE update today's snapshot with the post-game-final
  //              model output (useful for Backtest accuracy + late-night
  //              comparison). Tomorrow: skip-if-exists, pre-game-only.
  //    daily   → legacy generic full-pass. Skip-if-exists, pre-game-only
  //              for both dates. Used by manual `npm run update:daily`.
  //
  //    Non-fatal: failure here doesn't block summary rebuilds.
  // -------------------------------------------------------------
  const tomorrow = addDays(today, 1);
  console.log(`\n[4/5] Snapshot HR Targets — mode=${mode}`);

  if (mode === 'morning') {
    console.log(`    morning baseline — FORCE rebuild today, skip-if-exists tomorrow`);
    await runStep(
      `snapshot:hr-targets(${today}) [force=true mode=morning]`,
      () => snapshotHrTargets(today, { force: true, skipIfGamesStarted: false }),
      steps,
    );
    await runStep(
      `snapshot:hr-targets(${tomorrow})`,
      () => snapshotHrTargets(tomorrow, { force: false, skipIfGamesStarted: true }),
      steps,
    );
  } else if (mode === 'live') {
    console.log(
      `    live mode — preserving morning baseline (no snapshot writes). ` +
        `Live Preview on /targets still reflects the refreshed underlying data.`,
    );
    steps.push({
      step: `snapshot:hr-targets — skipped (mode=live, preserving baseline)`,
      durationMs: 0,
      ok: true,
      detail: { skipped: true, reason: 'live mode preserves morning baseline' },
    });
  } else if (mode === 'night') {
    console.log(`    night finalization — FORCE update today, skip-if-exists tomorrow`);
    await runStep(
      `snapshot:hr-targets(${today}) [force=true mode=night]`,
      () => snapshotHrTargets(today, { force: true, skipIfGamesStarted: false }),
      steps,
    );
    await runStep(
      `snapshot:hr-targets(${tomorrow})`,
      () => snapshotHrTargets(tomorrow, { force: false, skipIfGamesStarted: true }),
      steps,
    );
  } else {
    // 'daily' — legacy full-pass behavior. Idempotent, pre-game-only.
    console.log(`    daily full-pass — skip-if-exists + pre-game-only for both dates`);
    await runStep(
      `snapshot:hr-targets(${today})`,
      () => snapshotHrTargets(today, { force: false, skipIfGamesStarted: true }),
      steps,
    );
    await runStep(
      `snapshot:hr-targets(${tomorrow})`,
      () => snapshotHrTargets(tomorrow, { force: false, skipIfGamesStarted: true }),
      steps,
    );
  }

  // -------------------------------------------------------------
  // 5. Rebuild summaries
  //    The frontend reads from raw home_runs / pitcher_starts so it always
  //    sees fresh data. player_daily_summary is a server-side cache for
  //    future consumers (digests, alerts) — refresh for today + yesterday.
  // -------------------------------------------------------------
  console.log(`\n[5/5] Rebuild summaries`);
  await runStep(
    `rebuildPlayerSummaries(${yesterday})`,
    () => rebuildPlayerSummaries(yesterday),
    steps,
  );
  await runStep(
    `rebuildPlayerSummaries(${today})`,
    () => rebuildPlayerSummaries(today),
    steps,
  );

  // -------------------------------------------------------------
  // Diagnostic — read back what actually landed in Supabase so the operator
  // can confirm whether snapshots were created, skipped, or never written.
  // -------------------------------------------------------------
  await logSnapshotDiagnostics(today, tomorrow);

  // -------------------------------------------------------------
  // Wrap-up
  // -------------------------------------------------------------
  const totalDurationMs = Date.now() - t0;
  const failures = steps
    .filter((s) => !s.ok)
    .map((s) => ({ step: s.step, error: String(s.detail) }));

  console.log(`\n████████████████████████████████████████████████████`);
  console.log(`  active mode: ${mode}`);
  console.log(`  update:${mode} complete in ${(totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  ${steps.length} step(s) run, ${failures.length} failed`);
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
    scheduleWindow: { start: yesterday, end: plus3 },
    totalDurationMs,
    steps,
    failures,
    actualResults: {
      date: today,
      yesterday: yesterdayResult,
      today: todayResult,
    },
  };
}

function logProcessResult(r: ProcessDateResult) {
  console.log(
    `    games: ${r.finalGamesProcessed} final newly processed (${r.alreadyProcessed} already done), ` +
      `${r.liveGamesChecked} live checked, ${r.pendingPregame} pregame · ` +
      `${r.homeRunsInserted} new HR(s), ${r.pitcherStartsInserted} starter row(s)`,
  );
  if (r.latestHrCreatedAt) {
    console.log(`    latest HR created_at — ${r.latestHrCreatedAt}`);
  }
}

/**
 * End-of-run sanity dump: query hr_target_snapshots for today and tomorrow
 * and print exactly what landed in Supabase. Gives the operator proof-
 * positive that an update:daily run either created a snapshot or
 * deliberately skipped one — instead of having to guess from earlier logs.
 * Also reads the freshest home_runs.created_at as "Data last updated."
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
