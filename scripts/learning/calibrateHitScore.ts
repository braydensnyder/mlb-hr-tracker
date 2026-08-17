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
  trainFrac: number;
  valFrac: number;
  minPriorGames: number;
  dropPlatoon: boolean;
}
function parseArgs(argv: string[]): Args {
  let from: string | null = null;
  let to = mlbToday();
  let last: number | null = null;
  let trainFrac = DEFAULT_TRAIN;
  let valFrac = DEFAULT_VAL;
  let minPriorGames = MIN_PRIOR_GAMES;
  let dropPlatoon = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else if (a === '--last') last = Number(argv[++i]);
    else if (a === '--train') trainFrac = Number(argv[++i]);
    else if (a === '--val') valFrac = Number(argv[++i]);
    else if (a === '--min-prior-games') minPriorGames = Number(argv[++i]);
    else if (a === '--drop-platoon') dropPlatoon = true;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) { from = to = a; }
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!from) from = mlbAddDays(to, -((last ?? DEFAULT_LAST_DAYS) - 1));
  if (from > to) throw new Error(`--from > --to`);
  if (trainFrac <= 0 || trainFrac >= 1) throw new Error('--train in (0,1)');
  if (valFrac <= 0 || valFrac >= 1 - trainFrac) throw new Error('--val must leave room for test');
  return { from, to, trainFrac, valFrac, minPriorGames, dropPlatoon };
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

// ---------- Deterministic Hit Score (for comparison baseline) ----------
//
// Rounded, interpretable weights. Same feature set as the LR contact-first
// list. Score = weighted sum of z-scored features (train-set μ/σ), then
// sigmoid → probability. Not optimised, purely a "if we didn't calibrate
// at all, how would rounded intuition do?" baseline.
const DETERMINISTIC_WEIGHTS: Record<string, number> = {
  season_avg_asof:        6,
  hit_rate_l7d_asof:      3,
  hits_l7d_asof:          1,
  expected_pa:            5,
  season_k_rate_asof:    -3,
  recent_k_rate_asof:    -2,
  pitcher_h_per_9_asof:   3,
  pitcher_whip_asof:      2,
  pitcher_k_per_9_asof:  -3,
  pitcher_bb_per_9_asof:  1,
  platoon_hit_rate_asof:  1,
  weather_temp_f:         0.5,
  weather_wind_mph:       0,
  multi_hit_rate_l10g_asof: 0,   // deterministic 1+; the 2+ variant flips a few of these
};

