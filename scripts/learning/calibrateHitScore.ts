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

  // 10. Ablation configuration.
  //
  // Every ablation runs on the SAME chronological split. Deterministic
  // scoring uses the appropriate 1+/2+ weight preset with any dropped
  // features contributing zero. LR is retrained per-ablation on the
  // reduced feature set.
  //
  // "drop" is a list of feature keys to remove from the full set for this
  // ablation. Empty = full model. "keepOnly" (when set) overrides drop
  // and restricts to exactly the listed keys.
  interface AblationConfig {
    id: string;
    label: string;
    drop?: string[];
    keepOnly?: string[];  // for opportunity-only
  }
  const ABLATIONS: AblationConfig[] = [
    { id: 'full',            label: 'Full (all features)' },
    { id: 'no_weather',      label: 'No weather (drop temp + wind)',
      drop: ['weather_temp_f', 'weather_wind_mph'] },
    { id: 'no_volume',       label: 'No recent volume (drop hits_l7d + ab_l7d)',
      drop: ['hits_l7d_asof', 'ab_l7d_asof'] },
    { id: 'no_rate',         label: 'No recent rate (drop hit_rate_l7d)',
      drop: ['hit_rate_l7d_asof'] },
    { id: 'no_whip',         label: 'No pitcher WHIP (keep H/9 + BB/9)',
      drop: ['pitcher_whip_asof'] },
    { id: 'opportunity',     label: 'Opportunity-only (contact + PA + K + pitcher H9/K9)',
      keepOnly: [
        'season_avg_asof', 'expected_pa',
        'season_k_rate_asof', 'recent_k_rate_asof',
        'pitcher_h_per_9_asof', 'pitcher_k_per_9_asof',
        'platoon_hit_rate_asof',
        'multi_hit_rate_l10g_asof',
      ] },
  ];

  function specsForAblation(
    outcome: 'y1' | 'y2', abl: AblationConfig,
  ): FeatureSpec[] {
    const base = outcome === 'y1'
      ? specs.filter((s) => s.common)
      : specs.filter((s) => s.common || s.twoPlusOnly);
    if (abl.keepOnly) return base.filter((s) => abl.keepOnly!.includes(s.key));
    if (abl.drop)     return base.filter((s) => !abl.drop!.includes(s.key));
    return base;
  }

  // ---------- Per-test-date metrics ----------
  interface DailyRow {
    date: string;
    slate_size: number;                   // number of players on the slate that day
    slate_pos: number;                    // number who actually satisfied the outcome
    slate_rate: number;                   // slate_pos / slate_size (baseline for this date)
    top_hits: Record<number, number>;     // {3: hits, 5: hits, 10: hits, 25: hits}
    top_total: Record<number, number>;
  }

  // Compute FULL-slate baseline per test date ONCE, using every filtered
  // starter row on that date regardless of which config could score them.
  // This makes ablation lift comparable across configs — a config that
  // drops rows for missing features doesn't get an easier baseline.
  function fullSlateBaselines(outcome: 'y1' | 'y2'): Map<string, { size: number; pos: number }> {
    const out = new Map<string, { size: number; pos: number }>();
    for (const r of testRows) {
      const y = outcome === 'y1' ? r.y1 : r.y2;
      const cur = out.get(r.target_date) ?? { size: 0, pos: 0 };
      cur.size += 1;
      cur.pos += y;
      out.set(r.target_date, cur);
    }
    return out;
  }
  const slateBaselineY1 = fullSlateBaselines('y1');
  const slateBaselineY2 = fullSlateBaselines('y2');

  function dailyBreakdown(
    rows: Row[], scores: number[], y: number[], outcome: 'y1' | 'y2',
  ): DailyRow[] {
    const byDate = new Map<string, { s: number; y: number }[]>();
    for (let i = 0; i < rows.length; i++) {
      const arr = byDate.get(rows[i].target_date) ?? [];
      arr.push({ s: scores[i], y: y[i] });
      byDate.set(rows[i].target_date, arr);
    }
    const baselineMap = outcome === 'y1' ? slateBaselineY1 : slateBaselineY2;
    const out: DailyRow[] = [];
    for (const [d, arr] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = arr.slice().sort((a, b) => b.s - a.s);
      const top_hits: Record<number, number> = {};
      const top_total: Record<number, number> = {};
      for (const n of TOPN_LIST) {
        const topN = sorted.slice(0, n);
        top_hits[n]  = topN.reduce((s, r) => s + r.y, 0);
        top_total[n] = topN.length;
      }
      // Baseline from the full slate, not the config's subset.
      const bl = baselineMap.get(d) ?? { size: arr.length, pos: arr.reduce((s, r) => s + r.y, 0) };
      out.push({
        date: d, slate_size: bl.size, slate_pos: bl.pos,
        slate_rate: bl.size > 0 ? bl.pos / bl.size : 0,
        top_hits, top_total,
      });
    }
    return out;
  }

  // Aggregate lift metrics + bootstrap 95% CI over test DATES (units of
  // variation — resampling rows would hide within-date correlation).
  interface LiftStats {
    topN: number;
    top_rate: number;
    base_rate: number;
    abs_lift: number;
    rel_lift: number;
    ci95_top_rate: [number, number];
    total_top: number;
    total_hits: number;
    n_dates: number;
  }
  const BOOTSTRAP_ITERS = 500;
  const BOOTSTRAP_SEED = 1234;
  function seededRng(seed: number) {
    let s = seed;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  }

  function aggregate(daily: DailyRow[], n: number): LiftStats {
    const totalHits  = daily.reduce((s, d) => s + d.top_hits[n], 0);
    const totalTop   = daily.reduce((s, d) => s + d.top_total[n], 0);
    const baseHits   = daily.reduce((s, d) => s + d.slate_pos, 0);
    const baseTotal  = daily.reduce((s, d) => s + d.slate_size, 0);
    const top_rate  = totalTop > 0  ? totalHits / totalTop  : 0;
    const base_rate = baseTotal > 0 ? baseHits  / baseTotal : 0;
    // Bootstrap over dates.
    const rng = seededRng(BOOTSTRAP_SEED + n);
    const samples: number[] = new Array(BOOTSTRAP_ITERS);
    for (let b = 0; b < BOOTSTRAP_ITERS; b++) {
      let h = 0, t = 0;
      for (let i = 0; i < daily.length; i++) {
        const pick = daily[Math.floor(rng() * daily.length)];
        h += pick.top_hits[n]; t += pick.top_total[n];
      }
      samples[b] = t > 0 ? h / t : 0;
    }
    samples.sort((a, b) => a - b);
    const lo = samples[Math.max(0, Math.floor(0.025 * BOOTSTRAP_ITERS))];
    const hi = samples[Math.min(BOOTSTRAP_ITERS - 1, Math.floor(0.975 * BOOTSTRAP_ITERS))];
    return {
      topN: n, top_rate, base_rate,
      abs_lift: top_rate - base_rate,
      rel_lift: base_rate > 0 ? top_rate / base_rate - 1 : NaN,
      ci95_top_rate: [lo, hi],
      total_top: totalTop, total_hits: totalHits,
      n_dates: daily.length,
    };
  }

  // ---------- Runner ----------
  interface RunResult {
    id: string;
    label: string;
    outcome: 'y1' | 'y2';
    kind: 'LR' | 'DET';
    features: string[];
    n_train_rows: number; n_val_rows: number; n_test_rows: number;
    train_loss?: number; val_loss?: number; test_loss?: number;
    train_auc?: number; val_auc?: number; test_auc?: number;
    coefficients?: Array<{ key: string; beta: number }>;
    l2Used?: number; epochs?: number;
    daily: DailyRow[];
    aggregate: Record<number, LiftStats>;  // {3, 5, 10, 25}
  }

  function evalOn(rowsMat: { X: number[][]; y1: number[]; y2: number[]; rows: Row[] }, scoreFn: (r: number[]) => number, outcome: 'y1' | 'y2') {
    const y = outcome === 'y1' ? rowsMat.y1 : rowsMat.y2;
    const scores = rowsMat.X.map((r) => scoreFn(r));
    const daily = dailyBreakdown(rowsMat.rows, scores, y, outcome);
    const aggByN: Record<number, LiftStats> = {};
    for (const n of TOPN_LIST) aggByN[n] = aggregate(daily, n);
    return { daily, aggregate: aggByN, scores, y };
  }

  async function runConfig(abl: AblationConfig, outcome: 'y1' | 'y2'): Promise<RunResult[]> {
    const specsForModel = specsForAblation(outcome, abl);
    const keys = specsForModel.map((s) => s.key);
    const tr = materialise(trainRows, specsForModel);
    const va = materialise(valRows, specsForModel);
    const te = materialise(testRows, specsForModel);
    const label = abl.label;
    if (tr.X.length < 50 || va.X.length < 20 || te.X.length < 20) {
      console.log(`  ${abl.id}/${outcome}: INSUFFICIENT DATA (train=${tr.X.length} val=${va.X.length} test=${te.X.length}) — skipped`);
      return [];
    }
    const { means, stds } = computeMeansStds(tr.X);
    const XtrS = standardise(tr.X, means, stds);
    const XvaS = standardise(va.X, means, stds);
    const XteS = standardise(te.X, means, stds);
    const ytr = outcome === 'y1' ? tr.y1 : tr.y2;
    const yva = outcome === 'y1' ? va.y1 : va.y2;
    const yte = outcome === 'y1' ? te.y1 : te.y2;

    // --- LR ---
    const fit = trainWithL2Sweep(XtrS, ytr, XvaS, yva, means, stds);
    const trPred = predict(XtrS, fit.weights, fit.bias);
    const vaPred = predict(XvaS, fit.weights, fit.bias);
    const tePred = predict(XteS, fit.weights, fit.bias);
    const lrRes = evalOn({ X: XteS, y1: te.y1, y2: te.y2, rows: te.rows }, (r) => {
      let z = fit.bias; for (let j = 0; j < r.length; j++) z += fit.weights[j] * r[j]; return sigmoid(z);
    }, outcome);
    const lrResult: RunResult = {
      id: abl.id, label, outcome, kind: 'LR',
      features: keys,
      n_train_rows: tr.X.length, n_val_rows: va.X.length, n_test_rows: te.X.length,
      train_loss: fit.finalTrainLoss, val_loss: fit.finalValLoss,
      test_loss: logLoss(XteS, yte, fit.weights, fit.bias, 0),
      train_auc: auc(trPred, ytr), val_auc: auc(vaPred, yva), test_auc: auc(tePred, yte),
      coefficients: keys.map((k, i) => ({ key: k, beta: fit.weights[i] })).sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta)),
      l2Used: fit.l2Used, epochs: fit.epochs,
      daily: lrRes.daily, aggregate: lrRes.aggregate,
    };

    // --- Deterministic (uses same standardised test features + preset weights) ---
    const detWeights = outcome === 'y1' ? DETERMINISTIC_WEIGHTS_1PLUS : DETERMINISTIC_WEIGHTS_2PLUS;
    const detRes = evalOn({ X: XteS, y1: te.y1, y2: te.y2, rows: te.rows }, (r) => deterministicScore(r, keys, detWeights), outcome);
    const detResult: RunResult = {
      id: abl.id, label, outcome, kind: 'DET',
      features: keys,
      n_train_rows: tr.X.length, n_val_rows: va.X.length, n_test_rows: te.X.length,
      test_auc: auc(detRes.scores, detRes.y),
      daily: detRes.daily, aggregate: detRes.aggregate,
    };
    return [lrResult, detResult];
  }

  // 11. Run full grid: 6 ablations × 2 outcomes × 2 kinds (LR + DET) = 24 configs.
  console.log(`\n  ── Running ablation grid (${ABLATIONS.length} ablations × 2 outcomes × 2 kinds = ${ABLATIONS.length * 4} configs) ──`);
  const allResults: RunResult[] = [];
  for (const abl of ABLATIONS) {
    for (const outcome of ['y1', 'y2'] as const) {
      const results = await runConfig(abl, outcome);
      allResults.push(...results);
    }
  }

  // ---------- REPORT ----------
  // Table 1: aggregate lift table sorted by outcome then Top-5 rate.
  function fmtPct(x: number): string { return Number.isFinite(x) ? (x * 100).toFixed(1).padStart(5) + '%' : '  -  '.padStart(6); }
  function fmtCI(ci: [number, number]): string { return `[${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`; }

  console.log(`\n═══ Aggregate lift table (bootstrapped 95% CI over test dates, ${BOOTSTRAP_ITERS} iters) ═══\n`);
  for (const outcome of ['y1', 'y2'] as const) {
    const outcomeLabel = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    const rows = allResults.filter((r) => r.outcome === outcome);
    const baseRate = rows[0]?.aggregate[5]?.base_rate ?? NaN;
    console.log(`── outcome = ${outcomeLabel}  (test slate baseline = ${(baseRate * 100).toFixed(1)}%) ──`);
    console.log(`   ${'config'.padEnd(32)}  ${'kind'.padEnd(4)}  ${'topN'.padStart(4)}  ${'topN_hit%'.padStart(9)}  ${'abs_lift'.padStart(8)}  ${'rel_lift'.padStart(8)}  ${'CI_95%'.padStart(16)}  ${'n(hits/top)'.padStart(11)}`);
    // Sort by test Top-5 rate desc so best rows float up.
    const sorted = rows.slice().sort((a, b) => (b.aggregate[5]?.top_rate ?? 0) - (a.aggregate[5]?.top_rate ?? 0));
    for (const r of sorted) {
      for (const n of TOPN_LIST) {
        const a = r.aggregate[n];
        if (!a) continue;
        const rel = Number.isFinite(a.rel_lift) ? (a.rel_lift * 100).toFixed(1) + '%' : '  -  ';
        console.log(
          `   ${(r.label.slice(0, 32)).padEnd(32)}  ${r.kind.padEnd(4)}  ${String(n).padStart(4)}  ${fmtPct(a.top_rate)}  ${fmtPct(a.abs_lift)}  ${rel.padStart(8)}  ${fmtCI(a.ci95_top_rate).padStart(16)}  ${String(`${a.total_hits}/${a.total_top}`).padStart(11)}`,
        );
      }
      console.log('');
    }
  }

  // Table 2: coefficients for LR models (all ablations).
  console.log(`\n═══ LR coefficients per ablation (standardised features) ═══`);
  for (const outcome of ['y1', 'y2'] as const) {
    const label = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    console.log(`\n── outcome = ${label} ──`);
    for (const r of allResults.filter((x) => x.outcome === outcome && x.kind === 'LR')) {
      console.log(`  ${r.label}   (L2=${r.l2Used}, epochs=${r.epochs}, train/val/test loss=${r.train_loss?.toFixed(3)}/${r.val_loss?.toFixed(3)}/${r.test_loss?.toFixed(3)}, AUC test=${r.test_auc?.toFixed(3)})`);
      for (const c of (r.coefficients ?? []).slice(0, 8)) console.log(`    ${c.key.padEnd(32)}  β = ${c.beta.toFixed(4)}`);
      if ((r.coefficients?.length ?? 0) > 8) console.log(`    … (${(r.coefficients?.length ?? 0) - 8} more)`);
    }
  }

  // Table 3: per-test-date breakdown. Emit for every config so the user
  // can see stability across dates (this is the point of the exercise).
  console.log(`\n═══ Per-test-date breakdown ═══`);
  for (const outcome of ['y1', 'y2'] as const) {
    const label = outcome === 'y1' ? 'hits ≥ 1' : 'hits ≥ 2';
    for (const r of allResults.filter((x) => x.outcome === outcome)) {
      console.log(`\n── ${r.label}  [${r.kind}]  outcome=${label} ──`);
      console.log(`   ${'date'.padEnd(11)}  ${'slate'.padStart(6)}  ${'baseline'.padStart(9)}  ${'T3(h/n)'.padStart(9)}  ${'T5(h/n)'.padStart(9)}  ${'T10(h/n)'.padStart(9)}  ${'T25(h/n)'.padStart(10)}`);
      for (const d of r.daily) {
        const t3 = `${d.top_hits[3]}/${d.top_total[3]}`;
        const t5 = `${d.top_hits[5]}/${d.top_total[5]}`;
        const t10 = `${d.top_hits[10]}/${d.top_total[10]}`;
        const t25 = `${d.top_hits[25]}/${d.top_total[25]}`;
        console.log(`   ${d.date.padEnd(11)}  ${String(d.slate_size).padStart(6)}  ${fmtPct(d.slate_rate)}  ${t3.padStart(9)}  ${t5.padStart(9)}  ${t10.padStart(9)}  ${t25.padStart(10)}`);
      }
    }
  }

  console.log(`\n═══ end of calibration report v2 ═══`);
  console.log(`Reading guide:`);
  console.log(`  • Aggregate lift table sorted by Top-5 rate within each outcome — top rows are the`);
  console.log(`    most-promising rankers. Absolute lift is (Top-N% − slate baseline%). Relative lift`);
  console.log(`    is Top-N% / baseline% − 1.`);
  console.log(`  • Bootstrap CI is over TEST DATES (units of variation), 500 iters. Wide CIs on 4-6`);
  console.log(`    dates are expected — that's a sample-size problem, not a scoring problem. Reruning`);
  console.log(`    after a wider batting-line backfill is the fix.`);
  console.log(`  • Compare DET (deterministic 2+ investigation) against LR row-for-row on the same`);
  console.log(`    ablation. If DET wins on multiple ablations, that's evidence the deterministic`);
  console.log(`    preset is genuinely capturing signal — not just a lucky sample.`);
  console.log(`  • Ablations that MATCH or BEAT 'full' with fewer features are the safer choice for`);
  console.log(`    v1 — same lift, lower overfitting risk.\n`);
}

const __filename = fileURLToPath(import.meta.url);
if (__filename === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n[calibrateHitScore] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
