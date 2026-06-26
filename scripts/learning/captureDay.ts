/**
 * captureDay — close the feedback loop for a completed date.
 *
 * For the chosen target_date:
 *   1. Loads the saved snapshot (the model's pre-game judgment).
 *   2. Loads actual HRs for that game_date.
 *   3. Loads saved odds for that target_date.
 *   4. Re-runs the parlay generator with the SAME live rules — same code,
 *      same constants. Records which players ended up in Safe / Value / Chaos.
 *   5. For every snapshot row, writes one learning_predictions record
 *      (pre-game signals, rank, heat, model_prob, parlay membership,
 *      outcome, classification).
 *   6. Computes feature_importance over rolling 7d / 14d / 30d windows.
 *   7. Refreshes the active model_version's roll-up metrics.
 *
 * Logging — verbose by default. Each stage prints a [captureDay] line so
 * you can see what landed and where. After every write we COUNT to
 * verify the rows are actually in Supabase, not just upsert-acknowledged.
 *
 * Usage:
 *   npm run learning:capture                       # yesterday (Pacific)
 *   npm run learning:capture -- 2026-05-10
 *   npm run learning:capture -- yesterday
 *   npm run learning:capture -- --window 30        # also refresh 30d importance
 */
import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';
import {
  buildLearningPredictionRecord,
  computeFeatureImportance,
  generateParlays,
  snapshotToParlayCandidate,
  type LearningRowForImportance,
  type RevAnalysisSnapshotRow,
} from '../../src/lib/stats.js';

// Local mirror of signal labels so this script doesn't depend on
// stats.ts's internal naming choices. Keep in sync if stats.ts adds
// new signal kinds.
const SIGNAL_LABEL: Record<string, string> = {
  hr_pitcher: 'HR Pitcher',
  power_park: 'Power Park',
  wind_out: 'Wind Out',
  wind_in: 'Wind In',
  warm_weather: 'Warm Weather',
  hot_l7d: 'Hot Last 7d',
  hr_streak: 'HR Streak',
  platoon_edge: 'Platoon Edge',
  elite_power: 'Elite Power',
  mid_power: 'Mid Power',
  low_season_power: 'Low Season Power',
  cold_batter: 'Cold Batter',
  pitcher_dominant: 'Dominant Pitcher',
};

const todayISO = mlbToday;
const addDays = mlbAddDays;

interface Args {
  date: string;
  importanceWindows: number[];
}
function parseArgs(argv: string[]): Args {
  const out: Args = { date: addDays(todayISO(), -1), importanceWindows: [7, 14, 30] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'today') out.date = todayISO();
    else if (a === 'yesterday') out.date = addDays(todayISO(), -1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) out.date = a;
    else if (a === '--window') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.importanceWindows = [v];
    } else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    else throw new Error(`Unexpected arg: ${a}`);
  }
  return out;
}

interface GameLite {
  game_pk: number;
  home_team: string;
  away_team: string;
}
interface HrRowLite {
  game_pk: number;
  game_date: string;
  player_id: number;
  player_name: string;
  team: string;
  opponent: string;
}

// --- pretty logger ---
function log(msg: string) {
  console.log(`[captureDay] ${msg}`);
}
function logStep(n: string, msg: string) {
  console.log(`[captureDay] ${n} ${msg}`);
}
function logOk(msg: string) {
  console.log(`[captureDay] ✓ ${msg}`);
}
function logWarn(msg: string) {
  console.warn(`[captureDay] ⚠ ${msg}`);
}
function logErr(msg: string) {
  console.error(`[captureDay] ✗ ${msg}`);
}

async function loadActiveModelVersion(): Promise<{ version: number; name: string }> {
  logStep('1)', 'Loading active model_version…');
  const { data, error } = await supabaseAdmin
    .from('model_versions')
    .select('version, name')
    .eq('active', true)
    .order('version', { ascending: false })
    .limit(1);
  if (error) {
    if (/relation .* does not exist|does not exist|schema cache/i.test(error.message)) {
      throw new Error(
        'model_versions table is missing. Apply supabase/migrations/013_learning_engine.sql in the Supabase SQL editor first.'
      );
    }
    throw new Error(`model_versions: ${error.message}`);
  }
  const row = (data ?? [])[0] as { version: number; name: string } | undefined;
  if (!row) {
    throw new Error(
      'No active model_version row found. The migration should seed v1 automatically; check the seed INSERT in 013_learning_engine.sql.'
    );
  }
  logOk(`active version: v${row.version} (${row.name})`);
  return row;
}