function deterministicScore(row: number[], keys: string[]): number {
  let s = 0;
  for (let i = 0; i < keys.length; i++) s += (DETERMINISTIC_WEIGHTS[keys[i]] ?? 0) * row[i];
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
  console.log(`\n═══ Hit Score calibration ═══`);
  console.log(`  range: ${args.from} .. ${args.to}`);
  console.log(`  train/val/test fractions: ${args.trainFrac} / ${args.valFrac} / ${(1 - args.trainFrac - args.valFrac).toFixed(3)}`);
  console.log(`  min prior games required: ${args.minPriorGames}`);

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

  // 6. Platoon coverage decision.
  const platoonPresent = filtered.filter((r) => r.has_platoon).length;
  const platoonPct = filtered.length > 0 ? platoonPresent / filtered.length : 0;
  const keepPlatoon = !args.dropPlatoon && platoonPct >= MIN_PLATOON_COVERAGE;
  console.log(`\n  platoon coverage: ${(platoonPct * 100).toFixed(1)}% (${platoonPresent}/${filtered.length}) — ${keepPlatoon ? 'KEEP' : 'DROP'} (threshold ${(MIN_PLATOON_COVERAGE * 100).toFixed(0)}%)`);

  // 7. Chronological split.
  const dates = [...new Set(filtered.map((r) => r.target_date))].sort();
  const nTrainDates = Math.floor(dates.length * args.trainFrac);
  const nValDates = Math.floor(dates.length * args.valFrac);
  const trainDates = new Set(dates.slice(0, nTrainDates));
  const valDates   = new Set(dates.slice(nTrainDates, nTrainDates + nValDates));
  const testDates  = new Set(dates.slice(nTrainDates + nValDates));
  const trainRows = filtered.filter((r) => trainDates.has(r.target_date));
  const valRows   = filtered.filter((r) => valDates.has(r.target_date));
  const testRows  = filtered.filter((r) => testDates.has(r.target_date));
  console.log(`\n  chronological split:`);
  console.log(`    train: ${trainDates.size} dates, ${trainRows.length} rows  [${[...trainDates][0]} .. ${[...trainDates].pop()}]`);
  console.log(`    val:   ${valDates.size} dates, ${valRows.length} rows  [${[...valDates][0]} .. ${[...valDates].pop()}]`);
  console.log(`    test:  ${testDates.size} dates, ${testRows.length} rows  [${[...testDates][0]} .. ${[...testDates].pop()}]`);

  const specs = baseFeatureSpecs(keepPlatoon);
  const keys = specs.map((s) => s.key);

  // 8. Exploratory correlations against y1 and y2 (Pearson on train only,
  //    dropping rows with null on that feature per column).
  console.log(`\n  ── exploratory correlations (train only; per-feature drops missing rows) ──`);
  console.log(`    ${'feature'.padEnd(32)}  ${'n_train'.padStart(8)}  ${'corr(y1)'.padStart(9)}  ${'corr(y2)'.padStart(9)}`);
  for (const s of specs) {
    const xs: number[] = []; const y1s: number[] = []; const y2s: number[] = [];
    for (const r of trainRows) {
      const v = s.extract(r);
      if (v == null || !Number.isFinite(v)) continue;
      xs.push(v); y1s.push(r.y1); y2s.push(r.y2);
    }
    const c1 = pearson(xs, y1s);
    const c2 = pearson(xs, y2s);
    console.log(`    ${s.key.padEnd(32)}  ${String(xs.length).padStart(8)}  ${(Number.isFinite(c1) ? c1.toFixed(3) : '  -  ').padStart(9)}  ${(Number.isFinite(c2) ? c2.toFixed(3) : '  -  ').padStart(9)}`);
  }

  // 9. Materialise feature matrices. Rows with ANY null feature (for the
  //    chosen model) are DROPPED — never zero-filled.
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

  async function trainAndReport(label: string, outcome: 'y1' | 'y2', specsForModel: FeatureSpec[]) {
    const modelKeys = specsForModel.map((s) => s.key);
    const tr = materialise(trainRows, specsForModel);
    const va = materialise(valRows, specsForModel);
    const te = materialise(testRows, specsForModel);
    if (tr.X.length < 100 || va.X.length < 30 || te.X.length < 30) {
      console.log(`\n  ── ${label}: INSUFFICIENT DATA (train=${tr.X.length} val=${va.X.length} test=${te.X.length}) — skipped`);
      return;
    }
    const { means, stds } = computeMeansStds(tr.X);
    const XtrS = standardise(tr.X, means, stds);
    const XvaS = standardise(va.X, means, stds);
    const XteS = standardise(te.X, means, stds);

    const ytr = outcome === 'y1' ? tr.y1 : tr.y2;
    const yva = outcome === 'y1' ? va.y1 : va.y2;
    const yte = outcome === 'y1' ? te.y1 : te.y2;

    const fit = trainWithL2Sweep(XtrS, ytr, XvaS, yva, means, stds);

    console.log(`\n  ── ${label}: logistic (outcome=${outcome === 'y1' ? 'hits≥1' : 'hits≥2'}) ──`);
    console.log(`    features (${modelKeys.length}): ${modelKeys.join(', ')}`);
    console.log(`    L2 chosen: ${fit.l2Used}  ·  epochs: ${fit.epochs}`);
    console.log(`    losses: train=${fit.finalTrainLoss.toFixed(4)}  val=${fit.finalValLoss.toFixed(4)}  test=${logLoss(XteS, yte, fit.weights, fit.bias, 0).toFixed(4)}`);
    const trPred = predict(XtrS, fit.weights, fit.bias);
    const vaPred = predict(XvaS, fit.weights, fit.bias);
    const tePred = predict(XteS, fit.weights, fit.bias);
    console.log(`    AUC:    train=${auc(trPred, ytr).toFixed(3)}  val=${auc(vaPred, yva).toFixed(3)}  test=${auc(tePred, yte).toFixed(3)}`);

    console.log(`    standardised coefficients (larger |β| = stronger effect after z-scoring):`);
    const paired = modelKeys.map((k, i) => ({ k, b: fit.weights[i] })).sort((a, b) => Math.abs(b.b) - Math.abs(a.b));
    for (const p of paired) console.log(`      ${p.k.padEnd(32)}  β = ${p.b.toFixed(4)}`);
    console.log(`      (bias                              β = ${fit.bias.toFixed(4)})`);

    console.log(`    Top-N hit rate on TEST dates:`);
    for (const n of TOPN_LIST) {
      const stats = topNHitRate(te.rows, tePred, yte, n);
      console.log(`      Top-${String(n).padStart(2)}  →  ${stats.hits}/${stats.total} = ${(stats.rate * 100).toFixed(1)}%`);
    }

    // Deterministic score comparison on the same test rows.
    const detScores = XteS.map((r) => deterministicScore(r, modelKeys));
    console.log(`    Deterministic baseline (rounded weights, same features, sigmoid transform):`);
    console.log(`      AUC(test) = ${auc(detScores, yte).toFixed(3)}`);
    for (const n of TOPN_LIST) {
      const stats = topNHitRate(te.rows, detScores, yte, n);
      console.log(`      Top-${String(n).padStart(2)}  →  ${stats.hits}/${stats.total} = ${(stats.rate * 100).toFixed(1)}%`);
    }
  }

  // 10. Train + report both models.
  // For 1+ we keep every common feature; for 2+ we also include multi_hit rate.
  const specs1Plus = specs.filter((s) => s.common);
  const specs2Plus = specs.filter((s) => s.common || s.twoPlusOnly);
  await trainAndReport('LR(1+)', 'y1', specs1Plus);
  await trainAndReport('LR(2+)', 'y2', specs2Plus);

  console.log(`\n═══ end of calibration report ═══`);
  console.log(`Reading guide:`);
  console.log(`  • The primary decision metric is Top-N hit rate on TEST — nothing else.`);
  console.log(`  • AUC is a secondary sanity check (0.5 = random, 0.7+ = solid for binary game outcomes).`);
  console.log(`  • Standardised β sign/magnitude are for interpretability, not for pasting into a`);
  console.log(`    live scoring formula. To score a live row: standardise its features with the same`);
  console.log(`    μ/σ from training, then apply β · x + bias, then sigmoid.`);
  console.log(`  • Correlations are exploratory — a low correlation may still contribute inside`);
  console.log(`    the LR through joint effects, and a high correlation may be redundant.\n`);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n[calibrateHitScore] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
