/**
 * calibrateHitScore — chronological 3-way benchmark for Hit Score v1.
 *
 * Runs BEFORE committing to a live ranking method. Compares:
 *   1. Deterministic Hit Score (small rounded weights, interpretable)
 *   2. Logistic regression on P(hits >= 1)
 *   3. Logistic regression on P(hits >= 2)
 *
 * All three are calibrated on a chronological train / validation /
 * test split. Test dates are UNTOUCHED during training/tuning — Top-N
 * hit rates on the test slice are the primary decision metric.
 *
 * Strict no-leakage contract for feature construction:
 *   - Every feature is computed AS OF the day BEFORE the training row's
 *     target_date. Rolling batter features cumulate from prior batting
 *     lines only; pitcher rates cumulate from prior pitcher starts
 *     only; season slash is derived from the batter's own historical
 *     lines (not players.season_avg, which is current-time and
 *     would leak).
 *   - Lineup slot (from the batting line itself) is allowed since
 *     lineups are posted BEFORE first pitch.
 *
 * Training set inclusion:
 *   - Only rows where batting_order_slot IS NOT NULL (i.e., the player
 *     started). Pinch hitters / defensive subs are excluded — we're
 *     predicting expected performance of a starter.
 *   - Only rows where the player has ≥ MIN_PRIOR_GAMES prior games in
 *     the season so features aren't dominated by tiny-sample noise.
 *
 * Feature priority (per user directive):
 *   - Contact / opportunity: season_avg_asof, hit_rate_l7d_asof,
 *     hits_l7d_asof, expected_pa (from slot), season_k_rate_asof,
 *     recent_k_rate_asof, pitcher_h_per_9_asof, pitcher_whip_asof,
 *     pitcher_k_per_9_asof, pitcher_bb_per_9_asof
 *   - Platoon (only if coverage ≥ MIN_PLATOON_COVERAGE): platoon_hit_rate
 *   - Multi-hit specific (2+ only): multi_hit_rate_l10g_asof
 *   - Secondary tests: season_slg_asof, season_iso_asof (= slg - avg)
 *   - Environmental (small): weather_temp, weather_wind_toward_bs
 *
 * Logistic regression:
 *   - Simple binary classifier, gradient descent with L2 (λ tuned via val)
 *   - Standardised features (μ, σ from train only)
 *   - Sigmoid + numerically stable log-loss
 *   - Early stopping on validation log-loss
 *   - Outputs: standardised coefficients (interpretability) and
 *     un-standardised coefficients (for scoring live inputs)
 *
 * NO changes to Heat Score / HR path. Read-only benchmark.
 *
 * Usage:
 *   npm run learning:calibrate-hits                          # last 90d default
 *   npm run learning:calibrate-hits -- --last 120
 *   npm run learning:calibrate-hits -- --from D1 --to D2
 *   npm run learning:calibrate-hits -- --train 0.7 --val 0.15
 *   npm run learning:calibrate-hits -- --min-prior-games 15
 *   npm run learning:calibrate-hits -- --drop-platoon        # force drop even if coverage OK
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate.js';

// ---------- Config ----------

const DEFAULT_LAST_DAYS = 90;
const DEFAULT_TRAIN = 0.7;
const DEFAULT_VAL = 0.15;
const MIN_PRIOR_GAMES = 10;                // per-player prior games required
const MIN_PLATOON_COVERAGE = 0.80;         // if <80% of training rows have platoon, drop feature
const TOPN_LIST = [3, 5, 10, 25];
const LR_ITERATIONS = 300;
const LR_LEARNING_RATE = 0.1;
const LR_L2_CANDIDATES = [0.0, 0.01, 0.1, 1.0];

// Expected PA per lineup slot (league-average, empirical).
const EXPECTED_PA_BY_SLOT: Record<number, number> = {
  1: 4.65, 2: 4.55, 3: 4.44, 4: 4.33, 5: 4.22,
  6: 4.11, 7: 4.00, 8: 3.89, 9: 3.78,
};

// ---------- CLI ----------

interface Args {
  from: string | null;
  to: string;
  minPriorGames: number;
  dropPlatoon: boolean;
  warmupDates: number;
  /** Fraction of training dates used for LR val (L2 sweep + early stopping).
   *  Walk-forward carves this out of the training window per step. */
  valFracOfTrain: number;
}
function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to = mlbToday();
  let last: number | null = null;
  let minPriorGames = MIN_PRIOR_GAMES;
  let dropPlatoon = false;
  let warmupDates = 20;
  let valFracOfTrain = 0.15;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--min-prior-games') minPriorGames = Number(argv[++i]);
    else if (a === '--drop-platoon') dropPlatoon = true;
    else if (a === '--warmup-dates') warmupDates = Number(argv[++i]);
    else if (a === '--val-frac') valFracOfTrain = Number(argv[++i]);
    else if (a === '--train' || a === '--val') { i++; console.warn(`  ⚠ ${a} is ignored — v3 uses walk-forward`); }
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!from) from = mlbAddDays(to, -((last ?? DEFAULT_LAST_DAYS) - 1));
  if (from > to) throw new Error(`--from > --to`);
  if (warmupDates < 5) throw new Error('--warmup-dates must be >= 5');
  if (valFracOfTrain <= 0 || valFracOfTrain >= 1) throw new Error('--val-frac in (0,1)');
  return { from, to, minPriorGames, dropPlatoon, warmupDates, valFracOfTrain };
}

// ---------- Data loading ----------

interface BLine {
  target_date: string;
  game_pk: number;
  player_id: number;
  team: string;
  at_bats: number;
  hits: number;
  plate_appearances: number;
  strikeouts: number;
  walks: number;
  batting_order_slot: number | null;
  opposing_starter_id: number | null;
  opposing_starter_hand: string | null;
}

interface PStart {
  pitcher_id: number;
  game_date: string;
  innings_pitched: number | null;
  hits_allowed: number | null;
  walks: number | null;
  strikeouts: number | null;
}

interface GameCtx {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
}

interface PlayerCatalog {
  player_id: number;
  bat_side: string | null;
  pitch_hand: string | null;
}

