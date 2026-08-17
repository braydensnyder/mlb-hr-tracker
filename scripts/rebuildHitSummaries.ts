/**
 * rebuildHitSummaries(targetDate?) — materialise per-player rolling
 * hit-side stats from player_batting_lines into player_daily_hit_summary.
 *
 * One row per (summary_date, player_id) for every player with at least
 * one batting line in the last ACTIVITY_WINDOW_DAYS ≤ targetDate. Older
 * / less-active players are omitted so the table stays sparse.
 *
 * Rolling windows (all anchored at summary_date):
 *   hits_l3g, ab_l3g, hit_rate_l3g   — last 3 games player appeared in
 *   hits_l5g, ab_l5g, hit_rate_l5g   — last 5 games appeared
 *   hits_l7d, ab_l7d, pa_l7d, hit_rate_l7d, doubles_l7d, walks_l7d,
 *   strikeout_rate_l7d               — last 7 calendar days
 *   hits_l14d                        — last 14 calendar days
 *   triples_l14d                     — last 14 calendar days
 *   multi_hit_games_l5g, multi_hit_games_l10g  — count of games with hits >= 2
 *
 * Platoon splits (season-to-date, starter-hand attribution per mig 020):
 *   hits_vs_lhp_starters, ab_vs_lhp_starters
 *   hits_vs_rhp_starters, ab_vs_rhp_starters
 *
 * Season slash pulled directly from players.season_avg / season_obp /
 * season_slg / season_ops when present.
 *
 * If underlying data is thin for a field (e.g. no games in last 3 for
 * hit_rate_l3g), the field is null AND we push a flag string into
 * `flags` explaining why. Downstream must never treat a null as zero.
 *
 * Isolated from the HR pipeline. This script can fail without breaking
 * anything HR-side (caller wraps in try/catch — see updateDaily.ts).
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';

/** Games-back window that gates whether a player gets a row at all.
 *  Any player with zero batting lines in the last N days ≤ target_date
 *  is skipped — no summary row is written. */
const ACTIVITY_WINDOW_DAYS = 21;

/** How much history to load for rolling-window computation. Slightly
 *  larger than the largest window (l14d) so a player's most-recent-5
 *  games can still be found even if they were skipping around. */
const LOAD_WINDOW_DAYS = 60;

/** Season boundary — anchor by target_date's year. Used for platoon
 *  season-to-date aggregation and season_avg fallback. */
function seasonStart(targetDate: string): string {
  return `${targetDate.slice(0, 4)}-01-01`;
}

export function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

interface BattingLineLite {
  target_date: string;
  player_id: number;
  player_name: string;
  team: string;
  at_bats: number;
  hits: number;
  plate_appearances: number;
  doubles: number;
  triples: number;
  walks: number;
  strikeouts: number;
  hit_by_pitch: number;
  opposing_starter_hand: string | null;
}

interface PlayerSeasonSlash {
  player_id: number;
  season_avg: number | null;
  season_obp: number | null;
  season_slg: number | null;
  season_ops: number | null;
}

async function loadBattingLines(fromDate: string, toDate: string): Promise<BattingLineLite[]> {
  const out: BattingLineLite[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supabaseAdmin
      .from('player_batting_lines')
      .select('target_date, player_id, player_name, team, at_bats, hits, plate_appearances, doubles, triples, walks, strikeouts, hit_by_pitch, opposing_starter_hand')
      .gte('target_date', fromDate)
      .lte('target_date', toDate)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        throw new Error(
          'player_batting_lines table missing. Apply migration 020 and run process:date first.',
        );
      }
      throw new Error(`select player_batting_lines failed: ${error.message}`);
    }
    const rows = (data ?? []) as BattingLineLite[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadPlayerSeasonSlash(playerIds: number[]): Promise<Map<number, PlayerSeasonSlash>> {
  const out = new Map<number, PlayerSeasonSlash>();
  if (playerIds.length === 0) return out;
  // Batch IN() to keep URL length sane.
  const CHUNK = 300;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const chunk = playerIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from('players')
      .select('player_id, season_avg, season_obp, season_slg, season_ops')
      .in('player_id', chunk);
    if (error) {
      if (/column .* does not exist|schema cache/i.test(error.message)) {
        // Pre-mig-020 players table — everyone gets null slash.
        return out;
      }
      throw new Error(`select players season slash failed: ${error.message}`);
    }
    for (const r of (data ?? []) as PlayerSeasonSlash[]) {
      out.set(r.player_id, r);
    }
  }
  return out;
}

