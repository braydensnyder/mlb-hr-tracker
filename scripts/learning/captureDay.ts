/**
 * captureDay — close the feedback loop for a completed date.
 *
 * For the chosen target_date:
 *   1. Loads the saved snapshot (the model's pre-game judgment).
 *   2. Loads actual HRs for that game_date.
 *   3. Loads saved odds for that target_date.
 *   4. Re-runs the parlay generator with the SAME live rules — same code,
 *      same constants. Records which players ended up in Safe / Value / Chaos.
 *   5. For every snapshot row, writes one learning_predictions record:
 *        - pre-game signals (signals_json)
 *        - rank + heat + model_prob
 *        - parlay membership (in_safe/value/chaos)
 *        - outcome (homered, hr_count)
 *        - classification (TP/FP/FN/TN)
 *   6. Computes feature_importance over (target_date - window..target_date)
 *      and inserts/upserts rows for 7d/14d/30d windows.
 *   7. Refreshes the active model_version's roll-up metrics.
 *
 * Idempotent: uses upsert on (target_date, player_id, model_version) so
 * re-running is safe. --force is implicit because upsert overwrites the
 * outcome side; the pre-game state is also re-derived from the snapshot
 * (which itself is immutable once written).
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
// stats.ts's internal naming choices. Keep in sync if stats.ts adds new
// signal kinds.
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

async function loadActiveModelVersion(): Promise<{ version: number; name: string }> {
  const { data, error } = await supabaseAdmin
    .from('model_versions')
    .select('version, name')
    .eq('active', true)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw new Error(`model_versions: ${error.message}`);
  const row = (data ?? [])[0] as { version: number; name: string } | undefined;
  if (!row) throw new Error('No active model_version row found. Apply migration 013 first.');
  return row;
}

async function loadSnapshots(date: string): Promise<RevAnalysisSnapshotRow[]> {
  const all: RevAnalysisSnapshotRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('hr_target_snapshots')
      .select('target_date, player_id, player_name, team, rank, heat_score, reason')
      .eq('target_date', date)
      .order('rank', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`snapshots: ${error.message}`);
    const rows = (data ?? []) as RevAnalysisSnapshotRow[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function loadGames(date: string): Promise<GameLite[]> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_pk, home_team, away_team')
    .eq('game_date', date);
  if (error) throw new Error(`games: ${error.message}`);
  return (data ?? []) as GameLite[];
}

async function loadHrs(date: string): Promise<HrRowLite[]> {
  const all: HrRowLite[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('game_pk, game_date, player_id, player_name, team, opponent')
      .eq('game_date', date)
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`home_runs: ${error.message}`);
    const rows = (data ?? []) as HrRowLite[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function loadOdds(date: string): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const { data, error } = await supabaseAdmin
    .from('odds_snapshots')
    .select('player_id, american_odds, snapshot_time')
    .eq('target_date', date)
    .order('snapshot_time', { ascending: true });
  if (error) {
    if (/odds_snapshots/i.test(error.message) && /does not exist/i.test(error.message)) return out;
    throw new Error(`odds: ${error.message}`);
  }
  for (const r of (data ?? []) as { player_id: number | null; american_odds: number }[]) {
    if (r.player_id == null) continue;
    out.set(r.player_id, r.american_odds); // latest wins
  }
  return out;
}

async function loadLearningRowsFor(date: string, modelVersion: number, lookbackDays: number): Promise<LearningRowForImportance[]> {
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
  tp: number; fp: number; fn: number; tn: number;
  unranked_hr_hitters: number;
  importance_rows_written: number;
}

export async function captureDay(date: string, importanceWindows: number[]): Promise<CaptureResult> {
  // 1. Load active model + the day's data
  const mv = await loadActiveModelVersion();
  const [snapshots, games, hrs, odds] = await Promise.all([
    loadSnapshots(date), loadGames(date), loadHrs(date), loadOdds(date),
  ]);
  console.log(`[captureDay] ${date} — model v${mv.version} (${mv.name}). snapshots=${snapshots.length}, games=${games.length}, hrs=${hrs.length}, odds=${odds.size}`);

  if (snapshots.length === 0) {
    throw new Error(`No snapshot rows for ${date}. Run snapshot:targets first.`);
  }

  // 2. Build HR outcome index per (date, player_id) and per-player opponent
  const hrCountByPlayer = new Map<number, number>();
  const opponentByPlayer = new Map<number, string>();
  const gamePkByPlayer = new Map<number, number>();
  for (const hr of hrs) {
    hrCountByPlayer.set(hr.player_id, (hrCountByPlayer.get(hr.player_id) ?? 0) + 1);
    opponentByPlayer.set(hr.player_id, hr.opponent);
    gamePkByPlayer.set(hr.player_id, hr.game_pk);
  }

  // Game lookup by team — for snapshot rows that aren't HR hitters but need
  // opponent/game_pk for completeness.
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

  // 3. Re-run parlay generator with current live rules
  const candidates = snapshots.map((snap) => snapshotToParlayCandidate(snap, odds.get(snap.player_id) ?? null));
  const { safe, value, chaos } = generateParlays(candidates);
  const inSafe = new Set(safe.legs.map((l) => l.player_id));
  const inValue = new Set(value.legs.map((l) => l.player_id));
  const inChaos = new Set(chaos.legs.map((l) => l.player_id));

  // 4. Build learning_predictions records — one per snapshot row.
  const records = snapshots.map((snap) => {
    const homered = hrCountByPlayer.has(snap.player_id);
    const hrCount = hrCountByPlayer.get(snap.player_id) ?? 0;
    // Prefer the HR row's opponent when available; otherwise fall back to game lookup.
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

  // ALSO: HR hitters NOT in the snapshot — represent as a phantom row with rank=null.
  // Classification = FN, signals empty. captured_at marks the row.
  const inSnapshotIds = new Set(snapshots.map((s) => s.player_id));
  let phantomCount = 0;
  for (const [pid, count] of hrCountByPlayer) {
    if (inSnapshotIds.has(pid)) continue;
    // Look up name/team/opponent from HR rows
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
      in_safe: false, in_value: false, in_chaos: false,
      homered: true,
      hr_count: count,
      classification: 'FN' as const,
    });
    phantomCount++;
  }

  // 5. Tally classifications + upsert into Supabase
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of records) {
    if (r.classification === 'TP') tp++;
    else if (r.classification === 'FP') fp++;
    else if (r.classification === 'FN') fn++;
    else if (r.classification === 'TN') tn++;
  }
  console.log(`[captureDay] classifications: TP=${tp} FP=${fp} FN=${fn} TN=${tn} (phantom FN from unranked HR hitters: ${phantomCount})`);

  const nowIso = new Date().toISOString();
  const upsertRows = records.map((r) => ({ ...r, captured_at: nowIso }));
  const { error: upsertErr } = await supabaseAdmin
    .from('learning_predictions')
    .upsert(upsertRows, { onConflict: 'target_date,player_id,model_version' });
  if (upsertErr) throw new Error(`learning_predictions upsert: ${upsertErr.message}`);

  // 6. Refresh feature_importance for each window
  let importanceWritten = 0;
  for (const winDays of importanceWindows) {
    const rows = await loadLearningRowsFor(date, mv.version, winDays);
    if (rows.length === 0) continue;
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
    importanceWritten += fiRows.length;
  }

  // 7. Refresh model_versions roll-up (per-leg + coverage from the
  //    classification — no separate parlay backtest needed since we
  //    already have all the data inline).
  const totalParlayLegs = (safe.incomplete ? 0 : 3) + (value.incomplete ? 0 : 3) + (chaos.incomplete ? 0 : 3);
  let legsHit = 0;
  for (const leg of [...safe.legs, ...value.legs, ...chaos.legs]) {
    if (hrCountByPlayer.has(leg.player_id)) legsHit++;
  }
  const top10Ids = new Set(snapshots.filter((s) => s.rank <= 10).map((s) => s.player_id));
  const poolIds = new Set(snapshots.map((s) => s.player_id));
  let inTop10 = 0, inPool = 0;
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
  if (mvErr) console.warn(`[captureDay] model_versions update warning: ${mvErr.message}`);

  return {
    date,
    model_version: mv.version,
    predictions_written: upsertRows.length,
    tp, fp, fn, tn,
    unranked_hr_hitters: phantomCount,
    importance_rows_written: importanceWritten,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await captureDay(args.date, args.importanceWindows);
  console.log('[captureDay] result:', JSON.stringify(result, null, 2));
}

// Only invoke main when run directly (allows import for cron orchestrator).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[captureDay] FAILED:', err);
    process.exit(1);
  });
}