async function fetchAllPaged<T>(builder: () => any, PAGE = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 400; page++) {
    const { data, error } = await builder().range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return out;
      throw new Error(error.message);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadBattingLines(from: string, to: string): Promise<BLine[]> {
  return fetchAllPaged<BLine>(() =>
    supabaseAdmin
      .from('player_batting_lines')
      .select('target_date, game_pk, player_id, team, at_bats, hits, plate_appearances, strikeouts, walks, batting_order_slot, opposing_starter_id, opposing_starter_hand')
      .gte('target_date', from)
      .lte('target_date', to)
      .order('target_date', { ascending: true }),
  );
}

async function loadPitcherStarts(from: string, to: string): Promise<PStart[]> {
  return fetchAllPaged<PStart>(() =>
    supabaseAdmin
      .from('pitcher_starts')
      .select('pitcher_id, game_date, innings_pitched, hits_allowed, walks, strikeouts')
      .gte('game_date', from)
      .lte('game_date', to)
      .order('game_date', { ascending: true }),
  );
}

async function loadGames(from: string, to: string): Promise<GameCtx[]> {
  return fetchAllPaged<GameCtx>(() =>
    supabaseAdmin
      .from('games')
      .select('game_pk, game_date, home_team, away_team, weather_temp_f, weather_wind_mph, weather_wind_dir')
      .gte('game_date', from)
      .lte('game_date', to),
  );
}

/**
 * A date is COMPLETE only if every game on that date has status='Final'
 * (or another terminal status). Half-finished dates would give a batter
 * an incomplete hit count — a hitter could get another hit in a still-
 * playing game — so those dates MUST be excluded from training AND
 * from evaluation.
 *
 * Terminal statuses per MLB feed convention: Final, Game Over,
 * Completed Early, Postponed, Cancelled. Postponed/Cancelled dates
 * yield zero rows anyway; they're safe to include.
 */
async function loadCompleteDates(from: string, to: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('games')
    .select('game_date, status')
    .gte('game_date', from)
    .lte('game_date', to);
  if (error) throw new Error(`games status: ${error.message}`);
  const rows = (data ?? []) as { game_date: string; status: string | null }[];
  const TERMINAL = new Set(['Final', 'Game Over', 'Completed Early', 'Postponed', 'Cancelled']);
  const byDate = new Map<string, { total: number; terminal: number }>();
  for (const r of rows) {
    const cur = byDate.get(r.game_date) ?? { total: 0, terminal: 0 };
    cur.total += 1;
    if (r.status && TERMINAL.has(r.status)) cur.terminal += 1;
    byDate.set(r.game_date, cur);
  }
  const complete = new Set<string>();
  for (const [d, c] of byDate) {
    if (c.total > 0 && c.terminal === c.total) complete.add(d);
  }
  return complete;
}

async function loadPlayerCatalog(ids: number[]): Promise<Map<number, PlayerCatalog>> {
  const out = new Map<number, PlayerCatalog>();
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('players')
      .select('player_id, bat_side, pitch_hand')
      .in('player_id', chunk);
    if (error) throw new Error(`players catalog: ${error.message}`);
    for (const r of (data ?? []) as PlayerCatalog[]) out.set(r.player_id, r);
  }
  return out;
}

// ---------- IP math (mirrors rebuildPitcherForm) ----------

function ipToOuts(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n < 0) return 0;
  const whole = Math.floor(n);
  const dec10 = Math.round((n - whole) * 10);
  const extra = dec10 === 1 ? 1 : dec10 === 2 ? 2 : 0;
  return whole * 3 + extra;
}

// ---------- Feature construction ----------

interface Row {
  target_date: string;
  player_id: number;
  team: string;
  hits: number;
  ab: number;
  // Labels
  y1: number;   // hits >= 1
  y2: number;   // hits >= 2
  // Features
  season_avg_asof: number;
  season_slg_asof: number | null;         // if we have HR data joined; may stay null
  season_iso_asof: number | null;
  season_k_rate_asof: number;
  hit_rate_l7d_asof: number;
  hits_l7d_asof: number;
  ab_l7d_asof: number;
  recent_k_rate_asof: number;
  multi_hit_rate_l10g_asof: number;
  expected_pa: number;
  pitcher_h_per_9_asof: number | null;
  pitcher_whip_asof: number | null;
  pitcher_k_per_9_asof: number | null;
  pitcher_bb_per_9_asof: number | null;
  platoon_hit_rate_asof: number | null;   // hits vs starter's hand / ab vs same
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  prior_games_count: number;              // for filter
  has_platoon: boolean;                   // did we get a valid platoon rate?
}

/**
 * Build rows with strict as-of features. For each (target_date, player_id):
 *   - Take player's batting-lines strictly BEFORE target_date
 *   - Cumulate: hits, ab, k, pa (season-to-date and last-7-days by calendar)
 *   - Multi-hit rate over last 10 games appeared
 *   - Platoon rate vs the STARTER's hand (backfill from players catalog when
 *     the persisted opposing_starter_hand is null)
 * Pitcher rates: cumulate pitcher_starts strictly BEFORE target_date; require
 *   ≥3 starts and ≥18 IP for rates to be computable.
 */
function buildRows(
  lines: BLine[],
  starts: PStart[],
  games: GameCtx[],
  pitcherHandFallback: Map<number, string | null>,
): Row[] {
  // Index games by game_pk for weather lookup.
  const gamesByPk = new Map<number, GameCtx>();
  for (const g of games) gamesByPk.set(g.game_pk, g);

  // Group lines by player, sort by date.
  const linesByPlayer = new Map<number, BLine[]>();
  for (const l of lines) {
    const arr = linesByPlayer.get(l.player_id) ?? [];
    arr.push(l);
    linesByPlayer.set(l.player_id, arr);
  }
  for (const arr of linesByPlayer.values()) arr.sort((a, b) => a.target_date.localeCompare(b.target_date));

  // Group pitcher starts by pitcher, sort by date.
  const startsByPitcher = new Map<number, PStart[]>();
  for (const s of starts) {
    const arr = startsByPitcher.get(s.pitcher_id) ?? [];
    arr.push(s);
    startsByPitcher.set(s.pitcher_id, arr);
  }
  for (const arr of startsByPitcher.values()) arr.sort((a, b) => a.game_date.localeCompare(b.game_date));

  const out: Row[] = [];

  for (const [player_id, plines] of linesByPlayer) {
    // Walk chronologically; maintain cumulative counters.
    let cumHits = 0, cumAb = 0, cumK = 0, cumPa = 0;
    let hitsVsL = 0, abVsL = 0, hitsVsR = 0, abVsR = 0;
    let priorGamesCount = 0;
    // Rolling last-N-games window (deque of prior lines newest-first)
    const priorGames: BLine[] = []; // append prior lines chronologically

    for (const line of plines) {
      if (line.batting_order_slot == null) {
        // Not a starter — still update cumulatives (they hit, count them),
        // but skip emitting a row.
        cumHits += line.hits; cumAb += line.at_bats; cumK += line.strikeouts; cumPa += line.plate_appearances;
        const handFromLine = line.opposing_starter_hand
          ?? (line.opposing_starter_id != null ? pitcherHandFallback.get(line.opposing_starter_id) ?? null : null);
        if (handFromLine === 'L') { hitsVsL += line.hits; abVsL += line.at_bats; }
        else if (handFromLine === 'R') { hitsVsR += line.hits; abVsR += line.at_bats; }
        priorGames.push(line);
        priorGamesCount++;
        continue;
      }

      // Emit training row using AS-OF cumulatives (BEFORE this game).
      if (priorGamesCount >= 1) {
        // Compute as-of features from priorGames + cumulatives.
        const season_avg_asof = cumAb > 0 ? cumHits / cumAb : 0;
        const season_k_rate_asof = cumPa > 0 ? cumK / cumPa : 0;

        // Last-7-day window (calendar) prior to target_date.
        const cutoff7 = addDaysUtc(line.target_date, -7);
        let h7 = 0, ab7 = 0, k7 = 0, pa7 = 0;
        for (const pg of priorGames) {
          if (pg.target_date >= cutoff7 && pg.target_date < line.target_date) {
            h7 += pg.hits; ab7 += pg.at_bats; k7 += pg.strikeouts; pa7 += pg.plate_appearances;
          }
        }
        const hit_rate_l7d_asof = ab7 > 0 ? h7 / ab7 : 0;
        const recent_k_rate_asof = pa7 > 0 ? k7 / pa7 : 0;

        // Multi-hit rate over LAST 10 GAMES prior (by count, not calendar).
        const last10 = priorGames.slice(-10);
        const multiHitCount = last10.filter((pg) => pg.hits >= 2).length;
        const multi_hit_rate_l10g_asof = last10.length > 0 ? multiHitCount / last10.length : 0;

        // Platoon rate — hits vs THIS game's opposing starter's hand, from
        // cumulative counters above (also using pitcher-hand fallback).
        const thisHand = line.opposing_starter_hand
          ?? (line.opposing_starter_id != null ? pitcherHandFallback.get(line.opposing_starter_id) ?? null : null);
        let platoon_hit_rate_asof: number | null = null;
        let has_platoon = false;
        if (thisHand === 'L' && abVsL > 0) { platoon_hit_rate_asof = hitsVsL / abVsL; has_platoon = true; }
        else if (thisHand === 'R' && abVsR > 0) { platoon_hit_rate_asof = hitsVsR / abVsR; has_platoon = true; }

        // Pitcher rates as-of day BEFORE this game.
        let pitcher_h_per_9_asof: number | null = null;
        let pitcher_whip_asof: number | null = null;
        let pitcher_k_per_9_asof: number | null = null;
        let pitcher_bb_per_9_asof: number | null = null;
        if (line.opposing_starter_id != null) {
          const oppStarts = startsByPitcher.get(line.opposing_starter_id) ?? [];
          let outs = 0, ha = 0, wa = 0, ka = 0, startsN = 0;
          for (const s of oppStarts) {
            if (s.game_date >= line.target_date) break; // strictly before
            outs += ipToOuts(s.innings_pitched);
            ha += Number(s.hits_allowed) || 0;
            wa += Number(s.walks) || 0;
            ka += Number(s.strikeouts) || 0;
            startsN++;
          }
          const ipFloat = outs / 3;
          if (startsN >= 3 && ipFloat >= 18) {
            pitcher_h_per_9_asof  = (ha * 9) / ipFloat;
            pitcher_whip_asof     = (wa + ha) / ipFloat;
            pitcher_k_per_9_asof  = (ka * 9) / ipFloat;
            pitcher_bb_per_9_asof = (wa * 9) / ipFloat;
          }
        }

        // Weather from games.
        const g = gamesByPk.get(line.game_pk);

        // ISO — placeholder; SLG requires per-game total bases which we
        // don't reliably track. For v1 we leave season_slg / iso as null
        // and the LR model treats them as always-missing (dropped).
        // TODO: derive SLG from doubles + triples + HRs in batting_lines
        // and season_avg (this is straightforward — future enhancement).

        out.push({
          target_date: line.target_date,
          player_id,
          team: line.team,
          hits: line.hits,
          ab: line.at_bats,
          y1: line.hits >= 1 ? 1 : 0,
          y2: line.hits >= 2 ? 1 : 0,
          season_avg_asof,
          season_slg_asof: null,      // future
          season_iso_asof: null,       // future (SLG - AVG)
          season_k_rate_asof,
          hit_rate_l7d_asof,
          hits_l7d_asof: h7,
          ab_l7d_asof: ab7,
          recent_k_rate_asof,
          multi_hit_rate_l10g_asof,
          expected_pa: EXPECTED_PA_BY_SLOT[line.batting_order_slot] ?? 4.0,
          pitcher_h_per_9_asof,
          pitcher_whip_asof,
          pitcher_k_per_9_asof,
          pitcher_bb_per_9_asof,
          platoon_hit_rate_asof,
          weather_temp_f: g?.weather_temp_f ?? null,
          weather_wind_mph: g?.weather_wind_mph ?? null,
          prior_games_count: priorGamesCount,
          has_platoon,
        });
      }

      // Update cumulatives WITH THIS GAME for future iterations.
      cumHits += line.hits; cumAb += line.at_bats; cumK += line.strikeouts; cumPa += line.plate_appearances;
      const handAfter = line.opposing_starter_hand
        ?? (line.opposing_starter_id != null ? pitcherHandFallback.get(line.opposing_starter_id) ?? null : null);
      if (handAfter === 'L') { hitsVsL += line.hits; abVsL += line.at_bats; }
      else if (handAfter === 'R') { hitsVsR += line.hits; abVsR += line.at_bats; }
      priorGames.push(line);
      priorGamesCount++;
    }
  }
  return out;
}