async function loadSnapshots(date: string): Promise<RevAnalysisSnapshotRow[]> {
  logStep('2)', `Loading snapshots for ${date}…`);
  const all: RevAnalysisSnapshotRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('hr_target_snapshots')
      .select('target_date, player_id, player_name, team, rank, heat_score, reason')
      .eq('target_date', date)
      .order('rank', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`snapshots fetch: ${error.message}`);
    const rows = (data ?? []) as RevAnalysisSnapshotRow[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  logOk(`snapshots loaded: ${all.length} rows`);
  if (all.length === 0) {
    throw new Error(
      `No snapshot rows for ${date}. Did snapshot:targets run for that date? ` +
        `Try: npm run snapshot:targets -- ${date} --force`
    );
  }
  return all;
}

async function loadGames(date: string): Promise<GameLite[]> {
  logStep('3)', `Loading games for ${date}…`);
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_pk, home_team, away_team')
    .eq('game_date', date);
  if (error) throw new Error(`games fetch: ${error.message}`);
  const rows = (data ?? []) as GameLite[];
  logOk(`games loaded: ${rows.length}`);
  return rows;
}

async function loadHrs(date: string): Promise<HrRowLite[]> {
  logStep('4)', `Loading home_runs for ${date}…`);
  const all: HrRowLite[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('game_pk, game_date, player_id, player_name, team, opponent')
      .eq('game_date', date)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`home_runs fetch: ${error.message}`);
    const rows = (data ?? []) as HrRowLite[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  logOk(`home_runs loaded: ${all.length} rows`);
  return all;
}

async function loadOdds(date: string): Promise<Map<number, number>> {
  logStep('5)', `Loading odds for ${date}…`);
  const out = new Map<number, number>();
  const { data, error } = await supabaseAdmin
    .from('odds_snapshots')
    .select('player_id, american_odds, snapshot_time')
    .eq('target_date', date)
    .order('snapshot_time', { ascending: true });
  if (error) {
    if (/odds_snapshots/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      logWarn('odds_snapshots table missing — continuing without odds (model_prob still computed)');
      return out;
    }
    throw new Error(`odds fetch: ${error.message}`);
  }
  for (const r of (data ?? []) as { player_id: number | null; american_odds: number }[]) {
    if (r.player_id == null) continue;
    out.set(r.player_id, r.american_odds);
  }
  logOk(`odds loaded: ${out.size} player-day entries`);
  return out;
}

async function loadLearningRowsFor(
  date: string,
  modelVersion: number,
  lookbackDays: number,
): Promise<LearningRowForImportance[]> {
  const from = addDays(date, -(lookbackDays - 1));
  const all: LearningRowForImportance[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAdmin
      .from('learning_predictions')
      .select('signals_json, homered')
      .eq('model_version', modelVersion)
      .gte('target_date', from)
      .lte('target_date', date)
      .not('homered', 'is', null)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`learning_predictions read: ${error.message}`);
    const rows = (data ?? []) as { signals_json: Record<string, boolean>; homered: boolean | null }[];
    for (const r of rows) {
      if (r.homered == null) continue;
      all.push({ signals_json: r.signals_json ?? {}, homered: !!r.homered });
    }
    if (rows.length < 1000) break;
  }
  return all;
}

interface CaptureResult {
  date: string;
  model_version: number;
  predictions_written: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  unranked_hr_hitters: number;
  importance_rows_written: number;
  importance_by_window: { window_days: number; rows: number }[];
  /** Pre-write count of rows for this (date, version), post-write count, delta. */
  predictions_verified: { before: number; after: number };
  feature_importance_verified: number;
}

export async function captureDay(date: string, importanceWindows: number[]): Promise<CaptureResult> {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`START — date=${date} windows=${importanceWindows.join(',')}`);
  log(`Supabase URL (admin): ${process.env.SUPABASE_URL ? '✓ set' : '✗ MISSING'}`);
  log(`Supabase service key: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ set' : '✗ MISSING'}`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ---- 1) Active model version ----
  const mv = await loadActiveModelVersion();

  // ---- 2-5) Load source data ----
  const [snapshots, games, hrs, odds] = await Promise.all([
    loadSnapshots(date),
    loadGames(date),
    loadHrs(date),
    loadOdds(date),
  ]);

  // ---- Pre-write count ----
  logStep('6)', 'Counting existing learning_predictions for this (date, version)…');
  const { count: preCount, error: preCountErr } = await supabaseAdmin
    .from('learning_predictions')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', mv.version);
  if (preCountErr) {
    if (/relation .* does not exist|does not exist|schema cache/i.test(preCountErr.message)) {
      throw new Error(
        'learning_predictions table is missing. Apply supabase/migrations/013_learning_engine.sql first.'
      );
    }
    throw new Error(`pre-count: ${preCountErr.message}`);
  }
  log(`pre-count: ${preCount ?? 0} existing rows (will be overwritten by upsert)`);

  // ---- 7) Build HR outcome index ----
  logStep('7)', 'Indexing HR outcomes…');
  const hrCountByPlayer = new Map<number, number>();
  const opponentByPlayer = new Map<number, string>();
  const gamePkByPlayer = new Map<number, number>();
  for (const hr of hrs) {
    hrCountByPlayer.set(hr.player_id, (hrCountByPlayer.get(hr.player_id) ?? 0) + 1);
    opponentByPlayer.set(hr.player_id, hr.opponent);
    gamePkByPlayer.set(hr.player_id, hr.game_pk);
  }
  logOk(`distinct HR hitters: ${hrCountByPlayer.size}`);

  const gameByTeam = new Map<string, GameLite>();
  for (const g of games) {
    gameByTeam.set(g.home_team, g);
    gameByTeam.set(g.away_team, g);
  }
  function lookupOpponentAndPk(team: string): { opponent: string | null; game_pk: number | null } {
    const g = gameByTeam.get(team);
    if (!g) return { opponent: null, game_pk: null };
    return {
      opponent: g.home_team === team ? g.away_team : g.home_team,
      game_pk: g.game_pk,
    };
  }

  // ---- 8) Re-run parlay generator ----
  logStep('8)', 'Re-running parlay generator with current live rules…');
  const candidates = snapshots.map((snap) =>
    snapshotToParlayCandidate(snap, odds.get(snap.player_id) ?? null),
  );
  const { safe, value, chaos } = generateParlays(candidates);
  log(`  Safe:  ${safe.legs.length}/3 legs ${safe.incomplete ? '(incomplete)' : ''}`);
  log(`  Value: ${value.legs.length}/3 legs ${value.incomplete ? '(incomplete)' : ''}`);
  log(`  Chaos: ${chaos.legs.length}/3 legs ${chaos.incomplete ? '(incomplete)' : ''}`);
  const inSafe = new Set(safe.legs.map((l) => l.player_id));
  const inValue = new Set(value.legs.map((l) => l.player_id));
  const inChaos = new Set(chaos.legs.map((l) => l.player_id));

  // ---- 9) Build learning records ----
  logStep('9)', 'Building learning_predictions records…');
  const records = snapshots.map((snap) => {
    const homered = hrCountByPlayer.has(snap.player_id);
    const hrCount = hrCountByPlayer.get(snap.player_id) ?? 0;
    const fallback = lookupOpponentAndPk(snap.team ?? '');
    return buildLearningPredictionRecord({
      snapshot: snap,
      model_version: mv.version,
      opponent: opponentByPlayer.get(snap.player_id) ?? fallback.opponent,
      game_pk: gamePkByPlayer.get(snap.player_id) ?? fallback.game_pk,
      in_safe: inSafe.has(snap.player_id),
      in_value: inValue.has(snap.player_id),
      in_chaos: inChaos.has(snap.player_id),
      homered,
      hr_count: hrCount,
    });
  });

  // Phantom FN rows — HR hitters NOT in snapshot (the pool gap)
  const inSnapshotIds = new Set(snapshots.map((s) => s.player_id));
  let phantomCount = 0;
  for (const [pid, count] of hrCountByPlayer) {
    if (inSnapshotIds.has(pid)) continue;
    const hrRow = hrs.find((r) => r.player_id === pid)!;
    records.push({
      target_date: date,
      player_id: pid,
      model_version: mv.version,
      player_name: hrRow.player_name,
      team: hrRow.team,
      opponent: hrRow.opponent,
      game_pk: hrRow.game_pk,
      rank: null,
      heat_score: null,
      model_prob: null,
      reason: null,
      signals_json: {},
      in_safe: false,
      in_value: false,
      in_chaos: false,
      homered: true,
      hr_count: count,
      classification: 'FN' as const,
    });
    phantomCount++;
  }
  log(`  built ${records.length} records (${snapshots.length} from snapshot + ${phantomCount} phantom FN rows)`);

  // ---- 10) Tally classifications ----
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of records) {
    if (r.classification === 'TP') tp++;
    else if (r.classification === 'FP') fp++;
    else if (r.classification === 'FN') fn++;
    else if (r.classification === 'TN') tn++;
  }
  log(`  classification: TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);

  // ---- 11) Upsert learning_predictions ----
  logStep('10)', `Upserting ${records.length} learning_predictions rows…`);
  const nowIso = new Date().toISOString();
  const upsertRows = records.map((r) => ({ ...r, captured_at: nowIso }));

  // Batch upsert in chunks of 500 to keep request bodies modest.
  const BATCH = 500;
  let totalUpserted = 0;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const chunk = upsertRows.slice(i, i + BATCH);
    const { error: upsertErr, count } = await supabaseAdmin
      .from('learning_predictions')
      .upsert(chunk, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
    if (upsertErr) throw new Error(`learning_predictions upsert (batch ${i / BATCH}): ${upsertErr.message}`);
    totalUpserted += count ?? chunk.length;
    log(`  upsert batch ${Math.floor(i / BATCH) + 1}: ${chunk.length} rows acknowledged`);
  }
  logOk(`learning_predictions upserts acknowledged: ${totalUpserted}`);

  // ---- 12) VERIFY by re-counting ----
  logStep('11)', 'Verifying learning_predictions persisted…');
  const { count: postCount, error: postCountErr } = await supabaseAdmin
    .from('learning_predictions')
    .select('id', { count: 'exact', head: true })
    .eq('target_date', date)
    .eq('model_version', mv.version);
  if (postCountErr) throw new Error(`post-count: ${postCountErr.message}`);
  log(`  post-count: ${postCount ?? 0} rows in DB for (${date}, v${mv.version})`);
  if ((postCount ?? 0) < records.length) {
    logWarn(
      `Expected at least ${records.length} rows but DB has ${postCount}. ` +
        'Possible RLS issue — check that the service-role key has insert privileges and that ' +
        'allow_anon_read policy is enabled.',
    );
  } else {
    logOk(`verified: DB contains ${postCount} rows for this (date, version)`);
  }

  // ---- 13) Refresh feature_importance ----
  logStep('12)', `Refreshing feature_importance for windows ${importanceWindows.join(', ')}…`);
  let importanceWritten = 0;
  const importanceByWindow: { window_days: number; rows: number }[] = [];
  for (const winDays of importanceWindows) {
    const rows = await loadLearningRowsFor(date, mv.version, winDays);
    log(`  ${winDays}d window: ${rows.length} player-days in learning_predictions`);
    if (rows.length === 0) {
      log(`  ${winDays}d window: skipped (no learning rows yet — backfill more days first)`);
      importanceByWindow.push({ window_days: winDays, rows: 0 });
      continue;
    }
    const imp = computeFeatureImportance(rows, date, winDays);
    const fiRows = imp.rows.map((r) => ({
      model_version: mv.version,
      window_days: winDays,
      computed_for: date,
      signal_key: r.signal_key,
      signal_label: SIGNAL_LABEL[r.signal_key] ?? r.signal_label,
      n_present: r.n_present,
      hits_present: r.hits_present,
      rate_present: r.rate_present,
      n_absent: r.n_absent,
      hits_absent: r.hits_absent,
      rate_absent: r.rate_absent,
      lift: r.lift,
      importance_score: r.importance_score,
      sample_quality: r.sample_quality,
    }));
    const { error: fiErr } = await supabaseAdmin
      .from('feature_importance')
      .upsert(fiRows, { onConflict: 'model_version,window_days,computed_for,signal_key' });
    if (fiErr) throw new Error(`feature_importance upsert (${winDays}d): ${fiErr.message}`);
    log(`  ${winDays}d window: wrote ${fiRows.length} feature_importance rows`);
    importanceWritten += fiRows.length;
    importanceByWindow.push({ window_days: winDays, rows: fiRows.length });
  }
  logOk(`feature_importance refreshed: ${importanceWritten} total rows across windows`);

  // ---- 14) Verify feature_importance for this anchor ----
  logStep('13)', 'Verifying feature_importance persisted for this anchor…');
  const { count: fiCount, error: fiCountErr } = await supabaseAdmin
    .from('feature_importance')
    .select('id', { count: 'exact', head: true })
    .eq('model_version', mv.version)
    .eq('computed_for', date);
  if (fiCountErr) {
    logWarn(`feature_importance count check failed: ${fiCountErr.message}`);
  } else {
    log(`  post-count: ${fiCount ?? 0} feature_importance rows for (v${mv.version}, computed_for=${date})`);
  }

  // ---- 15) Refresh model_versions roll-up ----
  logStep('14)', 'Refreshing model_versions roll-up metrics…');
  const totalParlayLegs =
    (safe.incomplete ? 0 : 3) + (value.incomplete ? 0 : 3) + (chaos.incomplete ? 0 : 3);
  let legsHit = 0;
  for (const leg of [...safe.legs, ...value.legs, ...chaos.legs]) {
    if (hrCountByPlayer.has(leg.player_id)) legsHit++;
  }
  const top10Ids = new Set(snapshots.filter((s) => s.rank <= 10).map((s) => s.player_id));
  const poolIds = new Set(snapshots.map((s) => s.player_id));
  let inTop10 = 0,
    inPool = 0;
  for (const pid of hrCountByPlayer.keys()) {
    if (top10Ids.has(pid)) inTop10++;
    if (poolIds.has(pid)) inPool++;
  }
  const totalHr = hrCountByPlayer.size;
  const { error: mvErr } = await supabaseAdmin
    .from('model_versions')
    .update({
      last_evaluated_for: date,
      per_leg_hit_rate: totalParlayLegs > 0 ? legsHit / totalParlayLegs : null,
      pool_coverage_rate: totalHr > 0 ? inPool / totalHr : null,
      top10_coverage_rate: totalHr > 0 ? inTop10 / totalHr : null,
    })
    .eq('version', mv.version);
  if (mvErr) logWarn(`model_versions update: ${mvErr.message}`);
  else logOk(`model_versions v${mv.version} roll-up updated`);

  // ---- DONE ----
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`✅ SUCCESS — ${date} captured`);
  log(`   model_version       = v${mv.version}`);
  log(`   snapshot rows       = ${snapshots.length}`);
  log(`   distinct HR hitters = ${hrCountByPlayer.size}`);
  log(`   phantom FN rows     = ${phantomCount}`);
  log(`   predictions written = ${totalUpserted} (DB now has ${postCount ?? '?'} for this date+version)`);
  log(`   classification      = TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  log(`   importance written  = ${importanceWritten} rows`);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return {
    date,
    model_version: mv.version,
    predictions_written: totalUpserted,
    tp,
    fp,
    fn,
    tn,
    unranked_hr_hitters: phantomCount,
    importance_rows_written: importanceWritten,
    importance_by_window: importanceByWindow,
    predictions_verified: { before: preCount ?? 0, after: postCount ?? 0 },
    feature_importance_verified: fiCount ?? 0,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await captureDay(args.date, args.importanceWindows);
    console.log('[captureDay] result JSON:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    logErr(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

// Always run main when this file is the CLI entry. The previous version
// gated on `import.meta.url === \`file://\${process.argv[1]}\`` which
// silently failed for paths with spaces (URL-encoded vs raw mismatch).
// Since this script has no programmatic importers, just always run it.
main();
