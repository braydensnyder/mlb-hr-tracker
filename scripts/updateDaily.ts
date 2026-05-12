/**
 * updateDaily — single orchestrator that runs all daily-update steps in
 * a safe, idempotent order. Designed to be triggered manually or by cron /
 * GitHub Actions on a cadence like 8am / 12pm / 3pm / 10pm.
 *
 * Three modes (all safe to re-run):
 *   - daily   — full pass; processes BOTH yesterday and today
 *   - morning — assumes yesterday's games are now final; processes yesterday only
 *   - night   — assumes today's games are wrapping up; processes today only
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

export type UpdateMode = 'daily' | 'morning' | 'night';

export interface StepLog {
  step: string;
  durationMs: number;
  ok: boolean;
  /** Either the function's return value (when ok) or the error message (when failed). */
  detail?: unknown;
}

export interface UpdateDailyResult {
  mode: UpdateMode;
  today: string;
  yesterday: string;
  scheduleWindow: { start: string; end: string };
  totalDurationMs: number;
  steps: StepLog[];
  failures: { step: string; error: string }[];
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
  // 2. Process completed games
  //    processDate is idempotent: it only touches games whose status is
  //    Final/Game Over/Completed Early and not already processed.
  // -------------------------------------------------------------
  console.log(`\n[2/4] Process completed games`);
  if (mode !== 'night') {
    await runStep(
      `processDate(yesterday=${yesterday})`,
      async () => {
        const r = await processDate(yesterday);
        logProcessResult(r);
        return r;
      },
      steps,
    );
  } else {
    console.log(`    (skipped — mode=night)`);
  }
  if (mode !== 'morning') {
    await runStep(
      `processDate(today=${today})`,
      async () => {
        const r = await processDate(today);
        logProcessResult(r);
        return r;
      },
      steps,
    );
  } else {
    console.log(`    (skipped — mode=morning)`);
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

  // -------------------------------------------------------------
  // 4. Snapshot HR Targets — persists Top-N rankings for TODAY and TOMORROW
  //    into hr_target_snapshots. Skip-if-exists by default so an early-
  //    morning snapshot is preserved when later same-day runs fire. Use
  //    `npm run snapshot:targets -- <date> --force` to deliberately
  //    overwrite. Non-fatal: failure here doesn't block summary rebuilds.
  // -------------------------------------------------------------
  console.log(`\n[4/5] Snapshot HR Targets (today + tomorrow, pre-game-only, skip-if-exists)`);
  const tomorrow = addDays(today, 1);
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
  // Wrap-up
  // -------------------------------------------------------------
  const totalDurationMs = Date.now() - t0;
  const failures = steps
    .filter((s) => !s.ok)
    .map((s) => ({ step: s.step, error: String(s.detail) }));

  console.log(`\n████████████████████████████████████████████████████`);
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
  };
}

function logProcessResult(r: ProcessDateResult) {
  console.log(
    `    games: ${r.processedGames}/${r.totalGames} processed, ` +
      `${r.homeRunsInserted} HRs, ${r.pitcherStartsInserted} starter row(s)`,
  );
}