function addDaysUtc(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// ---------- Feature-key registry ----------
//
// Each feature has a shape descriptor: how to extract a numeric value
// from a Row, or null when the row lacks it. Rows with null on a
// selected feature are EXCLUDED from that specific model's training
// set (never zero-filled).

interface FeatureSpec {
  key: string;
  extract: (r: Row) => number | null;
  /** True if this feature should be considered for both models. */
  common: boolean;
  /** True if only used for 2+ model. */
  twoPlusOnly?: boolean;
}

function baseFeatureSpecs(includePlatoon: boolean): FeatureSpec[] {
  const specs: FeatureSpec[] = [
    { key: 'season_avg_asof',       extract: (r) => r.season_avg_asof, common: true },
    { key: 'hit_rate_l7d_asof',     extract: (r) => r.hit_rate_l7d_asof, common: true },
    { key: 'hits_l7d_asof',         extract: (r) => r.hits_l7d_asof, common: true },
    { key: 'ab_l7d_asof',           extract: (r) => r.ab_l7d_asof, common: true },
    { key: 'expected_pa',           extract: (r) => r.expected_pa, common: true },
    { key: 'season_k_rate_asof',    extract: (r) => r.season_k_rate_asof, common: true },
    { key: 'recent_k_rate_asof',    extract: (r) => r.recent_k_rate_asof, common: true },
    { key: 'pitcher_h_per_9_asof',  extract: (r) => r.pitcher_h_per_9_asof, common: true },
    { key: 'pitcher_whip_asof',     extract: (r) => r.pitcher_whip_asof, common: true },
    { key: 'pitcher_k_per_9_asof',  extract: (r) => r.pitcher_k_per_9_asof, common: true },
    { key: 'pitcher_bb_per_9_asof', extract: (r) => r.pitcher_bb_per_9_asof, common: true },
    { key: 'weather_temp_f',        extract: (r) => r.weather_temp_f, common: true },
    { key: 'weather_wind_mph',      extract: (r) => r.weather_wind_mph, common: true },
    { key: 'multi_hit_rate_l10g_asof', extract: (r) => r.multi_hit_rate_l10g_asof, common: false, twoPlusOnly: true },
  ];
  if (includePlatoon) {
    specs.push({ key: 'platoon_hit_rate_asof', extract: (r) => r.platoon_hit_rate_asof, common: true });
  }
  return specs;
}

// ---------- Logistic regression (from-scratch) ----------

/** Numerically stable sigmoid. */
function sigmoid(z: number): number {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

/** Cross-entropy loss with L2 regularisation. */
function logLoss(X: number[][], y: number[], w: number[], b: number, l2: number): number {
  let loss = 0;
  const eps = 1e-12;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
    const p = sigmoid(z);
    const yi = y[i];
    loss += -(yi * Math.log(Math.max(p, eps)) + (1 - yi) * Math.log(Math.max(1 - p, eps)));
  }
  loss /= X.length;
  if (l2 > 0) {
    let reg = 0;
    for (const wi of w) reg += wi * wi;
    loss += (l2 / 2) * reg / X.length;
  }
  return loss;
}

interface FitResult {
  weights: number[];       // standardised-input coefficients
  bias: number;
  featureMeans: number[];
  featureStds: number[];
  finalTrainLoss: number;
  finalValLoss: number;
  epochs: number;
  l2Used: number;
}

/** Standardise columns: (x - μ) / σ using train stats. σ<eps → 1. */
function standardise(X: number[][], means: number[], stds: number[]): number[][] {
  return X.map((row) => row.map((v, j) => (v - means[j]) / (stds[j] || 1)));
}

function computeMeansStds(X: number[][]): { means: number[]; stds: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const means = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) means[j] += row[j];
  for (let j = 0; j < d; j++) means[j] /= (n || 1);
  const stds = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) stds[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j] / (n || 1));
  return { means, stds };
}