export interface HitSummaryResult {
  targetDate: string;
  playersWritten: number;
  playersSkippedInactive: number;
  activityWindowDays: number;
  loadWindowDays: number;
}

export async function rebuildHitSummaries(targetDate?: string): Promise<HitSummaryResult> {
  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  const loadFrom = addDays(date, -(LOAD_WINDOW_DAYS - 1));
  const seasonFrom = seasonStart(date);

  console.log(`[rebuildHitSummaries] target=${date} load=[${loadFrom}..${date}] season=${seasonFrom}`);

  // Load the rolling window + a broader season set for platoon splits.
  // Two queries so we don't over-load the network for tiny common case.
  const [rollingRows, seasonRows] = await Promise.all([
    loadBattingLines(loadFrom, date),
    loadBattingLines(seasonFrom, date),
  ]);
  console.log(`[rebuildHitSummaries]   loaded ${rollingRows.length} rolling rows, ${seasonRows.length} season rows`);
  if (rollingRows.length === 0) {
    console.log(`[rebuildHitSummaries] no batting lines in load window — nothing to write`);
    return { targetDate: date, playersWritten: 0, playersSkippedInactive: 0, activityWindowDays: ACTIVITY_WINDOW_DAYS, loadWindowDays: LOAD_WINDOW_DAYS };
  }

  // ---- Group rows by player ----
  const rollingByPlayer = new Map<number, BattingLineLite[]>();
  for (const r of rollingRows) {
    const arr = rollingByPlayer.get(r.player_id) ?? [];
    arr.push(r);
    rollingByPlayer.set(r.player_id, arr);
  }
  const seasonByPlayer = new Map<number, BattingLineLite[]>();
  for (const r of seasonRows) {
    const arr = seasonByPlayer.get(r.player_id) ?? [];
    arr.push(r);
    seasonByPlayer.set(r.player_id, arr);
  }

  // Fetch season slash for every player we're about to write.
  const activePlayerIds = Array.from(rollingByPlayer.keys());
  const slashById = await loadPlayerSeasonSlash(activePlayerIds);

  const activityCutoff = addDays(date, -(ACTIVITY_WINDOW_DAYS - 1));
  const sevenDaysAgo = addDays(date, -6);
  const fourteenDaysAgo = addDays(date, -13);

  let skippedInactive = 0;
  const summaries: any[] = [];

  for (const [player_id, allLines] of rollingByPlayer) {
    // Sort newest first — we use head slices for last-N-games windows.
    allLines.sort((a, b) => b.target_date.localeCompare(a.target_date));

    const mostRecentDate = allLines[0].target_date;
    if (mostRecentDate < activityCutoff) {
      skippedInactive++;
      continue;
    }
    const player_name = allLines[0].player_name;
    const team        = allLines[0].team;

    // Deduplicate by target_date for "games" — a player only appears
    // in the boxscore once per game_pk, but a doubleheader could
    // theoretically yield two entries per date. In practice one line
    // per date is the norm; we treat one date as one game.
    const linesByDate = new Map<string, BattingLineLite>();
    for (const l of allLines) if (!linesByDate.has(l.target_date)) linesByDate.set(l.target_date, l);
    const uniqueDates = Array.from(linesByDate.keys()).sort((a, b) => b.localeCompare(a));

    const last3g = uniqueDates.slice(0, 3).map((d) => linesByDate.get(d)!);
    const last5g = uniqueDates.slice(0, 5).map((d) => linesByDate.get(d)!);
    const last10g = uniqueDates.slice(0, 10).map((d) => linesByDate.get(d)!);
    const l7d = allLines.filter((l) => l.target_date >= sevenDaysAgo && l.target_date <= date);
    const l14d = allLines.filter((l) => l.target_date >= fourteenDaysAgo && l.target_date <= date);

    const sumField = (rows: BattingLineLite[], key: keyof BattingLineLite): number =>
      rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

    const hits_l3g = sumField(last3g, 'hits');
    const ab_l3g   = sumField(last3g, 'at_bats');
    const hits_l5g = sumField(last5g, 'hits');
    const ab_l5g   = sumField(last5g, 'at_bats');
    const hits_l7d = sumField(l7d, 'hits');
    const ab_l7d   = sumField(l7d, 'at_bats');
    const pa_l7d   = sumField(l7d, 'plate_appearances');
    const hits_l14d = sumField(l14d, 'hits');
    const doubles_l7d = sumField(l7d, 'doubles');
    const triples_l14d = sumField(l14d, 'triples');
    const walks_l7d = sumField(l7d, 'walks');
    const strikeouts_l7d = sumField(l7d, 'strikeouts');

    const multi_hit_games_l5g  = last5g.filter((r) => (r.hits ?? 0) >= 2).length;
    const multi_hit_games_l10g = last10g.filter((r) => (r.hits ?? 0) >= 2).length;

    // Platoon splits — season-to-date only. Attribution is per
    // opposing_starter_hand (v1 approximation, see mig 020 header).
    const seasonLines = seasonByPlayer.get(player_id) ?? [];
    let hits_vs_lhp_starters = 0, ab_vs_lhp_starters = 0;
    let hits_vs_rhp_starters = 0, ab_vs_rhp_starters = 0;
    for (const l of seasonLines) {
      if (l.opposing_starter_hand === 'L') {
        hits_vs_lhp_starters += l.hits ?? 0;
        ab_vs_lhp_starters   += l.at_bats ?? 0;
      } else if (l.opposing_starter_hand === 'R') {
        hits_vs_rhp_starters += l.hits ?? 0;
        ab_vs_rhp_starters   += l.at_bats ?? 0;
      }
      // NULL hand rows contribute to neither.
    }

    // Rate stats — null (not zero!) when denominator is zero. See
    // mig 020 comment: consumers must treat null as "not enough data",
    // never as "player never got a hit."
    const rateOrNull = (num: number, den: number): number | null =>
      den > 0 ? num / den : null;

    const slash = slashById.get(player_id);

    const flags: string[] = [];
    if (last3g.length < 3) flags.push('lt3_games_in_load_window');
    if (last5g.length < 5) flags.push('lt5_games_in_load_window');
    if (pa_l7d === 0)      flags.push('zero_pa_l7d');
    if (!slash || (slash.season_avg == null && slash.season_obp == null && slash.season_slg == null && slash.season_ops == null)) {
      flags.push('no_season_slash');
    }
    if (ab_vs_lhp_starters === 0 && ab_vs_rhp_starters === 0) flags.push('no_platoon_data');

    summaries.push({
      summary_date: date,
      player_id,
      player_name,
      team,
      hits_l3g,        ab_l3g,
      hits_l5g,        ab_l5g,
      hits_l7d,        ab_l7d, pa_l7d,
      hits_l14d,
      hit_rate_l3g: rateOrNull(hits_l3g, ab_l3g),
      hit_rate_l5g: rateOrNull(hits_l5g, ab_l5g),
      hit_rate_l7d: rateOrNull(hits_l7d, ab_l7d),
      multi_hit_games_l5g, multi_hit_games_l10g,
      doubles_l7d, triples_l14d,
      strikeout_rate_l7d: rateOrNull(strikeouts_l7d, pa_l7d),
      walks_l7d,
      hits_vs_lhp_starters, hits_vs_rhp_starters,
      ab_vs_lhp_starters, ab_vs_rhp_starters,
      season_avg: slash?.season_avg ?? null,
      season_obp: slash?.season_obp ?? null,
      season_slg: slash?.season_slg ?? null,
      season_ops: slash?.season_ops ?? null,
      flags,
      last_updated: new Date().toISOString(),
    });
  }

  // Upsert in chunks.
  const CHUNK = 500;
  for (let i = 0; i < summaries.length; i += CHUNK) {
    const slice = summaries.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from('player_daily_hit_summary')
      .upsert(slice, { onConflict: 'summary_date,player_id' });
    if (error) throw new Error(`upsert hit summaries failed: ${error.message}`);
  }

  console.log(`[rebuildHitSummaries] wrote ${summaries.length} rows for ${date} (${skippedInactive} inactive players skipped)`);
  return {
    targetDate: date,
    playersWritten: summaries.length,
    playersSkippedInactive: skippedInactive,
    activityWindowDays: ACTIVITY_WINDOW_DAYS,
    loadWindowDays: LOAD_WINDOW_DAYS,
  };
}
