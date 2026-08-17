/**
 * rebuildPitcherForm(targetDate?) — recompute per-pitcher rate stats
 * from pitcher_starts and upsert into pitcher_form.
 *
 * One row per pitcher (primary key = pitcher_id). Each run overwrites
 * the previous row for that pitcher; historical form snapshots are
 * NOT retained here — pitcher_starts is the audit trail.
 *
 * as_of is set to the input targetDate (defaults to today). Rates are
 * computed from all starts ≤ as_of within the season year.
 *
 * Rates:
 *   k_per_9   = strikeouts * 9 / IP
 *   bb_per_9  = walks      * 9 / IP
 *   h_per_9   = hits       * 9 / IP
 *   hr_per_9  = HR-allowed * 9 / IP
 *   whip      = (walks + hits) / IP
 * All null when starts_known < 3 OR total_ip < 18 (matches the
 * ratesValid guard the HR path uses in snapshotHrTargets.ts:212-219).
 *
 * IMPORTANT — the MLB API's `inningsPitched` field encodes thirds
 * as "6.1" = 6 + 1/3, "6.2" = 6 + 2/3. Naive summation therefore
 * inflates IP for pitchers with lots of 6.1/6.2 lines. This script
 * converts each start to outs, sums outs, then converts back.
 *
 * Isolated from the HR pipeline. HR snapshot code continues to
 * compute K/9 and BB/9 on the fly in snapshotHrTargets.ts and does
 * NOT read from pitcher_form — this is a hits-side consumer table.
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';

/** Only include starts from this many days back — protects the query
 *  from ballooning as multi-season data accumulates. Larger than a
 *  full MLB season, so effectively "this season" for in-season runs. */
const LOAD_LOOKBACK_DAYS = 220;

const MIN_STARTS_FOR_RATES = 3;
const MIN_IP_FOR_RATES = 18;

/** "6.1" (6 + 1/3 IP) → 19 outs. "6.2" → 20 outs. "7.0" → 21. */
export function inningsPitchedToOuts(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n < 0) return 0;
  const whole = Math.floor(n);
  const dec = n - whole; // 0 / 0.1 / 0.2 approx (float error)
  // Round to nearest tenth so 0.09999 → 0.1
  const dec10 = Math.round(dec * 10);
  let extraOuts = 0;
  if (dec10 === 1) extraOuts = 1;
  else if (dec10 === 2) extraOuts = 2;
  else if (dec10 === 0) extraOuts = 0;
  else extraOuts = 0; // unrecognized (shouldn't happen with MLB API values)
  return whole * 3 + extraOuts;
}

export function outsToIpDecimal(outs: number): number {
  const whole = Math.floor(outs / 3);
  const rem = outs % 3; // 0/1/2 → .0/.1/.2
  return Number((whole + rem / 10).toFixed(1));
}

function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

interface PitcherStartLite {
  pitcher_id: number;
  pitcher_name: string | null;
  pitcher_hand: string | null;
  game_date: string;
  innings_pitched: number | null;
  hits_allowed: number | null;
  walks: number | null;
  strikeouts: number | null;
  home_runs_allowed: number | null;
}