/** Batch gradient descent with L2. Early stops when val loss goes up. */
function fitLogistic(
  Xtr: number[][], ytr: number[],
  Xval: number[][], yval: number[],
  l2: number,
): { w: number[]; b: number; trainLoss: number; valLoss: number; epochs: number } {
  const d = Xtr[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  let lr = LR_LEARNING_RATE;
  let prevVal = Infinity;
  let bestW: number[] = w.slice(); let bestB = b; let bestVal = Infinity;
  let epochs = 0;
  for (let iter = 0; iter < LR_ITERATIONS; iter++) {
    // Gradients
    const dw = new Array(d).fill(0);
    let db = 0;
    for (let i = 0; i < Xtr.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Xtr[i][j];
      const p = sigmoid(z);
      const err = p - ytr[i];
      for (let j = 0; j < d; j++) dw[j] += err * Xtr[i][j];
      db += err;
    }
    const nTr = Xtr.length;
    for (let j = 0; j < d; j++) w[j] -= lr * (dw[j] / nTr + l2 * w[j] / nTr);
    b -= lr * (db / nTr);
    const valLoss = logLoss(Xval, yval, w, b, 0);
    if (valLoss < bestVal) { bestVal = valLoss; bestW = w.slice(); bestB = b; }
    if (valLoss > prevVal * 1.001 && iter > 20) { epochs = iter + 1; break; }
    prevVal = valLoss;
    if (iter === 50) lr *= 0.5;
    if (iter === 150) lr *= 0.5;
    epochs = iter + 1;
  }
  const trainLoss = logLoss(Xtr, ytr, bestW, bestB, 0);
  return { w: bestW, b: bestB, trainLoss, valLoss: bestVal, epochs };
}

function trainWithL2Sweep(
  Xtr: number[][], ytr: number[], Xval: number[][], yval: number[],
  means: number[], stds: number[],
): FitResult {
  let best: FitResult | null = null;
  for (const l2 of LR_L2_CANDIDATES) {
    const fit = fitLogistic(Xtr, ytr, Xval, yval, l2);
    if (!best || fit.valLoss < best.finalValLoss) {
      best = {
        weights: fit.w, bias: fit.b,
        featureMeans: means, featureStds: stds,
        finalTrainLoss: fit.trainLoss, finalValLoss: fit.valLoss,
        epochs: fit.epochs, l2Used: l2,
      };
    }
  }
  return best!;
}

// ---------- Evaluation ----------

function predict(X: number[][], w: number[], b: number): number[] {
  const out = new Array(X.length);
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
    out[i] = sigmoid(z);
  }
  return out;
}

/** AUC via pairs comparison (O(n log n) with sort). */
function auc(scores: number[], y: number[]): number {
  const paired = scores.map((s, i) => ({ s, y: y[i] })).sort((a, b) => a.s - b.s);
  let n1 = 0;
  for (const p of paired) if (p.y === 1) n1++;
  const n0 = paired.length - n1;
  if (n0 === 0 || n1 === 0) return NaN;
  let sumRanks = 0;
  for (let i = 0; i < paired.length; i++) {
    if (paired[i].y === 1) sumRanks += i + 1;
  }
  return (sumRanks - n1 * (n1 + 1) / 2) / (n0 * n1);
}

/** Top-N hit rate on the test slice: for each test date, rank rows by
 *  predicted probability, take top N, count how many actually satisfied
 *  the outcome label. Reports (hitters/topN) across all test dates. */
function topNHitRate(
  rows: Row[], scores: number[], y: number[], n: number,
): { hits: number; total: number; rate: number } {
  const byDate = new Map<string, { s: number; y: number; idx: number }[]>();
  for (let i = 0; i < rows.length; i++) {
    const arr = byDate.get(rows[i].target_date) ?? [];
    arr.push({ s: scores[i], y: y[i], idx: i });
    byDate.set(rows[i].target_date, arr);
  }
  let hits = 0, total = 0;
  for (const arr of byDate.values()) {
    arr.sort((a, b) => b.s - a.s);
    const topN = arr.slice(0, n);
    total += topN.length;
    for (const r of topN) if (r.y === 1) hits++;
  }
  return { hits, total, rate: total > 0 ? hits / total : 0 };
}

// ---------- Deterministic Hit Score presets ----------
//
// Rounded, interpretable weights on z-scored features → sigmoid.
// Two presets — the 1+ variant emphasises contact + opportunity,
// the 2+ variant lifts multi-hit-frequency and expected-PA and
// slightly softens pitcher rate weights (2+ hits are harder to
// suppress with one dominant matchup fact than 1+).
//
// The user's earlier result (deterministic 2+ Top-5 = 8/20, Top-10 =
// 11/40 vs 21.5% baseline) is why the 2+ preset gets its own row
// and calibrate v2 investigates it in the ablation grid.
const DETERMINISTIC_WEIGHTS_1PLUS: Record<string, number> = {
  season_avg_asof:          6,
  hit_rate_l7d_asof:        3,
  hits_l7d_asof:            1,
  ab_l7d_asof:              0,
  expected_pa:              5,
  season_k_rate_asof:      -3,
  recent_k_rate_asof:      -2,
  pitcher_h_per_9_asof:     3,
  pitcher_whip_asof:        2,
  pitcher_k_per_9_asof:    -3,
  pitcher_bb_per_9_asof:    1,
  platoon_hit_rate_asof:    1,
  weather_temp_f:           0.5,
  weather_wind_mph:         0,
  multi_hit_rate_l10g_asof: 0,
};

const DETERMINISTIC_WEIGHTS_2PLUS: Record<string, number> = {
  season_avg_asof:          5,
  hit_rate_l7d_asof:        3,
  hits_l7d_asof:            2,
  ab_l7d_asof:              1,
  expected_pa:              6,
  season_k_rate_asof:      -3,
  recent_k_rate_asof:      -2,
  pitcher_h_per_9_asof:     3,
  pitcher_whip_asof:        2,
  pitcher_k_per_9_asof:    -2,
  pitcher_bb_per_9_asof:    1,
  platoon_hit_rate_asof:    1,
  weather_temp_f:           0.5,
  weather_wind_mph:         0,
  multi_hit_rate_l10g_asof: 4,
};

function deterministicScore(row: number[], keys: string[], weights: Record<string, number>): number {
  let s = 0;
  for (let i = 0; i < keys.length; i++) s += (weights[keys[i]] ?? 0) * row[i];
  return sigmoid(s / 10);
}

// ---------- Utility ----------

