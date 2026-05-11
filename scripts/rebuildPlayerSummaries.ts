/**
 * rebuildPlayerSummaries(targetDate?) — recompute per-player rolling stats
 * from the home_runs table and upsert into player_daily_summary.
 *
 * IMPORTANT — single source of truth:
 *   `home_runs` is the canonical store. `player_daily_summary` is a derived
 *   cache used by future server-side queries (Slack bots, scheduled digests,
 *   etc.). The frontend does NOT read from this table any more — both the
 *   Dashboard and the Player Detail page compute everything from raw
 *   `home_runs`. So if this cache ever drifts, the UI is unaffected; only
 *   downstream consumers of player_daily_summary would see stale data.
 *
 * Semantics of one row in player_daily_summary:
 *   "Player P's rolling stats as of date D, where D is a date P actually
 *    hit a HR." We only emit (player_id, D) for D ∈ P.distinctHRDates.
 *   This keeps the table small (~ one row per HR event, deduped per day).
 *
 * Per-row definitions (all anchored at row.date = D):
 *  - hrs_today          → HRs P hit on D
 *  - season_total       → HRs P hit in the same calendar year, ≤ D
 *  - hrs_last_3_games   → HRs across P's most recent 3 distinct HR-dates ≤ D
 *  - hrs_last_5_games   → same but 5 distinct HR-dates
 *  - hrs_last_7_days    → HRs P hit in [D - 6, D]
 *  - last_hr_date       → P's most recent HR date ≤ D (so == D for these rows)
 *
 * "Game" is approximated as "distinct game_date the player appears in
 * home_runs." Doubleheaders are rare and produce a single date row.
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';

interface HrRow {
  player_id: number;
  player_name: string;
  team: string;
  game_date: string; // YYYY-MM-DD
}

export interface RebuildResult {
  targetDate: string;
  playersWritten: number;
}

export async function rebuildPlayerSummaries(
  targetDate?: string,
): Promise<RebuildResult> {
  const date = targetDate ?? new Date().toISOString().slice(0, 10);
  const yearStart = `${date.slice(0, 4)}-01-01`;

  console.log(`[rebuildPlayerSummaries] target=${date} season>=${yearStart}`);

  // Pull every HR in the season up through the target date in a single query.
  // For an MVP a single season is well under Supabase's row limits.
  const { data, error } = await supabaseAdmin
    .from('home_runs')
    .select('player_id, player_name, team, game_date')
    .gte('game_date', yearStart)
    .lte('game_date', date);
  if (error) throw new Error(`select home_runs failed: ${error.message}`);

  const rows = (data ?? []) as HrRow[];
  if (rows.length === 0) {
    console.log('[rebuildPlayerSummaries] no HR rows in window — nothing to write');
    return { targetDate: date, playersWritten: 0 };
  }

  // ---- group by player ----
  const byPlayer = new Map<
    number,
    { name: string; team: string; dates: string[] }
  >();
  for (const r of rows) {
    const cur = byPlayer.get(r.player_id);
    if (cur) {
      cur.dates.push(r.game_date);
      // keep most recent name/team in case of trades / display updates
      cur.name = r.player_name;
      cur.team = r.team;
    } else {
      byPlayer.set(r.player_id, {
        name: r.player_name,
        team: r.team,
        dates: [r.game_date],
      });
    }
  }

  const sevenDaysAgo = addDays(date, -6); // inclusive 7-day window

  // Only emit rows for players who actually hit on `date` — that's the row's
  // semantic anchor. This keeps the table sparse and correct.
  const summaries = Array.from(byPlayer.entries())
    .filter(([, p]) => p.dates.includes(date))
    .map(([player_id, p]) => {
      // sort newest -> oldest
      p.dates.sort((a, b) => b.localeCompare(a));

      const distinctDates = Array.from(new Set(p.dates)); // already sorted desc
      const last3 = new Set(distinctDates.slice(0, 3));
      const last5 = new Set(distinctDates.slice(0, 5));

      let hrs_today = 0;
      let hrs_last_3_games = 0;
      let hrs_last_5_games = 0;
      let hrs_last_7_days = 0;

      for (const d of p.dates) {
        if (d === date) hrs_today++;
        if (last3.has(d)) hrs_last_3_games++;
        if (last5.has(d)) hrs_last_5_games++;
        if (d >= sevenDaysAgo && d <= date) hrs_last_7_days++;
      }

      return {
        player_id,
        player_name: p.name,
        date,
        team: p.team,
        hrs_today,
        season_total: p.dates.length, // all rows in window are season-to-date
        hrs_last_3_games,
        hrs_last_5_games,
        hrs_last_7_days,
        last_hr_date: distinctDates[0] ?? null,
      };
    });

  // Upsert in chunks to stay well under any payload limits.
  const CHUNK = 500;
  for (let i = 0; i < summaries.length; i += CHUNK) {
    const slice = summaries.slice(i, i + CHUNK);
    const { error: upErr } = await supabaseAdmin
      .from('player_daily_summary')
      .upsert(slice, { onConflict: 'player_id,date' });
    if (upErr) throw new Error(`upsert summaries failed: ${upErr.message}`);
  }

  console.log(`[rebuildPlayerSummaries] wrote ${summaries.length} player rows for ${date}`);
  return { targetDate: date, playersWritten: summaries.length };
}

export function addDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