async function loadPitcherStarts(fromDate: string, toDate: string): Promise<PitcherStartLite[]> {
  const out: PitcherStartLite[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supabaseAdmin
      .from('pitcher_starts')
      .select('pitcher_id, pitcher_name, pitcher_hand, game_date, innings_pitched, hits_allowed, walks, strikeouts, home_runs_allowed')
      .gte('game_date', fromDate)
      .lte('game_date', toDate)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`select pitcher_starts: ${error.message}`);
    const rows = (data ?? []) as PitcherStartLite[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export interface PitcherFormResult {
  targetDate: string;
  pitchersWritten: number;
  pitchersSkippedNoStarts: number;
  loadWindowDays: number;
  minStartsForRates: number;
  minIpForRates: number;
}

export async function rebuildPitcherForm(targetDate?: string): Promise<PitcherFormResult> {
  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  const loadFrom = addDays(date, -(LOAD_LOOKBACK_DAYS - 1));
  console.log(`[rebuildPitcherForm] target=${date} load=[${loadFrom}..${date}]`);

  const starts = await loadPitcherStarts(loadFrom, date);
  console.log(`[rebuildPitcherForm]   loaded ${starts.length} starts`);
  if (starts.length === 0) {
    return { targetDate: date, pitchersWritten: 0, pitchersSkippedNoStarts: 0, loadWindowDays: LOAD_LOOKBACK_DAYS, minStartsForRates: MIN_STARTS_FOR_RATES, minIpForRates: MIN_IP_FOR_RATES };
  }

  const byPitcher = new Map<number, PitcherStartLite[]>();
  for (const s of starts) {
    const arr = byPitcher.get(s.pitcher_id) ?? [];
    arr.push(s);
    byPitcher.set(s.pitcher_id, arr);
  }

  const rows: any[] = [];
  let skipped = 0;
  for (const [pitcher_id, allStarts] of byPitcher) {
    // Sort newest first — we take head slices for L3/L5 rollups.
    allStarts.sort((a, b) => b.game_date.localeCompare(a.game_date));

    const starts_known = allStarts.length;
    if (starts_known === 0) { skipped++; continue; }

    const totalOuts = allStarts.reduce((s, r) => s + inningsPitchedToOuts(r.innings_pitched), 0);
    const total_ip = outsToIpDecimal(totalOuts);
    const totalIpFloat = totalOuts / 3;

    const total_hits_allowed = allStarts.reduce((s, r) => s + (Number(r.hits_allowed) || 0), 0);
    const total_walks        = allStarts.reduce((s, r) => s + (Number(r.walks) || 0), 0);
    const total_strikeouts   = allStarts.reduce((s, r) => s + (Number(r.strikeouts) || 0), 0);
    const total_hr_allowed   = allStarts.reduce((s, r) => s + (Number(r.home_runs_allowed) || 0), 0);

    const ratesValid = starts_known >= MIN_STARTS_FOR_RATES && totalIpFloat >= MIN_IP_FOR_RATES;
    const k_per_9  = ratesValid ? (total_strikeouts * 9) / totalIpFloat : null;
    const bb_per_9 = ratesValid ? (total_walks      * 9) / totalIpFloat : null;
    const h_per_9  = ratesValid ? (total_hits_allowed * 9) / totalIpFloat : null;
    const hr_per_9 = ratesValid ? (total_hr_allowed * 9) / totalIpFloat : null;
    const whip     = ratesValid ? (total_walks + total_hits_allowed) / totalIpFloat : null;

    const last3 = allStarts.slice(0, 3);
    const last5 = allStarts.slice(0, 5);
    const hits_l3_starts = last3.reduce((s, r) => s + (Number(r.hits_allowed) || 0), 0);
    const hits_l5_starts = last5.reduce((s, r) => s + (Number(r.hits_allowed) || 0), 0);
    const ip_l3_starts   = outsToIpDecimal(last3.reduce((s, r) => s + inningsPitchedToOuts(r.innings_pitched), 0));
    const ip_l5_starts   = outsToIpDecimal(last5.reduce((s, r) => s + inningsPitchedToOuts(r.innings_pitched), 0));

    rows.push({
      pitcher_id,
      pitcher_name: allStarts[0].pitcher_name,
      pitcher_throws: allStarts[0].pitcher_hand,
      as_of: date,
      starts_known,
      total_ip,
      total_hits_allowed,
      total_walks,
      total_strikeouts,
      total_hr_allowed,
      h_per_9,
      k_per_9,
      bb_per_9,
      hr_per_9,
      whip,
      hits_l3_starts, hits_l5_starts,
      ip_l3_starts,   ip_l5_starts,
      last_start_date: allStarts[0].game_date,
      updated_at: new Date().toISOString(),
    });
  }

  // Upsert.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from('pitcher_form')
      .upsert(slice, { onConflict: 'pitcher_id' });
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        throw new Error('pitcher_form table missing — apply migration 020 first.');
      }
      throw new Error(`upsert pitcher_form failed: ${error.message}`);
    }
  }

  console.log(`[rebuildPitcherForm] wrote ${rows.length} rows for ${date} (${skipped} skipped)`);
  return {
    targetDate: date, pitchersWritten: rows.length, pitchersSkippedNoStarts: skipped,
    loadWindowDays: LOAD_LOOKBACK_DAYS, minStartsForRates: MIN_STARTS_FOR_RATES, minIpForRates: MIN_IP_FOR_RATES,
  };
}