function mean(xs: number[]): number { return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

// Simple Pearson correlation.
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return NaN;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n═══ Hit Score calibration v3 (walk-forward) ═══`);
  console.log(`  range: ${args.from} .. ${args.to}`);
  console.log(`  min prior games required: ${args.minPriorGames}`);
  console.log(`  warmup dates: ${args.warmupDates}   val-frac of train per fit: ${args.valFracOfTrain}`);

  // 1. Load raw data
  console.log(`\n  loading raw data …`);
  const [lines, starts, games] = await Promise.all([
    loadBattingLines(args.from!, args.to),
    // Load pitcher_starts spanning wider than args.from to fill season-to-date
    // pitcher rates for early dates in the range.
    loadPitcherStarts(mlbAddDays(args.from!, -220), args.to),
    loadGames(args.from!, args.to),
  ]);
  console.log(`    ${lines.length} batting lines, ${starts.length} pitcher starts, ${games.length} games`);
  if (lines.length === 0) {
    console.log(`\n  No batting lines in range. Run backfill:batting-lines and rebuild:hit-summaries first.`);
    return;
  }

  // 2. Pitcher-hand fallback via players catalog for any batting line with id but null hand.
  const pitcherIds = new Set<number>();
  for (const l of lines) {
    if (l.opposing_starter_id != null && l.opposing_starter_hand == null) pitcherIds.add(l.opposing_starter_id);
  }
  const pitcherHandFallback = new Map<number, string | null>();
  if (pitcherIds.size > 0) {
    console.log(`  loading pitch_hand fallback for ${pitcherIds.size} pitcher id(s) …`);
    const cat = await loadPlayerCatalog([...pitcherIds]);
    for (const [id, p] of cat) pitcherHandFallback.set(id, p.pitch_hand);
  }

  // 3. Build training rows with as-of features.
  console.log(`  building rows with strict as-of features …`);
  const allRows = buildRows(lines, starts, games, pitcherHandFallback);
  console.log(`    ${allRows.length} starter-row candidates`);

  // 4. Filter by min prior games so features aren't noise.
  const filtered = allRows.filter((r) => r.prior_games_count >= args.minPriorGames);
  console.log(`    ${filtered.length} rows after --min-prior-games ${args.minPriorGames}`);

  // 5. Positive rates.
  const posRate1 = filtered.filter((r) => r.y1 === 1).length / (filtered.length || 1);
  const posRate2 = filtered.filter((r) => r.y2 === 1).length / (filtered.length || 1);
  console.log(`\n  positive rates:`);
  console.log(`    P(hits ≥ 1) = ${(posRate1 * 100).toFixed(1)}%   (${filtered.filter((r) => r.y1 === 1).length}/${filtered.length})`);
  console.log(`    P(hits ≥ 2) = ${(posRate2 * 100).toFixed(1)}%   (${filtered.filter((r) => r.y2 === 1).length}/${filtered.length})`);

  // 6. Complete-date filter.
  //
  //    Unfinished dates get EXCLUDED from every phase. A partially-
  //    finished date (any game still in progress or pregame) would give
  //    a hitter an incomplete hit count — training would learn wrong
  //    outcomes, evaluation would score the model against wrong labels.
  //    This fixes the v2 report where Aug 17 leaked into the test-date
  //    count but had zero outcome rows.
  console.log(`\n  loading complete-date set …`);
  const completeDates = await loadCompleteDates(args.from!, args.to);
  const rowDatesBefore = new Set(filtered.map((r) => r.target_date));
  const excluded = [...rowDatesBefore].filter((d) => !completeDates.has(d)).sort();
  const filteredComplete = filtered.filter((r) => completeDates.has(r.target_date));
  console.log(`    complete dates in range: ${completeDates.size}`);
  if (excluded.length > 0) {
    console.log(`    excluded ${excluded.length} incomplete date(s): ${excluded.slice(0, 6).join(', ')}${excluded.length > 6 ? ` … (+${excluded.length - 6} more)` : ''}`);
  } else {
    console.log(`    no incomplete dates found in row set`);
  }
  console.log(`    rows before complete-date filter: ${filtered.length}`);
  console.log(`    rows after complete-date filter:  ${filteredComplete.length}`);

  // 7. Platoon coverage decision (recomputed post-complete-date filter).
  const platoonPresent = filteredComplete.filter((r) => r.has_platoon).length;
  const platoonPct = filteredComplete.length > 0 ? platoonPresent / filteredComplete.length : 0;
  const keepPlatoon = !args.dropPlatoon && platoonPct >= MIN_PLATOON_COVERAGE;
  console.log(`\n  platoon coverage: ${(platoonPct * 100).toFixed(1)}% (${platoonPresent}/${filteredComplete.length}) — ${keepPlatoon ? 'KEEP' : 'DROP'} (threshold ${(MIN_PLATOON_COVERAGE * 100).toFixed(0)}%)`);

  const specs = baseFeatureSpecs(keepPlatoon);

  // 8. Walk-forward setup.
  const orderedDates = [...new Set(filteredComplete.map((r) => r.target_date))].sort();
  console.log(`\n  walk-forward setup:`);
  console.log(`    total complete dates with rows: ${orderedDates.length}`);
  console.log(`    warmup dates (skipped, used only for training the first eval date): ${args.warmupDates}`);
  if (orderedDates.length <= args.warmupDates) {
    console.log(`\n  Not enough complete dates for walk-forward evaluation.`);
    console.log(`  Need ≥ ${args.warmupDates + 1} complete dates; have ${orderedDates.length}.`);
    console.log(`  Widen --from / --to, lower --warmup-dates, or backfill more history.`);
    return;
  }
  const evalDates = orderedDates.slice(args.warmupDates);
  console.log(`    eval dates (walked forward, each trained on strictly-prior data): ${evalDates.length}`);
  console.log(`    eval date range: ${evalDates[0]} .. ${evalDates[evalDates.length - 1]}`);

  // 9. Exploratory correlations — over ALL warmup+eval rows now (walk-
  //    forward has no fixed train slice). Diagnostic only.
  console.log(`\n  ── exploratory correlations (all filtered rows; per-feature drops missing rows) ──`);
  console.log(`    ${'feature'.padEnd(32)}  ${'n'.padStart(8)}  ${'corr(y1)'.padStart(9)}  ${'corr(y2)'.padStart(9)}`);
  for (const s of specs) {
    const xs: number[] = []; const y1s: number[] = []; const y2s: number[] = [];
    for (const r of filteredComplete) {
      const v = s.extract(r);
      if (v == null || !Number.isFinite(v)) continue;
      xs.push(v); y1s.push(r.y1); y2s.push(r.y2);
    }
    const c1 = pearson(xs, y1s);
    const c2 = pearson(xs, y2s);
    console.log(`    ${s.key.padEnd(32)}  ${String(xs.length).padStart(8)}  ${(Number.isFinite(c1) ? c1.toFixed(3) : '  -  ').padStart(9)}  ${(Number.isFinite(c2) ? c2.toFixed(3) : '  -  ').padStart(9)}`);
  }

  // 10. Materialise feature matrices. Rows with ANY null feature (for the
  //     chosen model) are DROPPED — never zero-filled.
  function materialise(
    rows: Row[], specsForModel: FeatureSpec[],
  ): { X: number[][]; y1: number[]; y2: number[]; rows: Row[] } {
    const outX: number[][] = []; const oy1: number[] = []; const oy2: number[] = []; const oRows: Row[] = [];
    for (const r of rows) {
      const vec: number[] = new Array(specsForModel.length);
      let bad = false;
      for (let i = 0; i < specsForModel.length; i++) {
        const v = specsForModel[i].extract(r);
        if (v == null || !Number.isFinite(v)) { bad = true; break; }
        vec[i] = v;
      }
      if (bad) continue;
      outX.push(vec); oy1.push(r.y1); oy2.push(r.y2); oRows.push(r);
    }
    return { X: outX, y1: oy1, y2: oy2, rows: oRows };
  }

  // ----- old-ablation-config STUB kept for spec picker -----
  //
  // Every ablation runs on the SAME chronological split. Deterministic
  // scoring uses the appropriate 1+/2+ weight preset with any dropped
  // features contributing zero. LR is retrained per-ablation on the
  // reduced feature set.
  //
  // "drop" is a list of feature keys to remove from the full set for this
  // ablation. Empty = full model. "keepOnly" (when set) overrides drop
  // and restricts to exactly the listed keys.
  interface CandidateModel {
    id: string;                    // stable key
    label: string;                  // display
    kind: 'DET' | 'LR';
    drop?: string[];                // feature keys to remove from base
    keepOnly?: string[];            // feature keys to restrict to
  }
  const CANDIDATE_MODELS: CandidateModel[] = [
    { id: 'DET_full',        kind: 'DET', label: 'DET full' },
    { id: 'DET_opportunity', kind: 'DET', label: 'DET opportunity-only',
      keepOnly: [
        'season_avg_asof', 'expected_pa',
        'season_k_rate_asof', 'recent_k_rate_asof',
        'pitcher_h_per_9_asof', 'pitcher_k_per_9_asof',
        'platoon_hit_rate_asof',
        'multi_hit_rate_l10g_asof',
      ] },
    { id: 'DET_no_volume',   kind: 'DET', label: 'DET no recent volume',
      drop: ['hits_l7d_asof', 'ab_l7d_asof'] },
    { id: 'DET_no_weather',  kind: 'DET', label: 'DET no weather',
      drop: ['weather_temp_f', 'weather_wind_mph'] },
    { id: 'LR_opportunity',  kind: 'LR',  label: 'LR opportunity-only',
      keepOnly: [
        'season_avg_asof', 'expected_pa',
        'season_k_rate_asof', 'recent_k_rate_asof',
        'pitcher_h_per_9_asof', 'pitcher_k_per_9_asof',
        'platoon_hit_rate_asof',
        'multi_hit_rate_l10g_asof',
      ] },
    { id: 'LR_full',         kind: 'LR',  label: 'LR full (diagnostic/control)' },
  ];

  function specsForCandidate(outcome: 'y1' | 'y2', cm: CandidateModel): FeatureSpec[] {
    const base = outcome === 'y1'
      ? specs.filter((s) => s.common)
      : specs.filter((s) => s.common || s.twoPlusOnly);
    if (cm.keepOnly) return base.filter((s) => cm.keepOnly!.includes(s.key));
    if (cm.drop)     return base.filter((s) => !cm.drop!.includes(s.key));
    return base;
  }

  // ---------- Walk-forward types ----------
  interface DailyRow {
    date: string;
    slate_size: number;
    slate_pos: number;
    slate_rate: number;
    top_hits: Record<number, number>;
    top_total: Record<number, number>;
  }

  // ---------- Runner ----------
  // 12. Walk-forward evaluator.
  //
  //     For each eval date D:
  //       - build train set from rows on dates strictly < D
  //       - materialise on the candidate's feature set (drop rows with any
  //         null feature; never zero-fill)
  //       - for LR: chronologically split train into (train_fit, val)
  //         using --val-frac. Fit L2 sweep on val loss. If val ends up
  //         empty, skip candidate for this date.
  //       - score D's slate on the model
  //       - record daily result
  //     Collect Map<candidate_id + outcome, DailyRow[]>.

  interface DailyResult extends DailyRow {
    /** How many D-day rows the candidate could actually score after
     *  feature-availability drops. If < TOPN, the candidate can't fill
     *  the top-N and it still counts toward the aggregate (short top-N
     *  is a real deficiency, not a bookkeeping edge case). */
    scored_rows: number;
    /** True when the LR fit was skipped (insufficient val rows etc). */
    skipped: boolean;
    skip_reason?: string;
  }

  interface CandidateResult {
    id: string;
    label: string;
    kind: 'LR' | 'DET';
    outcome: 'y1' | 'y2';
    features: string[];
    daily: DailyResult[];
    /** LR only: how often each feature carried a non-trivial |β| across
     *  the walk-forward fits. Diagnostic for stability of interpretation. */
    beta_by_feature_avg?: Map<string, number>;
    fits_ok: number;
    fits_skipped: number;
  }

  function fmtPct(x: number): string { return Number.isFinite(x) ? (x * 100).toFixed(1).padStart(5) + '%' : '  -  '.padStart(6); }

  function scoreCandidateForDate(
    cm: CandidateModel,
    outcome: 'y1' | 'y2',
    D: string,
  ): { day: DailyResult; betas?: Map<string, number> } {
    const specsForModel = specsForCandidate(outcome, cm);
    const keys = specsForModel.map((s) => s.key);
    const trainRows = filteredComplete.filter((r) => r.target_date < D);
    const dayRows   = filteredComplete.filter((r) => r.target_date === D);

    const trMat  = materialise(trainRows, specsForModel);
    const dayMat = materialise(dayRows, specsForModel);

    // Full-slate baseline for this outcome/date (all filtered rows on D,
    // not just those this candidate could score).
    const slate = dayRows;
    const slate_pos = slate.reduce((s, r) => s + (outcome === 'y1' ? r.y1 : r.y2), 0);
    const emptyDaily: DailyResult = {
      date: D, slate_size: slate.length, slate_pos, slate_rate: slate.length > 0 ? slate_pos / slate.length : 0,
      top_hits: {}, top_total: {},
      scored_rows: dayMat.X.length, skipped: true,
    };
    for (const n of TOPN_LIST) { emptyDaily.top_hits[n] = 0; emptyDaily.top_total[n] = 0; }

    if (dayMat.X.length === 0) {
      return { day: { ...emptyDaily, skip_reason: 'no scorable rows on D after feature-availability drops' } };
    }

    // Compute scores per candidate kind.
    let scoreFn: (row: number[]) => number;
    let betas: Map<string, number> | undefined;
    if (cm.kind === 'DET') {
      // DET uses train-set μ/σ to standardise, then preset weights.
      if (trMat.X.length < 100) {
        return { day: { ...emptyDaily, skip_reason: `DET needs ≥100 train rows to compute μ/σ; have ${trMat.X.length}` } };
      }
      const { means, stds } = computeMeansStds(trMat.X);
      const detWeights = outcome === 'y1' ? DETERMINISTIC_WEIGHTS_1PLUS : DETERMINISTIC_WEIGHTS_2PLUS;
      scoreFn = (row: number[]) => {
        const std = row.map((v, j) => (v - means[j]) / (stds[j] || 1));
        return deterministicScore(std, keys, detWeights);
      };
    } else {
      // LR: chronologically split train into (fit, val) by dates.
      const trainDatesOrdered = [...new Set(trainRows.map((r) => r.target_date))].sort();
      if (trainDatesOrdered.length < 5) {
        return { day: { ...emptyDaily, skip_reason: `LR needs ≥5 training dates; have ${trainDatesOrdered.length}` } };
      }
      const nVal = Math.max(1, Math.floor(trainDatesOrdered.length * args.valFracOfTrain));
      const valDates = new Set(trainDatesOrdered.slice(-nVal));
      const fitRows = trainRows.filter((r) => !valDates.has(r.target_date));
      const valRows = trainRows.filter((r) =>  valDates.has(r.target_date));
      const fitMat = materialise(fitRows, specsForModel);
      const valMat = materialise(valRows, specsForModel);
      if (fitMat.X.length < 100 || valMat.X.length < 20) {
        return { day: { ...emptyDaily, skip_reason: `LR needs ≥100 fit + ≥20 val rows; have fit=${fitMat.X.length} val=${valMat.X.length}` } };
      }
      const yFit = outcome === 'y1' ? fitMat.y1 : fitMat.y2;
      const yVal = outcome === 'y1' ? valMat.y1 : valMat.y2;
      // Guard: LR needs at least one positive AND one negative on both fit/val.
      const okBalance = (y: number[]) => y.some((v) => v === 1) && y.some((v) => v === 0);
      if (!okBalance(yFit) || !okBalance(yVal)) {
        return { day: { ...emptyDaily, skip_reason: 'LR fit/val slice has no positive or no negative outcome' } };
      }
      const { means, stds } = computeMeansStds(fitMat.X);
      const XfitS = standardise(fitMat.X, means, stds);
      const XvalS = standardise(valMat.X, means, stds);
      const fit = trainWithL2Sweep(XfitS, yFit, XvalS, yVal, means, stds);
      scoreFn = (row: number[]) => {
        const std = row.map((v, j) => (v - means[j]) / (stds[j] || 1));
        let z = fit.bias;
        for (let j = 0; j < std.length; j++) z += fit.weights[j] * std[j];
        return sigmoid(z);
      };
      betas = new Map<string, number>();
      for (let j = 0; j < keys.length; j++) betas.set(keys[j], fit.weights[j]);
    }

    // Rank D's slate and compute Top-N.
    const scored = dayMat.X.map((row, i) => ({
      score: scoreFn(row),
      y: outcome === 'y1' ? dayMat.y1[i] : dayMat.y2[i],
    }));
    scored.sort((a, b) => b.score - a.score);
    const top_hits: Record<number, number> = {};
    const top_total: Record<number, number> = {};
    for (const n of TOPN_LIST) {
      const topN = scored.slice(0, n);
      top_hits[n]  = topN.reduce((s, r) => s + r.y, 0);
      top_total[n] = topN.length;
    }
    return {
      day: {
        date: D,
        slate_size: slate.length,
        slate_pos, slate_rate: slate.length > 0 ? slate_pos / slate.length : 0,
        top_hits, top_total,
        scored_rows: dayMat.X.length,
        skipped: false,
      },
      betas,
    };
  }

  console.log(`\n  ── walk-forward evaluation (${CANDIDATE_MODELS.length} candidates × 2 outcomes × ${evalDates.length} dates) ──`);
  const allResults: CandidateResult[] = [];
  for (const cm of CANDIDATE_MODELS) {
    for (const outcome of ['y1', 'y2'] as const) {
      const daily: DailyResult[] = [];
      const betaAcc = new Map<string, { sum: number; n: number }>();
      let fitsOk = 0, fitsSkipped = 0;
      for (const D of evalDates) {
        const { day, betas } = scoreCandidateForDate(cm, outcome, D);
        daily.push(day);
        if (day.skipped) fitsSkipped++; else fitsOk++;
        if (betas) {
          for (const [k, v] of betas) {
            const cur = betaAcc.get(k) ?? { sum: 0, n: 0 };
            cur.sum += v; cur.n += 1;
            betaAcc.set(k, cur);
          }
        }
      }
      const beta_by_feature_avg = cm.kind === 'LR' ? new Map<string, number>() : undefined;
      if (beta_by_feature_avg) {
        for (const [k, v] of betaAcc) beta_by_feature_avg.set(k, v.n > 0 ? v.sum / v.n : 0);
      }
      const features = specsForCandidate(outcome, cm).map((s) => s.key);
      allResults.push({
        id: cm.id, label: cm.label, kind: cm.kind, outcome,
        features, daily, beta_by_feature_avg, fits_ok: fitsOk, fits_skipped: fitsSkipped,
      });
      process.stdout.write('.');
    }
  }
  console.log(' done.\n');

  // ---------- aggregate + reporting helpers ----------

  interface WalkAgg {
    n_test_dates: number;                    // dates the candidate scored (skipped excluded)
    n_dates_skipped: number;
    total_selections: number;                // sum of top_total across scored dates
    total_hits: number;
    top_rate: number;                        // total_hits / total_selections
    slate_baseline: number;                  // weighted mean of slate_rate across scored dates
    abs_lift: number;                        // top_rate − slate_baseline
    rel_lift: number;                        // ratio − 1
    dates_beating_baseline: number;
    dates_beating_baseline_pct: number;
    median_daily_lift: number;
    worst_daily_lift: number;
    ci95: [number, number];
  }

  const BOOTSTRAP_ITERS_V3 = 500;
  function seededRng(seed: number) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

  function aggregateWalk(daily: DailyResult[], n: number): WalkAgg {
    const scored = daily.filter((d) => !d.skipped);
    const skipped = daily.length - scored.length;
    const total_hits = scored.reduce((s, d) => s + d.top_hits[n], 0);
    const total_selections = scored.reduce((s, d) => s + d.top_total[n], 0);
    const totalSlatePos = scored.reduce((s, d) => s + d.slate_pos, 0);
    const totalSlate = scored.reduce((s, d) => s + d.slate_size, 0);
    const slate_baseline = totalSlate > 0 ? totalSlatePos / totalSlate : 0;
    const top_rate = total_selections > 0 ? total_hits / total_selections : 0;
    const daily_top_rates = scored.map((d) => d.top_total[n] > 0 ? d.top_hits[n] / d.top_total[n] : NaN);
    const daily_baselines  = scored.map((d) => d.slate_rate);
    const daily_lifts = daily_top_rates.map((r, i) => Number.isFinite(r) ? r - daily_baselines[i] : NaN).filter((v) => Number.isFinite(v));
    const dates_beating_baseline = daily_lifts.filter((l) => l > 0).length;
    const median_daily_lift = daily_lifts.length > 0
      ? daily_lifts.slice().sort((a, b) => a - b)[Math.floor(daily_lifts.length / 2)]
      : NaN;
    const worst_daily_lift = daily_lifts.length > 0 ? Math.min(...daily_lifts) : NaN;

    // Bootstrap CI over dates.
    const rng = seededRng(4242 + n);
    const samples: number[] = new Array(BOOTSTRAP_ITERS_V3);
    for (let b = 0; b < BOOTSTRAP_ITERS_V3; b++) {
      let h = 0, t = 0;
      for (let i = 0; i < scored.length; i++) {
        const pick = scored[Math.floor(rng() * scored.length)];
        h += pick.top_hits[n]; t += pick.top_total[n];
      }
      samples[b] = t > 0 ? h / t : 0;
    }
    samples.sort((a, b) => a - b);
    const lo = samples[Math.max(0, Math.floor(0.025 * BOOTSTRAP_ITERS_V3))];
    const hi = samples[Math.min(BOOTSTRAP_ITERS_V3 - 1, Math.floor(0.975 * BOOTSTRAP_ITERS_V3))];

    return {
      n_test_dates: scored.length, n_dates_skipped: skipped,
      total_selections, total_hits, top_rate, slate_baseline,
      abs_lift: top_rate - slate_baseline,
      rel_lift: slate_baseline > 0 ? top_rate / slate_baseline - 1 : NaN,
      dates_beating_baseline,
      dates_beating_baseline_pct: daily_lifts.length > 0 ? dates_beating_baseline / daily_lifts.length : 0,
      median_daily_lift, worst_daily_lift,
      ci95: [lo, hi],
    };
  }

  // ---------- Report ----------

  console.log(`\n═══ Walk-forward aggregate lift (bootstrapped 95% CI over test dates, ${BOOTSTRAP_ITERS_V3} iters) ═══\n`);
  for (const outcome of ['y1', 'y2'] as const) {
    const outcomeLabel = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    const rows = allResults.filter((r) => r.outcome === outcome);
    console.log(`── outcome = ${outcomeLabel} ──`);
    console.log(`   ${'candidate'.padEnd(32)}  ${'kind'.padEnd(4)}  ${'topN'.padStart(4)}  ${'topN_hit%'.padStart(9)}  ${'baseline%'.padStart(9)}  ${'abs_lift'.padStart(8)}  ${'rel_lift'.padStart(8)}  ${'dates_beat'.padStart(10)}  ${'med_lift'.padStart(8)}  ${'worst_lift'.padStart(10)}  ${'CI_95%'.padStart(16)}  ${'nD'.padStart(3)}  ${'skp'.padStart(3)}  ${'n(hits/top)'.padStart(11)}`);
    // Sort by Top-5 rate.
    const sorted = rows.slice().sort((a, b) => {
      const av = aggregateWalk(a.daily, 5).top_rate;
      const bv = aggregateWalk(b.daily, 5).top_rate;
      return bv - av;
    });
    for (const r of sorted) {
      for (const n of TOPN_LIST) {
        const a = aggregateWalk(r.daily, n);
        const rel = Number.isFinite(a.rel_lift) ? (a.rel_lift * 100).toFixed(1) + '%' : '  -  ';
        console.log(
          `   ${r.label.slice(0, 32).padEnd(32)}  ${r.kind.padEnd(4)}  ${String(n).padStart(4)}  ${fmtPct(a.top_rate)}  ${fmtPct(a.slate_baseline)}  ${fmtPct(a.abs_lift)}  ${rel.padStart(8)}  ${(a.dates_beating_baseline + '/' + a.n_test_dates + ' (' + (a.dates_beating_baseline_pct * 100).toFixed(0) + '%)').padStart(10)}  ${fmtPct(a.median_daily_lift)}  ${fmtPct(a.worst_daily_lift).padStart(10)}  ${('[' + (a.ci95[0] * 100).toFixed(1) + ', ' + (a.ci95[1] * 100).toFixed(1) + ']').padStart(16)}  ${String(a.n_test_dates).padStart(3)}  ${String(a.n_dates_skipped).padStart(3)}  ${(a.total_hits + '/' + a.total_selections).padStart(11)}`,
        );
      }
      console.log('');
    }
  }

  // Model-stability rankings: per outcome per Top-N, count how often each
  // candidate finished #1 / #2 / #3 across scored dates.
  console.log(`\n═══ Model-stability rankings (per date, sorted candidates by daily Top-5 hit rate) ═══`);
  for (const outcome of ['y1', 'y2'] as const) {
    const label = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    console.log(`\n── outcome = ${label} ──`);
    // For each date, compute per-candidate daily Top-5 rate (score = hits/total,
    // NaN if skipped) then rank candidates.
    const outcomeResults = allResults.filter((r) => r.outcome === outcome);
    const dateRanks = new Map<string, string[]>(); // date → candidate id order (desc by rate)
    for (const D of evalDates) {
      const perCandidate: Array<{ id: string; label: string; rate: number }> = [];
      for (const r of outcomeResults) {
        const d = r.daily.find((x) => x.date === D);
        if (!d || d.skipped || d.top_total[5] === 0) continue;
        perCandidate.push({ id: r.id, label: r.label, rate: d.top_hits[5] / d.top_total[5] });
      }
      if (perCandidate.length === 0) continue;
      perCandidate.sort((a, b) => b.rate - a.rate);
      dateRanks.set(D, perCandidate.map((c) => c.id));
    }
    // Aggregate per-candidate position histograms.
    const positionCounts = new Map<string, number[]>(); // id → [count_pos1, count_pos2, …]
    for (const [, ordered] of dateRanks) {
      for (let pos = 0; pos < ordered.length; pos++) {
        const arr = positionCounts.get(ordered[pos]) ?? new Array(outcomeResults.length).fill(0);
        arr[pos] += 1;
        positionCounts.set(ordered[pos], arr);
      }
    }
    console.log(`   ${'candidate'.padEnd(32)}  ${'#1'.padStart(4)}  ${'#2'.padStart(4)}  ${'#3'.padStart(4)}  ${'#4'.padStart(4)}  ${'#5'.padStart(4)}  ${'#6'.padStart(4)}  ${'ranked_days'.padStart(11)}`);
    for (const r of outcomeResults.sort((a, b) => (positionCounts.get(b.id)?.[0] ?? 0) - (positionCounts.get(a.id)?.[0] ?? 0))) {
      const counts = positionCounts.get(r.id) ?? new Array(6).fill(0);
      const total = counts.reduce((s, c) => s + c, 0);
      console.log(`   ${r.label.slice(0, 32).padEnd(32)}  ${String(counts[0] ?? 0).padStart(4)}  ${String(counts[1] ?? 0).padStart(4)}  ${String(counts[2] ?? 0).padStart(4)}  ${String(counts[3] ?? 0).padStart(4)}  ${String(counts[4] ?? 0).padStart(4)}  ${String(counts[5] ?? 0).padStart(4)}  ${String(total).padStart(11)}`);
    }
    console.log(`   Note: ties broken by candidate order; ranked_days = dates this candidate produced a valid Top-5 ranking.`);
  }

  // LR coefficient averages across walk-forward fits (interpretation).
  console.log(`\n═══ LR average coefficients across walk-forward fits (standardised features) ═══`);
  for (const outcome of ['y1', 'y2'] as const) {
    const label = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    console.log(`\n── outcome = ${label} ──`);
    for (const r of allResults.filter((x) => x.outcome === outcome && x.kind === 'LR')) {
      const avg = r.beta_by_feature_avg;
      if (!avg || avg.size === 0) { console.log(`  ${r.label}  (no valid fits)`); continue; }
      const paired = [...avg.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      console.log(`  ${r.label}  (fits ok: ${r.fits_ok}, skipped: ${r.fits_skipped})`);
      for (const [k, v] of paired.slice(0, 8)) console.log(`    ${k.padEnd(32)}  β̄ = ${v.toFixed(4)}`);
      if (paired.length > 8) console.log(`    … (${paired.length - 8} more)`);
    }
  }

  // Per-date breakdown.
  console.log(`\n═══ Per-test-date breakdown ═══`);
  for (const outcome of ['y1', 'y2'] as const) {
    const label = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    for (const r of allResults.filter((x) => x.outcome === outcome)) {
      console.log(`\n── ${r.label}  [${r.kind}]  outcome=${label} ──`);
      console.log(`   ${'date'.padEnd(11)}  ${'slate'.padStart(6)}  ${'baseline'.padStart(9)}  ${'scored'.padStart(7)}  ${'T3(h/n)'.padStart(9)}  ${'T5(h/n)'.padStart(9)}  ${'T10(h/n)'.padStart(9)}  ${'T25(h/n)'.padStart(10)}  ${'skip_reason'.padEnd(32)}`);
      for (const d of r.daily) {
        const skip = d.skipped ? (d.skip_reason ?? 'skipped') : '';
        const t3  = d.skipped ? '-' : `${d.top_hits[3]}/${d.top_total[3]}`;
        const t5  = d.skipped ? '-' : `${d.top_hits[5]}/${d.top_total[5]}`;
        const t10 = d.skipped ? '-' : `${d.top_hits[10]}/${d.top_total[10]}`;
        const t25 = d.skipped ? '-' : `${d.top_hits[25]}/${d.top_total[25]}`;
        console.log(`   ${d.date.padEnd(11)}  ${String(d.slate_size).padStart(6)}  ${fmtPct(d.slate_rate)}  ${String(d.scored_rows).padStart(7)}  ${t3.padStart(9)}  ${t5.padStart(9)}  ${t10.padStart(9)}  ${t25.padStart(10)}  ${skip.slice(0, 32).padEnd(32)}`);
      }
    }
  }

  console.log(`\n═══ end of calibration report v3 ═══`);
  console.log(`Reading guide:`);
  console.log(`  • Walk-forward: for each eval date D, training was rebuilt from rows on dates < D.`);
  console.log(`    Zero future leakage. Model is fit fresh every date.`);
  console.log(`  • Look for candidates that ALSO have a high dates_beat % AND positive median_lift`);
  console.log(`    AND worst_lift not deeply negative. Persistent lift > one-window burst.`);
  console.log(`  • CI is bootstrapped over TEST DATES (dates resampled with replacement). Wide CIs`);
  console.log(`    at few dates are a sample-size issue, not a model issue — extend backfill.`);
  console.log(`  • Model stability table shows how often each candidate finished #1 across dates.`);
  console.log(`    A candidate with #1 finishes in ~40%+ of dates AND top-of-table aggregate lift is`);
  console.log(`    the right kind of persistent.`);
  console.log(`  • NO candidate should be promoted to live ranking on 2-4 test dates. Wait for the`);
  console.log(`    backfill to widen the walk-forward window meaningfully (≥ 30 test dates).\n`);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n[calibrateHitScore] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
