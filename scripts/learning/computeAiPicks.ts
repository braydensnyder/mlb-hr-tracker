/**
 * computeAiPicks — build vAI (v7) predictions for a completed date.
 *
 * For each target date:
 *   1. Load v1-v6 learning_predictions ROWS FOR TARGET DATE.
 *   2. Load v1-v6 performance from [target-30, target-1] (hindsight-safe).
 *   3. Run computeAiEnsembleRankings → per-player ensemble score + reasoning.
 *   4. Upsert as version=7 rows in learning_predictions with:
 *        - rank = ensemble_rank
 *        - heat_score = ensemble_score × 100 (comparable scale)
 *        - reason = plain-English reasoning
 *        - signals_json = full contribution breakdown (for ModelCard drill-down)
 *
 * CRITICAL: performance window is STRICTLY BEFORE target_date. No hindsight.
 *
 * Idempotent — upserts on (target_date, player_id, model_version).
 *
 * Usage:
 *   npm run learning:ai-picks -- 2026-06-26
 *   npm run learning:ai-picks -- --from 2026-06-01 --to 2026-06-26
 *   npm run learning:ai-picks -- yesterday
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';
import {
  AI_ENSEMBLE_CONFIG,
  classifyPrediction,
  computeAiEnsembleRankings,
  heatToProbLocal,
  type VersionPerformanceForWindow,
  type VersionRankedPick,
} from '../../src/lib/stats.js';

const AI_VERSION = 7;

interface LearningPredictionLite {
  target_date: string;
  player_id: number;
  model_version: number;
  player_name: string;
  team: string;
  opponent: string | null;
  game_pk: number | null;
  rank: number | null;
  homered: boolean | null;
}

async function loadPredictionsForDate(date: string): Promise<LearningPredictionLite[]> {
  const PAGE = 1000;
  const all: LearningPredictionLite[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAdmin
      .from('learning_predictions')
      .select('target_date, player_id, model_version, player_name, team, opponent, game_pk, rank, homered')
      .eq('target_date', date)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`predictions for ${date}: ${error.message}`);
    }
    const rows = (data ?? []) as LearningPredictionLite[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

async function loadPerformanceWindow(from: string, to: string): Promise<VersionPerformanceForWindow[]> {
  // Returns per-version aggregates over [from, to] inclusive.
  // to is STRICTLY BEFORE the target date (caller enforces).
  const PAGE = 1000;
  const rows: { model_version: number; target_date: string; player_id: number; rank: number | null; homered: boolean | null }[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await supabaseAdmin
      .from('learning_predictions')
      .select('model_version, target_date, player_id, rank, homered')
      .gte('target_date', from)
      .lte('target_date', to)
      .neq('model_version', AI_VERSION) // don't feed AI predictions back into the ensemble
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`perf window: ${error.message}`);
    }
    const chunk = (data ?? []) as typeof rows;
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }

  // Aggregate: for each version, distinct HR hitters and how many in Top 10.
  type Accum = { days: Set<string>; hr_by_date: Map<string, Set<number>>; top10_hits_by_date: Map<string, Set<number>> };
  const byVersion = new Map<number, Accum>();
  for (const r of rows) {
    let acc = byVersion.get(r.model_version);
    if (!acc) {
      acc = { days: new Set(), hr_by_date: new Map(), top10_hits_by_date: new Map() };
      byVersion.set(r.model_version, acc);
    }
    acc.days.add(r.target_date);
    if (r.homered === true) {
      let hrs = acc.hr_by_date.get(r.target_date);
      if (!hrs) { hrs = new Set(); acc.hr_by_date.set(r.target_date, hrs); }
      hrs.add(r.player_id);
      if (r.rank != null && r.rank <= 10) {
        let hits = acc.top10_hits_by_date.get(r.target_date);
        if (!hits) { hits = new Set(); acc.top10_hits_by_date.set(r.target_date, hits); }
        hits.add(r.player_id);
      }
    }
  }

  const out: VersionPerformanceForWindow[] = [];
  for (const [version, acc] of byVersion) {
    let totalHrs = 0;
    let hrsInTop10 = 0;
    for (const [, hrSet] of acc.hr_by_date) totalHrs += hrSet.size;
    for (const [, hitSet] of acc.top10_hits_by_date) hrsInTop10 += hitSet.size;
    out.push({
      version,
      days_tested: acc.days.size,
      total_hr_hitters: totalHrs,
      hrs_in_top10: hrsInTop10,
      raw_top10_coverage: totalHrs > 0 ? hrsInTop10 / totalHrs : 0,
    });
  }
  return out;
}

export interface AiPicksCaptureResult {
  date: string;
  window: { from: string; to: string };
  input_versions: number[];
  had_prior_data: boolean;
  version_weights: Array<{ version: number; days: number; raw_coverage: number; shrunk: number; weight: number }>;
  picks_written: number;
  tp: number; fp: number; fn: number; tn: number;
  skipped: string[];
}

/** Programmatic API — called by CLI and by cron Phase 7. */
export async function computeAiPicksForDate(date: string): Promise<AiPicksCaptureResult> {
  const cfg = AI_ENSEMBLE_CONFIG;
  const windowFrom = mlbAddDays(date, -cfg.performanceWindowDays);
  const windowTo = mlbAddDays(date, -1); // STRICT: never include target date itself

  console.log(`[computeAiPicks] date=${date} window=[${windowFrom} .. ${windowTo}]`);
  const skipped: string[] = [];

  // 1. Load v1-v6 picks for the target date.
  const targetDayRows = await loadPredictionsForDate(date);
  const inputVersions = Array.from(new Set(targetDayRows.map((r) => r.model_version))).filter((v) => v !== AI_VERSION).sort();
  if (inputVersions.length === 0) {
    throw new Error(`No v1-v6 predictions for ${date}. Run captureDay + replayModels first.`);
  }
  console.log(`[computeAiPicks]   input versions on target date: [${inputVersions.join(',')}] (${targetDayRows.length} total rows)`);

  // Group into picks per version (for the ensemble).
  const picksByVersion = new Map<number, VersionRankedPick[]>();
  for (const r of targetDayRows) {
    if (r.model_version === AI_VERSION) continue;
    if (r.rank == null) continue;
    let arr = picksByVersion.get(r.model_version);
    if (!arr) { arr = []; picksByVersion.set(r.model_version, arr); }
    arr.push({ player_id: r.player_id, player_name: r.player_name, team: r.team, rank: r.rank });
  }

  // 2. Load hindsight-safe performance window.
  const perfRaw = await loadPerformanceWindow(windowFrom, windowTo);
  // Ensure every input version has an entry (even zero-day ones so they get pure prior).
  const perfByVersion = new Map<number, VersionPerformanceForWindow>();
  for (const p of perfRaw) perfByVersion.set(p.version, p);
  for (const v of inputVersions) {
    if (!perfByVersion.has(v)) {
      perfByVersion.set(v, { version: v, days_tested: 0, total_hr_hitters: 0, hrs_in_top10: 0, raw_top10_coverage: 0 });
    }
  }
  const performance = Array.from(perfByVersion.values()).filter((p) => p.version !== AI_VERSION).sort((a, b) => a.version - b.version);
  console.log(`[computeAiPicks]   perf window loaded: ${performance.map((p) => `v${p.version}=${p.days_tested}d/${(p.raw_top10_coverage * 100).toFixed(0)}%`).join(' ')}`);

  // 3. Run the ensemble.
  const ensemble = computeAiEnsembleRankings(picksByVersion, performance, date, { from: windowFrom, to: windowTo });
  console.log(`[computeAiPicks]   ensemble weights: ${ensemble.version_weights.map((w) => `v${w.version}=${(w.weight * 100).toFixed(1)}%`).join(' ')}${ensemble.had_prior_data ? '' : ' (equal — no prior data)'}`);
  console.log(`[computeAiPicks]   ${ensemble.picks.length} distinct players scored`);

  // 4. Build outcome index — homered? from the target-day rows.
  const homeredById = new Map<number, boolean>();
  const opponentById = new Map<number, string | null>();
  const gamePkById = new Map<number, number | null>();
  for (const r of targetDayRows) {
    if (r.homered === true) homeredById.set(r.player_id, true);
    if (opponentById.get(r.player_id) == null && r.opponent != null) opponentById.set(r.player_id, r.opponent);
    if (gamePkById.get(r.player_id) == null && r.game_pk != null) gamePkById.set(r.player_id, r.game_pk);
  }

  // 5. Build learning_predictions rows for v7.
  const now = new Date().toISOString();
  // Only keep top 100 in the DB (matches other versions' cutoff for practicality)
  const topPicks = ensemble.picks.slice(0, 100);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const rows = topPicks.map((p) => {
    const homered = !!homeredById.get(p.player_id);
    // Convert ensemble_score (0..1) to a heat-score-like number (0..100)
    const heat = p.ensemble_score * 100;
    const classification = classifyPrediction(p.ensemble_rank, homered);
    if (classification === 'TP') tp++;
    else if (classification === 'FP') fp++;
    else if (classification === 'FN') fn++;
    else if (classification === 'TN') tn++;
    return {
      target_date: date,
      player_id: p.player_id,
      model_version: AI_VERSION,
      player_name: p.player_name,
      team: p.team,
      opponent: opponentById.get(p.player_id) ?? null,
      game_pk: gamePkById.get(p.player_id) ?? null,
      rank: p.ensemble_rank,
      heat_score: heat,
      model_prob: heatToProbLocal(heat),
      reason: p.reasoning,
      signals_json: {
        ensemble_score: p.ensemble_score,
        versions_agreeing: p.versions_agreeing,
        average_rank: p.average_rank,
        strongest_version: p.strongest_version,
        contributions: p.contributions,
        window: { from: windowFrom, to: windowTo, had_prior_data: ensemble.had_prior_data },
      },
      in_safe: false, in_value: false, in_chaos: false, // AI Picks isn't a parlay style; leave false
      homered,
      hr_count: 0, // filled by later re-runs from the actual home_runs join; safe default
      classification,
      captured_at: now,
    };
  });

  // Phantom FN — HR hitters NOT in the AI's Top 100. Only ones that were in
  // at least one input version's roster (so they had a chance).
  const inAiTop = new Set(topPicks.map((p) => p.player_id));
  for (const [pid, was] of homeredById) {
    if (!was || inAiTop.has(pid)) continue;
    const r = targetDayRows.find((x) => x.player_id === pid)!;
    rows.push({
      target_date: date, player_id: pid, model_version: AI_VERSION,
      player_name: r.player_name, team: r.team,
      opponent: r.opponent, game_pk: r.game_pk,
      rank: null, heat_score: 0, model_prob: null,
      reason: 'Not in AI Picks (unscored — no input version placed in Top 50).',
      signals_json: { ensemble_score: 0, versions_agreeing: 0, average_rank: null, strongest_version: null, contributions: [], window: { from: windowFrom, to: windowTo, had_prior_data: ensemble.had_prior_data } },
      in_safe: false, in_value: false, in_chaos: false,
      homered: true, hr_count: 0,
      classification: 'FN' as const,
      captured_at: now,
    });
    fn++;
  }

  // 6. Upsert.
  if (rows.length > 0) {
    const BATCH = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error, count } = await supabaseAdmin
        .from('learning_predictions')
        .upsert(chunk, { onConflict: 'target_date,player_id,model_version', count: 'exact' });
      if (error) throw new Error(`upsert v${AI_VERSION}: ${error.message}`);
      written += count ?? chunk.length;
    }
    console.log(`[computeAiPicks]   ${written} v7 rows written (TP=${tp} FP=${fp} FN=${fn} TN=${tn})`);
  }

  return {
    date,
    window: { from: windowFrom, to: windowTo },
    input_versions: inputVersions,
    had_prior_data: ensemble.had_prior_data,
    version_weights: ensemble.version_weights.map((w) => ({
      version: w.version, days: w.days_tested,
      raw_coverage: w.raw_top10_coverage, shrunk: w.shrunk_perf, weight: w.weight,
    })),
    picks_written: rows.length,
    tp, fp, fn, tn,
    skipped,
  };
}

// ---- CLI ----
interface Args { from: string; to: string; }
function parseArgs(argv: string[]): Args {
  let from = ''; let to = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === 'today') { from = to = mlbToday(); }
    else if (a === 'yesterday') { from = to = mlbAddDays(mlbToday(), -1); }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!from) { from = to = mlbAddDays(mlbToday(), -1); }
  if (!to) to = from;
  if (from > to) throw new Error(`--from (${from}) > --to (${to})`);
  return { from, to };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let d = args.from;
  const outcomes: AiPicksCaptureResult[] = [];
  while (d <= args.to) {
    try {
      const r = await computeAiPicksForDate(d);
      outcomes.push(r);
    } catch (e) {
      console.error(`[computeAiPicks] ${d} FAILED: ${e instanceof Error ? e.message : e}`);
    }
    d = mlbAddDays(d, 1);
  }
  console.log('\n[computeAiPicks] final summary:');
  console.log(`  dates processed: ${outcomes.length}`);
  for (const o of outcomes) {
    console.log(`  ${o.date}: ${o.picks_written} rows (TP=${o.tp} FP=${o.fp} FN=${o.fn} TN=${o.tn}) window ${o.window.from}..${o.window.to}`);
  }
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error('[computeAiPicks] FATAL:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
