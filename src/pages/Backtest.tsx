/**
 * /backtest — "Did yesterday's HR target ranking actually hit?"
 *
 * For the selected date, load:
 *   1. The persisted snapshot from `hr_target_snapshots` (the ranking that
 *      was made before games started).
 *   2. Every HR in `home_runs` for that date.
 *
 * Join in memory: each snapshot row is a hit ✓ if the player has ≥1 HR
 * row on that date, else a miss ✗. Compute hit rate for Top 3 / 5 / 10.
 *
 * Mobile responsive — uses the same `.table-wrap` and KPI patterns as the
 * rest of the app. No new styling.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, fetchDataLastUpdated, fetchOddsSnapshots, type HomeRunRow, type HrTargetSnapshotRow, type OddsSnapshotRow } from '../lib/supabase';
import { mlbToday, addDays } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  computeBacktestPerformance,
  computeMissAnalysis,
  computeMissChips,
  computeMissPatterns,
  type BacktestPerformance,
  type MissRow,
  type MissChip,
  type MissChipContext,
  type MissPatternSummary,
  type DailyMissInput,
} from '../lib/stats';

/** How many days back the Miss Pattern aggregate covers. */
const MISS_PATTERN_WINDOW_DAYS = 7;

// Pacific calendar date — see src/lib/mlbDate.ts.
const todayISO = mlbToday;

async function fetchSnapshot(targetDate: string): Promise<HrTargetSnapshotRow[]> {
  const { data, error } = await supabase
    .from('hr_target_snapshots')
    .select('*')
    .eq('target_date', targetDate)
    .order('rank', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as HrTargetSnapshotRow[];
}

async function fetchHrsOn(date: string): Promise<HomeRunRow[]> {
  const { data, error } = await supabase
    .from('home_runs')
    .select('*')
    .eq('game_date', date);
  if (error) throw new Error(error.message);
  return (data ?? []) as HomeRunRow[];
}

/**
 * Count games on the date — used to estimate the league-wide hitter pool
 * for the TRUE random baseline (games × 18 starting-lineup slots).
 * Counts ALL games on the date including in-progress / final / postponed
 * because pinned MLB lineups exist as soon as a game is scheduled.
 * Returns 0 on error so the baseline degrades to "—" instead of throwing.
 */
async function fetchGamesCountOn(date: string): Promise<number> {
  const { count, error } = await supabase
    .from('games')
    .select('game_pk', { count: 'exact', head: true })
    .eq('game_date', date);
  if (error) return 0;
  return count ?? 0;
}

/** Pull full games on the date — used by Miss Analysis to attach
 *  weather / opposing pitcher / venue context per miss row. */
interface BacktestGameRow {
  game_pk: number;
  game_date?: string;
  home_team: string;
  away_team: string;
  venue_name: string | null;
  home_probable_pitcher_id: number | null;
  home_probable_pitcher_name: string | null;
  home_probable_pitcher_hand: string | null;
  away_probable_pitcher_id: number | null;
  away_probable_pitcher_name: string | null;
  away_probable_pitcher_hand: string | null;
  weather: { condition?: string } | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
}
async function fetchGamesOnFull(date: string): Promise<BacktestGameRow[]> {
  const { data, error } = await supabase
    .from('games')
    .select('game_pk, home_team, away_team, venue_name, ' +
      'home_probable_pitcher_id, home_probable_pitcher_name, home_probable_pitcher_hand, ' +
      'away_probable_pitcher_id, away_probable_pitcher_name, away_probable_pitcher_hand, ' +
      'weather, weather_temp_f, weather_wind_mph, weather_wind_dir')
    .eq('game_date', date);
  if (error) return [];
  return (data ?? []) as unknown as BacktestGameRow[];
}

/** Pull HRs from the season-anchor up to date-1 so we can compute each
 *  miss player's L7/L14/season HR baseline as the model saw it at
 *  snapshot time. Caps at 5000 rows (a full season is comfortably under
 *  that on any one date). */
async function fetchPriorSeasonHrs(date: string): Promise<HomeRunRow[]> {
  const yearStart = `${date.slice(0, 4)}-01-01`;
  const dayBefore = addDays(date, -1);
  const PAGE = 1000;
  const all: HomeRunRow[] = [];
  for (let page = 0; page < 5; page++) {
    const { data, error } = await supabase
      .from('home_runs')
      .select('*')
      .gte('game_date', yearStart)
      .lte('game_date', dayBefore)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** ---- Multi-day fetchers for the Miss Pattern aggregate (task #174) ----
 *  Each pulls a [from, to] range in one query so the 7-day window costs a
 *  handful of queries total, not 7×. */
async function fetchSnapshotRange(from: string, to: string): Promise<HrTargetSnapshotRow[]> {
  const { data, error } = await supabase
    .from('hr_target_snapshots')
    .select('*')
    .gte('target_date', from)
    .lte('target_date', to)
    .order('rank', { ascending: true });
  if (error) return [];
  return (data ?? []) as HrTargetSnapshotRow[];
}
async function fetchHrRange(from: string, to: string): Promise<HomeRunRow[]> {
  const PAGE = 1000;
  const all: HomeRunRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from('home_runs')
      .select('*')
      .gte('game_date', from)
      .lte('game_date', to)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
async function fetchGamesRange(from: string, to: string): Promise<BacktestGameRow[]> {
  const { data, error } = await supabase
    .from('games')
    .select('game_pk, game_date, home_team, away_team, venue_name, ' +
      'home_probable_pitcher_id, home_probable_pitcher_name, home_probable_pitcher_hand, ' +
      'away_probable_pitcher_id, away_probable_pitcher_name, away_probable_pitcher_hand, ' +
      'weather, weather_temp_f, weather_wind_mph, weather_wind_dir')
    .gte('game_date', from)
    .lte('game_date', to);
  if (error) return [];
  return (data ?? []) as unknown as BacktestGameRow[];
}
async function fetchOddsRange(from: string, to: string): Promise<OddsSnapshotRow[]> {
  const { data, error } = await supabase
    .from('odds_snapshots')
    .select('*')
    .gte('target_date', from)
    .lte('target_date', to)
    .order('snapshot_time', { ascending: true });
  if (error) return [];
  return (data ?? []) as OddsSnapshotRow[];
}

/** Players-catalog batter side lookup — small, single-page. Used to
 *  detect reverse-split misses. */
async function fetchBatterSideIndex(): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const PAGE = 1000;
  for (let page = 0; page < 5; page++) {
    const { data, error } = await supabase
      .from('players')
      .select('player_id, bat_side')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as { player_id: number; bat_side: string | null }[];
    for (const r of rows) out.set(r.player_id, r.bat_side);
    if (rows.length < PAGE) break;
  }
  return out;
}

interface ResolvedRow extends HrTargetSnapshotRow {
  hit: boolean;
  hrs_today: number;
}

function hitRate(rows: ResolvedRow[], cutoff: number) {
  const slice = rows.slice(0, cutoff);
  const hits = slice.filter((r) => r.hit).length;
  return { hits, total: slice.length };
}

export default function Backtest() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialDate = searchParams.get('date') ?? addDays(todayISO(), -1);
  const [date, setDateState] = useState<string>(initialDate);

  const [snapshot, setSnapshot] = useState<HrTargetSnapshotRow[]>([]);
  const [hrs, setHrs] = useState<HomeRunRow[]>([]);
  const [gamesCount, setGamesCount] = useState<number>(0);
  const [dataLastUpdated, setDataLastUpdated] = useState<string | null>(null);
  // ---- Miss Analysis enrichment data (task #168) ----
  const [priorSeasonHrs, setPriorSeasonHrs] = useState<HomeRunRow[]>([]);
  const [gamesFull, setGamesFull] = useState<BacktestGameRow[]>([]);
  const [oddsRows, setOddsRows] = useState<OddsSnapshotRow[]>([]);
  const [batterSideIdx, setBatterSideIdx] = useState<Map<number, string | null>>(new Map());
  // ---- Multi-day Miss Pattern aggregate (task #174) ----
  const [rangeSnapshots, setRangeSnapshots] = useState<HrTargetSnapshotRow[]>([]);
  const [rangeHrs, setRangeHrs] = useState<HomeRunRow[]>([]);
  const [rangeSeasonHrs, setRangeSeasonHrs] = useState<HomeRunRow[]>([]);
  const [rangeGames, setRangeGames] = useState<BacktestGameRow[]>([]);
  const [rangeOdds, setRangeOdds] = useState<OddsSnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setDate(d: string) {
    setDateState(d);
    const next = new URLSearchParams(searchParams);
    next.set('date', d);
    setSearchParams(next, { replace: true });
  }

  // Auto-revalidation key — bumps on tab-visible + hourly.
  const refreshKey = useRevalidationKey();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const rangeFrom = addDays(date, -(MISS_PATTERN_WINDOW_DAYS - 1));
    const seasonStart = `${date.slice(0, 4)}-01-01`;
    Promise.all([
      fetchSnapshot(date),
      fetchHrsOn(date),
      fetchDataLastUpdated(),
      fetchGamesCountOn(date),
      fetchPriorSeasonHrs(date),
      fetchGamesOnFull(date),
      fetchOddsSnapshots(date),
      fetchBatterSideIndex(),
      // Multi-day window for Miss Patterns.
      fetchSnapshotRange(rangeFrom, date),
      fetchHrRange(rangeFrom, date),
      fetchHrRange(seasonStart, date),     // season baseline for L7/L14 per day
      fetchGamesRange(rangeFrom, date),
      fetchOddsRange(rangeFrom, date),
    ])
      .then(([s, h, lu, gc, psh, gf, odds, bsi, rSnap, rHrs, rSeason, rGames, rOdds]) => {
        if (cancelled) return;
        setSnapshot(s);
        setHrs(h);
        setDataLastUpdated(lu);
        setGamesCount(gc);
        setPriorSeasonHrs(psh);
        setGamesFull(gf);
        setOddsRows(odds);
        setBatterSideIdx(bsi);
        setRangeSnapshots(rSnap);
        setRangeHrs(rHrs);
        setRangeSeasonHrs(rSeason);
        setRangeGames(rGames);
        setRangeOdds(rOdds);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, refreshKey]);

  // ---- join snapshot rows with HRs for the date ----
  const resolved: ResolvedRow[] = useMemo(() => {
    const hrsByPlayer = new Map<number, number>();
    for (const h of hrs) {
      hrsByPlayer.set(h.player_id, (hrsByPlayer.get(h.player_id) ?? 0) + 1);
    }
    return snapshot.map((s) => {
      const n = hrsByPlayer.get(s.player_id) ?? 0;
      return { ...s, hit: n > 0, hrs_today: n };
    });
  }, [snapshot, hrs]);

  const rate3 = hitRate(resolved, 3);
  const rate5 = hitRate(resolved, 5);
  const rate10 = hitRate(resolved, 10);

  // ---- Task #166: hit-rate buckets w/ random baseline + lift ----
  // We compute the buckets here rather than memoizing because both
  // inputs (snapshot, hrs) already trigger a re-render when they change.
  const performance: BacktestPerformance | null = useMemo(() => {
    if (snapshot.length === 0) return null;
    return computeBacktestPerformance(
      date,
      snapshot.map((s) => ({ rank: s.rank, player_id: s.player_id, player_name: s.player_name })),
      hrs.map((h) => ({ player_id: h.player_id, player_name: h.player_name })),
      [10, 25, 50],
      { gamesToday: gamesCount },
    );
  }, [snapshot, hrs, date, gamesCount]);

  // ---- Task #166: miss analysis — homered, ranked > 50 (or unranked) ----
  // Phase 1 passes an empty liveTargets array — the miss row carries the
  // snapshot rank + player name only. Phase 2 will recompute live HrTargets
  // for the date to fill in weather / pitcher / park signals per miss.
  const misses: MissRow[] = useMemo(() => {
    if (snapshot.length === 0 || hrs.length === 0) return [];
    // Fill team / opponent from today's HR rows so the chip helper can
    // locate the player's game in `gameByPk` without needing live targets.
    const teamByPlayer = new Map<number, { team: string | null; opponent: string | null }>();
    for (const h of hrs) {
      if (!teamByPlayer.has(h.player_id)) {
        teamByPlayer.set(h.player_id, { team: h.team ?? null, opponent: h.opponent ?? null });
      }
    }
    const rows = computeMissAnalysis(
      hrs.map((h) => ({ player_id: h.player_id, player_name: h.player_name })),
      snapshot.map((s) => ({ rank: s.rank, player_id: s.player_id, player_name: s.player_name })),
      [],
      { cutoff: 50 },
    );
    // Backfill team/opponent — computeMissAnalysis leaves them null when no
    // live target is passed. We have them from the HR rows themselves.
    for (const r of rows) {
      const tb = teamByPlayer.get(r.player_id);
      if (tb) { r.team = tb.team; r.opponent = tb.opponent; }
    }
    return rows;
  }, [snapshot, hrs]);

  // ---- Build the chip context bundle ONCE per date load (task #168) ----
  const missChipsByPlayer: Map<number, MissChip[]> = useMemo(() => {
    const out = new Map<number, MissChip[]>();
    if (misses.length === 0) return out;

    // seasonHrsByPlayer: prior-to-date HRs grouped by player
    const seasonHrsByPlayer = new Map<number, { game_date: string }[]>();
    for (const h of priorSeasonHrs) {
      let arr = seasonHrsByPlayer.get(h.player_id);
      if (!arr) { arr = []; seasonHrsByPlayer.set(h.player_id, arr); }
      arr.push({ game_date: h.game_date });
    }

    // pitcherL14dAllowed: count HRs allowed in the 14-day window prior
    // to date, keyed by pitcher_id. Uses home_runs as a cheap proxy for
    // the full pitcher_starts read.
    const fourteenStart = addDays(date, -14);
    const dayBefore = addDays(date, -1);
    const pitcherL14dAllowed = new Map<number, number>();
    for (const h of priorSeasonHrs) {
      if (h.pitcher_id == null) continue;
      if (h.game_date < fourteenStart || h.game_date > dayBefore) continue;
      pitcherL14dAllowed.set(h.pitcher_id, (pitcherL14dAllowed.get(h.pitcher_id) ?? 0) + 1);
    }

    // gameByPk: enrich with venue rank (cheap rank-by-l14d from the
    // priorSeasonHrs distribution across venues).
    const venueL14d = new Map<string, number>();
    for (const h of priorSeasonHrs) {
      if (!h.venue_name) continue;
      if (h.game_date < fourteenStart || h.game_date > dayBefore) continue;
      venueL14d.set(h.venue_name, (venueL14d.get(h.venue_name) ?? 0) + 1);
    }
    const venueRanking = Array.from(venueL14d.entries()).sort((a, b) => b[1] - a[1]);
    const venueRankByName = new Map<string, number>();
    venueRanking.forEach(([name], i) => venueRankByName.set(name, i + 1));
    const venueTotal = venueRanking.length;

    const gameByPk = new Map<number, MissChipContext['gameByPk'] extends Map<number, infer V> ? V : never>();
    for (const g of gamesFull) {
      // For each game, both teams' batters face the OPPOSING probable pitcher.
      // We pre-bake that into the game row so the chip helper doesn't need
      // to know which side the miss player is on (it uses team matching).
      // To handle this cleanly, we store BOTH directions keyed by team in a
      // separate lookup the helper picks via team membership at chip time.
      gameByPk.set(g.game_pk, {
        home_team: g.home_team,
        away_team: g.away_team,
        venue_name: g.venue_name,
        venue_l14d_rank: g.venue_name ? venueRankByName.get(g.venue_name) ?? null : null,
        venue_total_ranked: venueTotal,
        weather_condition: g.weather?.condition ?? null,
        weather_temp_f: g.weather_temp_f,
        weather_wind_mph: g.weather_wind_mph,
        weather_wind_dir: g.weather_wind_dir,
        // Placeholder: we'll override per-row below using team-aware lookup.
        opposing_pitcher_id: null,
        opposing_pitcher_name: null,
        opposing_pitcher_hand: null,
      });
    }
    // Team-aware opposing pitcher lookup: team → { pitcher_id, name, hand }.
    const opposingPitcherByTeam = new Map<string, { id: number | null; name: string | null; hand: string | null }>();
    for (const g of gamesFull) {
      opposingPitcherByTeam.set(g.home_team, { id: g.away_probable_pitcher_id, name: g.away_probable_pitcher_name, hand: g.away_probable_pitcher_hand });
      opposingPitcherByTeam.set(g.away_team, { id: g.home_probable_pitcher_id, name: g.home_probable_pitcher_name, hand: g.home_probable_pitcher_hand });
    }

    // Odds: pick morning and latest per player.
    const morningOddsByPlayer = new Map<number, { american_odds: number; implied_prob: number }>();
    const latestOddsByPlayer = new Map<number, { american_odds: number; implied_prob: number }>();
    // Sort rows by snapshot_time so "latest" is straightforward.
    const oddsSorted = oddsRows.slice().sort((a, b) => (a.snapshot_time < b.snapshot_time ? -1 : 1));
    for (const r of oddsSorted) {
      if (r.player_id == null) continue;
      if (r.snapshot_type === 'morning' && !morningOddsByPlayer.has(r.player_id)) {
        morningOddsByPlayer.set(r.player_id, { american_odds: r.american_odds, implied_prob: r.implied_prob });
      }
      latestOddsByPlayer.set(r.player_id, { american_odds: r.american_odds, implied_prob: r.implied_prob });
    }

    // hrsOnDateByPlayer: today's HRs grouped per player (multi-HR + distance + EV).
    const hrsOnDateByPlayer = new Map<number, { distance: number | null; exit_velocity: number | null }[]>();
    for (const h of hrs) {
      let arr = hrsOnDateByPlayer.get(h.player_id);
      if (!arr) { arr = []; hrsOnDateByPlayer.set(h.player_id, arr); }
      arr.push({ distance: h.distance, exit_velocity: h.exit_velocity });
    }

    // Compute chips per miss row. Patch the gameByPk entry with the
    // OPPOSING pitcher for the miss player's team right before calling
    // the helper — this is the cleanest place to do team-side selection.
    for (const m of misses) {
      // Find the game for this miss player (by team membership).
      let matchedPk: number | null = null;
      if (m.team) {
        for (const [pk, g] of gameByPk) {
          if (g.home_team === m.team || g.away_team === m.team) { matchedPk = pk; break; }
        }
      }
      // Patch opposing pitcher for the matched game.
      const patchedGameByPk = new Map(gameByPk);
      if (matchedPk != null && m.team) {
        const opp = opposingPitcherByTeam.get(m.team);
        const base = patchedGameByPk.get(matchedPk);
        if (opp && base) {
          patchedGameByPk.set(matchedPk, {
            ...base,
            opposing_pitcher_id: opp.id,
            opposing_pitcher_name: opp.name,
            opposing_pitcher_hand: opp.hand,
          });
        }
      }
      const ctx: MissChipContext = {
        seasonHrsByPlayer,
        gameByPk: patchedGameByPk,
        pitcherL14dAllowed,
        batterSideById: batterSideIdx,
        morningOddsByPlayer,
        latestOddsByPlayer,
        hrsOnDateByPlayer,
        date,
      };
      out.set(m.player_id, computeMissChips(m, ctx));
    }
    return out;
  }, [misses, priorSeasonHrs, gamesFull, oddsRows, batterSideIdx, hrs, date]);

  // ---- Multi-day Miss Pattern aggregate (task #174) ----
  // Bucket the range data by date, build one DailyMissInput per day using
  // the same chip logic as the single-day view, then aggregate frequency.
  const missPatterns: MissPatternSummary | null = useMemo(() => {
    if (rangeSnapshots.length === 0 || rangeHrs.length === 0) return null;

    // Bucket helpers by date.
    const snapsByDate = new Map<string, HrTargetSnapshotRow[]>();
    for (const s of rangeSnapshots) {
      let a = snapsByDate.get(s.target_date); if (!a) { a = []; snapsByDate.set(s.target_date, a); } a.push(s);
    }
    const hrsByDate = new Map<string, HomeRunRow[]>();
    for (const h of rangeHrs) {
      let a = hrsByDate.get(h.game_date); if (!a) { a = []; hrsByDate.set(h.game_date, a); } a.push(h);
    }
    const gamesByDate = new Map<string, BacktestGameRow[]>();
    for (const g of rangeGames) {
      const d = g.game_date ?? '';
      let a = gamesByDate.get(d); if (!a) { a = []; gamesByDate.set(d, a); } a.push(g);
    }
    const oddsByDate = new Map<string, OddsSnapshotRow[]>();
    for (const o of rangeOdds) {
      let a = oddsByDate.get(o.target_date); if (!a) { a = []; oddsByDate.set(o.target_date, a); } a.push(o);
    }

    // Season HRs grouped once (shared across days for L7/L14 baselines).
    const seasonHrsByPlayer = new Map<number, { game_date: string }[]>();
    for (const h of rangeSeasonHrs) {
      let a = seasonHrsByPlayer.get(h.player_id); if (!a) { a = []; seasonHrsByPlayer.set(h.player_id, a); } a.push({ game_date: h.game_date });
    }

    const days: DailyMissInput[] = [];
    for (const [d, daySnaps] of snapsByDate) {
      const dayHrs = hrsByDate.get(d) ?? [];
      if (dayHrs.length === 0) continue; // no results to grade against

      // Identify misses for the day.
      const teamByPlayer = new Map<number, { team: string | null; opponent: string | null }>();
      for (const h of dayHrs) if (!teamByPlayer.has(h.player_id)) teamByPlayer.set(h.player_id, { team: h.team ?? null, opponent: h.opponent ?? null });
      const dayMisses = computeMissAnalysis(
        dayHrs.map((h) => ({ player_id: h.player_id, player_name: h.player_name })),
        daySnaps.map((s) => ({ rank: s.rank, player_id: s.player_id, player_name: s.player_name })),
        [],
        { cutoff: 50 },
      );
      for (const m of dayMisses) { const tb = teamByPlayer.get(m.player_id); if (tb) { m.team = tb.team; m.opponent = tb.opponent; } }

      // Build the chip context for this day.
      const dayGames = gamesByDate.get(d) ?? [];
      const fourteenStart = addDays(d, -14);
      const dayBefore = addDays(d, -1);
      const pitcherL14dAllowed = new Map<number, number>();
      const venueL14d = new Map<string, number>();
      for (const h of rangeSeasonHrs) {
        if (h.game_date < fourteenStart || h.game_date > dayBefore) continue;
        if (h.pitcher_id != null) pitcherL14dAllowed.set(h.pitcher_id, (pitcherL14dAllowed.get(h.pitcher_id) ?? 0) + 1);
        if (h.venue_name) venueL14d.set(h.venue_name, (venueL14d.get(h.venue_name) ?? 0) + 1);
      }
      const venueRanking = Array.from(venueL14d.entries()).sort((a, b) => b[1] - a[1]);
      const venueRankByName = new Map<string, number>();
      venueRanking.forEach(([n], i) => venueRankByName.set(n, i + 1));
      const venueTotal = venueRanking.length;

      const gameByPk = new Map<number, MissChipContext['gameByPk'] extends Map<number, infer V> ? V : never>();
      const opposingByTeam = new Map<string, { id: number | null; name: string | null; hand: string | null }>();
      for (const g of dayGames) {
        gameByPk.set(g.game_pk, {
          home_team: g.home_team, away_team: g.away_team, venue_name: g.venue_name,
          venue_l14d_rank: g.venue_name ? venueRankByName.get(g.venue_name) ?? null : null,
          venue_total_ranked: venueTotal,
          weather_condition: g.weather?.condition ?? null,
          weather_temp_f: g.weather_temp_f, weather_wind_mph: g.weather_wind_mph, weather_wind_dir: g.weather_wind_dir,
          opposing_pitcher_id: null, opposing_pitcher_name: null, opposing_pitcher_hand: null,
        });
        opposingByTeam.set(g.home_team, { id: g.away_probable_pitcher_id, name: g.away_probable_pitcher_name, hand: g.away_probable_pitcher_hand });
        opposingByTeam.set(g.away_team, { id: g.home_probable_pitcher_id, name: g.home_probable_pitcher_name, hand: g.home_probable_pitcher_hand });
      }

      // Odds maps for the day.
      const morningOdds = new Map<number, { american_odds: number; implied_prob: number }>();
      const latestOdds = new Map<number, { american_odds: number; implied_prob: number }>();
      const dOdds = (oddsByDate.get(d) ?? []).slice().sort((a, b) => (a.snapshot_time < b.snapshot_time ? -1 : 1));
      for (const r of dOdds) {
        if (r.player_id == null) continue;
        if (r.snapshot_type === 'morning' && !morningOdds.has(r.player_id)) morningOdds.set(r.player_id, { american_odds: r.american_odds, implied_prob: r.implied_prob });
        latestOdds.set(r.player_id, { american_odds: r.american_odds, implied_prob: r.implied_prob });
      }

      const hrsOnDateByPlayer = new Map<number, { distance: number | null; exit_velocity: number | null }[]>();
      for (const h of dayHrs) { let a = hrsOnDateByPlayer.get(h.player_id); if (!a) { a = []; hrsOnDateByPlayer.set(h.player_id, a); } a.push({ distance: h.distance, exit_velocity: h.exit_velocity }); }

      const dayMissInputs = dayMisses.map((m) => {
        // Patch opposing pitcher for the matched game.
        const patched = new Map(gameByPk);
        if (m.team) {
          let pk: number | null = null;
          for (const [k, g] of gameByPk) if (g.home_team === m.team || g.away_team === m.team) { pk = k; break; }
          if (pk != null) {
            const opp = opposingByTeam.get(m.team);
            const base = patched.get(pk);
            if (opp && base) patched.set(pk, { ...base, opposing_pitcher_id: opp.id, opposing_pitcher_name: opp.name, opposing_pitcher_hand: opp.hand });
          }
        }
        const ctx: MissChipContext = {
          seasonHrsByPlayer, gameByPk: patched, pitcherL14dAllowed,
          batterSideById: batterSideIdx, morningOddsByPlayer: morningOdds, latestOddsByPlayer: latestOdds,
          hrsOnDateByPlayer, date: d,
        };
        return { player_id: m.player_id, player_name: m.player_name, chips: computeMissChips(m, ctx) };
      });

      days.push({ date: d, misses: dayMissInputs });
    }

    return computeMissPatterns(days);
  }, [rangeSnapshots, rangeHrs, rangeSeasonHrs, rangeGames, rangeOdds, batterSideIdx]);

  const today = todayISO();
  const yesterday = addDays(today, -1);

  return (
    <>
      <div className="kpi-strip" style={{ marginBottom: 12 }}>
        <Kpi label="Date" value={date} />
        <Kpi label="Targets snapshot" value={snapshot.length} />
        <Kpi label="HRs on date" value={hrs.length} />
        <Kpi label="Top 10 hits" value={`${rate10.hits} / ${rate10.total}`} />
      </div>

      <TimestampPanel
        snapshotGeneratedAt={snapshot[0]?.snapshot_date ?? null}
        snapshotType={snapshot[0]?.snapshot_type}
        dataLastUpdated={dataLastUpdated}
      />

      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-presets" style={{ alignSelf: 'flex-start' }}>
          <button type="button" onClick={() => setDate(yesterday)} aria-pressed={date === yesterday}>Yesterday</button>
          <button type="button" onClick={() => setDate(today)} aria-pressed={date === today}>Today</button>
        </div>
        <label>
          <span>Custom date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <Link to="/targets" style={{ alignSelf: 'end', marginLeft: 'auto', fontSize: 13 }}>HR Targets →</Link>
      </div>

      <div
        className="panel"
        style={{ marginBottom: 16, background: 'var(--panel-2)', borderColor: 'var(--accent)' }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--accent-2)' }}>Backtest — Saved Snapshot only.</strong>{' '}
          This page reads exclusively from the persisted{' '}
          <code>hr_target_snapshots</code> table for <strong>{date}</strong> —{' '}
          <em>never</em> Live Preview. The ranking shown was locked in at
          snapshot time, then joined against <code>home_runs</code> for that
          same date to compute hit rates. ✓ means the player hit ≥1 HR; ✗ means they did not.
          {snapshot.length > 0 && snapshot[0].snapshot_date && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <span>
                <strong style={{ color: 'var(--good)' }}>Snapshot generated at:</strong>{' '}
                <span style={{ color: 'var(--text)' }}>
                  {new Date(snapshot[0].snapshot_date).toLocaleString()}
                </span>{' '}
                <span className="subtle">(target_date {date})</span>
              </span>
              <SnapshotTypeBadge type={snapshot[0].snapshot_type} />
            </div>
          )}
          <div style={{ marginTop: 6 }} className="subtle" >
            Snapshots are generated automatically by <code>update:daily</code> (today
            + tomorrow, skip-if-exists) and manually by{' '}
            <code>npm run snapshot:targets -- {date} --force</code>. Past dates that
            were never snapshotted will be empty here.
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading backtest for {date}…</div>}

      {/* Hit-rate KPIs */}
      <div className="kpi-strip" style={{ marginBottom: 16 }}>
        <HitRateCell label="Top 3" hits={rate3.hits} total={rate3.total} />
        <HitRateCell label="Top 5" hits={rate5.hits} total={rate5.total} />
        <HitRateCell label="Top 10" hits={rate10.hits} total={rate10.total} />
        <HitRateCell label="All" hits={resolved.filter((r) => r.hit).length} total={resolved.length} />
      </div>

      {/* ---- Task #166: Daily performance — lift vs random ---- */}
      {performance && (
        <PerformancePanel perf={performance} />
      )}

      {/* ---- Task #174: Miss Pattern Analysis (multi-day aggregate) ---- */}
      {missPatterns && missPatterns.total_misses > 0 && (
        <MissPatternsPanel summary={missPatterns} windowDays={MISS_PATTERN_WINDOW_DAYS} />
      )}

      {/* ---- Task #166 + #168: Miss analysis — homered outside Top 50, with diagnostic chips ---- */}
      {misses.length > 0 && (
        <MissPanel misses={misses} cutoff={50} chipsByPlayer={missChipsByPlayer} />
      )}

      {!loading && snapshot.length === 0 && !error && (
        <div className="panel">
          <h2>No snapshot for {date}</h2>
          <p className="subtle">
            No persisted HR Targets snapshot exists for this date. To generate one
            (for past dates, this approximates what the model would have said using
            data on file as of {addDays(date, -1)}):
          </p>
          <pre style={{ background: 'var(--panel-2)', padding: 10, borderRadius: 8, fontSize: 12, overflowX: 'auto' }}>
            npm run snapshot:targets -- {date}
          </pre>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              Top 10 HR Targets — {date}
              <SnapshotTypeBadge type={resolved[0]?.snapshot_type} />
            </h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Sorted by rank (as recorded in the snapshot)
            </span>
          </div>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Game</th>
                  <th className="num">Heat</th>
                  <th>Result</th>
                  <th className="num">HRs</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {resolved.slice(0, 10).map((r) => (
                  <tr
                    key={`${r.player_id}-${r.game_pk}`}
                    style={{ background: r.hit ? 'rgba(74, 222, 128, 0.08)' : undefined }}
                  >
                    <td className="num">{r.rank}</td>
                    <td>
                      <Link
                        className="player-link"
                        to={`/player/${r.player_id}?asOf=${date}`}
                      >
                        {r.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{r.team}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent}</td>
                    <td className="num">{Number(r.heat_score).toFixed(1)}</td>
                    <td>
                      {r.hit ? (
                        <span style={{ color: 'var(--good)', fontWeight: 700 }}>✓ HR</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>✗ —</span>
                      )}
                    </td>
                    <td className="num">{r.hrs_today}</td>
                    <td className="subtle" style={{ fontSize: 12 }}>{r.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {resolved.length > 10 && (
        <div className="panel">
          <h2>Ranks 11 — {resolved.length}</h2>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Game</th>
                  <th className="num">Heat</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {resolved.slice(10).map((r) => (
                  <tr key={`${r.player_id}-${r.game_pk}`}>
                    <td className="num">{r.rank}</td>
                    <td>
                      <Link
                        className="player-link"
                        to={`/player/${r.player_id}?asOf=${date}`}
                      >
                        {r.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{r.team}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent}</td>
                    <td className="num">{Number(r.heat_score).toFixed(1)}</td>
                    <td>
                      {r.hit ? (
                        <span style={{ color: 'var(--good)' }}>✓</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>✗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
    </div>
  );
}

function SnapshotTypeBadge({ type }: { type: 'live' | 'simulated' | 'live-preview' | undefined }) {
  if (!type) return null;
  // Three discrete states the user requested:
  //   'live'         → DB snapshot_type='live'      → "Pre-game"
  //   'simulated'    → DB snapshot_type='simulated' → "Simulated historical"
  //   'live-preview' → no saved snapshot in DB      → "Live preview"
  const config = {
    'live':         { label: '● Pre-game',              color: 'var(--good)',    bg: 'rgba(74, 222, 128, 0.15)', tip: 'Honest pre-game snapshot — taken before first pitch on target_date.' },
    'simulated':    { label: '○ Simulated historical', color: 'var(--accent)',  bg: 'rgba(255, 122, 24, 0.15)', tip: 'Simulated historical backfill — approximates what the model would have said using data ≤ target_date - 1.' },
    'live-preview': { label: '◇ Live preview',          color: 'var(--muted)',   bg: 'rgba(133, 147, 184, 0.15)', tip: 'Live model output — not saved. May change as data updates.' },
  }[type];
  return (
    <span
      title={config.tip}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        background: config.bg,
        color: config.color,
        border: `1px solid ${config.color}`,
      }}
    >
      {config.label}
    </span>
  );
}

function TimestampPanel({
  snapshotGeneratedAt,
  snapshotType,
  dataLastUpdated,
}: {
  snapshotGeneratedAt: string | null;
  snapshotType: 'live' | 'simulated' | 'live-preview' | undefined;
  dataLastUpdated: string | null;
}) {
  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleString() : <span className="subtle">—</span>;
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        padding: 10,
        marginBottom: 12,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div title="When the persisted Top-N snapshot for this date was written to hr_target_snapshots. Backtest reads exclusively from this row — never a live recompute.">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Saved Snapshot generated at
        </div>
        <div style={{ marginTop: 2 }}>{fmt(snapshotGeneratedAt)}</div>
      </div>
      <div title="Honest pre-game snapshot ('live') or historical backfill ('simulated').">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Snapshot type
        </div>
        <div style={{ marginTop: 2 }}>
          {snapshotType ? <SnapshotTypeBadge type={snapshotType} /> : <span className="subtle">—</span>}
        </div>
      </div>
      <div title="Most recent home_runs.created_at — when the data layer last received a HR row.">
        <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Data last updated at
        </div>
        <div style={{ marginTop: 2 }}>{fmt(dataLastUpdated)}</div>
      </div>
    </div>
  );
}

function HitRateCell({ label, hits, total }: { label: string; hits: number; total: number }) {
  const pct = total > 0 ? Math.round((hits / total) * 100) : 0;
  return (
    <div className="kpi" style={{ background: hits > 0 && total > 0 ? 'var(--panel-2)' : undefined }}>
      <div className="kpi-label">{label} hit rate</div>
      <div className="kpi-value">
        {hits} / {total}
        {total > 0 && (
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>
            ({pct}%)
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Task #167: Daily performance — Top N hit-rate + TWO baselines
//   (a) headline: lift vs MLB-wide random (games × 18 hitters)
//   (b) diagnostic: lift vs the model's pre-filtered pool
// ============================================================
function PerformancePanel({ perf }: { perf: BacktestPerformance }) {
  const hasGamesData = perf.games_today > 0;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        Model performance — Top 10 / 25 / 50 vs random baseline
      </h2>

      {/* Two-baseline summary tiles. Lets the user see at a glance that the
          pool rate is naturally elevated and shouldn't be the "random" floor. */}
      <div
        style={{
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          marginBottom: 10,
        }}
      >
        <BaselineTile
          label="League-wide random baseline"
          accent
          value={hasGamesData ? `${(perf.league_base_rate * 100).toFixed(1)}%` : '—'}
          note={
            hasGamesData
              ? `${perf.hr_hitters_total} HR hitters / ~${perf.league_hitters_estimated} MLB hitters (${perf.games_today} games × 18 lineup slots)`
              : 'No games on file for this date'
          }
        />
        <BaselineTile
          label="Model pool HR rate"
          value={`${(perf.pool_base_rate * 100).toFixed(1)}%`}
          note={`${perf.hr_hitters_total} HR hitters / ${perf.ranked_players} ranked players`}
        />
        <BaselineTile
          label="Total HRs today"
          value={`${perf.total_hrs}`}
          note={`across ${perf.hr_hitters_total} distinct hitters`}
        />
      </div>

      <div
        className="subtle"
        style={{
          fontSize: 11,
          marginBottom: 10,
          padding: '6px 8px',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          lineHeight: 1.5,
        }}
      >
        The ranked pool is already curated by the model, so its HR rate is
        naturally higher than the MLB average. "Lift vs random" below uses the{' '}
        <strong>league-wide</strong> baseline — what a coin flip across all
        ~{perf.league_hitters_estimated} MLB hitters today would produce — not
        the model-pool rate.
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cutoff</th>
              <th className="num">Hits</th>
              <th className="num">Hit rate</th>
              <th className="num">Expected (MLB)</th>
              <th className="num">Lift vs MLB</th>
              <th className="num subtle">Lift vs pool</th>
            </tr>
          </thead>
          <tbody>
            {perf.buckets.map((b) => {
              const liftLeaguePct = b.lift_vs_league != null ? b.lift_vs_league * 100 : null;
              const liftPoolPct = b.lift_vs_pool != null ? b.lift_vs_pool * 100 : null;
              const colorFor = (pct: number | null) =>
                pct == null
                  ? 'var(--muted)'
                  : pct > 0
                  ? 'var(--good, #4cd97a)'
                  : pct < 0
                  ? '#ff8d8d'
                  : 'var(--muted)';
              return (
                <tr key={b.topN}>
                  <td><strong>Top {b.topN}</strong></td>
                  <td className="num">{b.hits} / {b.ranked}</td>
                  <td className="num">{(b.hit_rate * 100).toFixed(1)}%</td>
                  <td className="num subtle">{b.expected_random_hits_league.toFixed(2)}</td>
                  <td className="num" style={{ color: colorFor(liftLeaguePct), fontWeight: 600 }}>
                    {liftLeaguePct == null
                      ? '—'
                      : `${liftLeaguePct > 0 ? '+' : ''}${liftLeaguePct.toFixed(0)}%`}
                  </td>
                  <td className="num subtle" style={{ color: colorFor(liftPoolPct), opacity: 0.7 }}>
                    {liftPoolPct == null
                      ? '—'
                      : `${liftPoolPct > 0 ? '+' : ''}${liftPoolPct.toFixed(0)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
        Read: lift +500% on Top 10 means the model's Top 10 had ~6× more
        HR-hitters than a random pick from all MLB hitters today. The "Lift vs
        pool" column compares against the already-curated pool — a tougher
        benchmark, kept here for transparency. Single-day numbers are noisy;
        track the trend over weeks. The league baseline assumes 18 starting
        hitters per game (excludes pinch hitters — a small underestimate).
      </div>
    </div>
  );
}

function BaselineTile({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        background: accent ? 'rgba(74,222,128,0.08)' : 'var(--panel-2)',
        border: `1px solid ${accent ? 'rgba(74,222,128,0.45)' : 'var(--border)'}`,
      }}
    >
      <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ? 'var(--good, #4cd97a)' : 'var(--text)' }}>
        {value}
      </div>
      <div className="subtle" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>
        {note}
      </div>
    </div>
  );
}

// ============================================================
// Task #168: Miss analysis — homered outside Top 50, with chips
// ============================================================
function MissPanel({
  misses,
  cutoff,
  chipsByPlayer,
}: {
  misses: MissRow[];
  cutoff: number;
  chipsByPlayer: Map<number, MissChip[]>;
}) {
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        Miss analysis — homered but ranked outside Top {cutoff}
      </h2>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
        Players the model passed on who hit HRs today. <strong>{misses.length}</strong>{' '}
        miss{misses.length === 1 ? '' : 'es'}. Sort: most-snubbed first
        (highest snapshot rank, or "unranked"). Each row carries up to six
        diagnostic chips so you can see WHY the model passed and which signals
        existed. Look for patterns —{' '}
        <em>if many misses share the same chips, that's a tuning lever.</em>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Team</th>
              <th>Opp</th>
              <th>Signals (chips)</th>
            </tr>
          </thead>
          <tbody>
            {misses.map((m) => {
              const chips = chipsByPlayer.get(m.player_id) ?? [];
              return (
                <tr key={m.player_id}>
                  <td>
                    <Link className="player-link" to={`/player/${m.player_id}`}>
                      {m.player_name}
                    </Link>
                  </td>
                  <td>{m.team ? <span className="pill">{m.team}</span> : '—'}</td>
                  <td className="subtle" style={{ fontSize: 12 }}>
                    {m.opponent ? `vs ${m.opponent}` : '—'}
                  </td>
                  <td>
                    <MissChipRow chips={chips} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.6 }}>
        <strong>Chip glossary</strong> —{' '}
        <span style={{ color: 'var(--good, #4cd97a)' }}>green</span> = signal
        model SHOULD have weighted higher (real miss);{' '}
        <span style={{ color: '#ff8d8d' }}>red</span> = penalty model applied
        with justification (miss you accept);{' '}
        <span style={{ color: 'var(--muted)' }}>gray</span> = informational
        context (pool position, raw outcome).{' '}
        <strong>Wind Out / HR Pitcher / Power Park / Odds Steam / Hot last 7d</strong>{' '}
        are the highest-signal "model snubbed real edge" markers. Hover any
        chip for the source value.
      </div>
    </div>
  );
}

// ============================================================
// Task #174: Miss Pattern Analysis (multi-day aggregate)
// ============================================================
function MissPatternsPanel({ summary, windowDays }: { summary: MissPatternSummary; windowDays: number }) {
  // Highlight 'good'-toned patterns — those are "model undervalued real
  // edge" and the actionable tuning levers.
  const maxCount = summary.patterns.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        Miss Pattern Analysis — last {windowDays} days
      </h2>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        Across <strong>{summary.total_misses}</strong> missed HR hitters (homered, ranked
        outside Top 50) over <strong>{summary.days_covered}</strong> day(s), here's how often
        each trait showed up. <strong style={{ color: 'var(--good, #4cd97a)' }}>Green</strong>{' '}
        traits = real edge the model undervalued (the tuning levers);{' '}
        <strong style={{ color: '#ff8d8d' }}>red</strong> = penalties the model applied with
        justification; gray = context. High-frequency green rows are where the Heat Score is
        systematically leaving HRs on the table.
      </div>

      {/* Frequency bars */}
      <div style={{ display: 'grid', gap: 6 }}>
        {summary.patterns.map((p) => {
          const color =
            p.tone === 'good' ? 'var(--good, #4cd97a)' :
            p.tone === 'bad'  ? '#ff8d8d' :
                                'var(--muted, #aaa)';
          const barBg =
            p.tone === 'good' ? 'rgba(64,200,120,0.25)' :
            p.tone === 'bad'  ? 'rgba(255,110,110,0.25)' :
                                'rgba(160,160,160,0.20)';
          return (
            <div key={p.kind} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 90px', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color }}>{p.label}</span>
              <div style={{ height: 14, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <div style={{ width: `${(p.count / maxCount) * 100}%`, height: '100%', background: barBg, borderRight: `2px solid ${color}` }} />
              </div>
              <span className="subtle num" style={{ fontSize: 11 }}>
                {(p.frequency * 100).toFixed(0)}% ({p.count})
              </span>
            </div>
          );
        })}
      </div>

      {/* Repeat offenders */}
      {summary.repeat_offenders.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
            Repeat offenders — missed on multiple days
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {summary.repeat_offenders.map((r) => (
              <Link
                key={r.player_id}
                to={`/player/${r.player_id}`}
                className="player-link"
                style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: 'var(--panel-2)', border: '1px solid var(--border)', textDecoration: 'none' }}
              >
                {r.player_name} <span className="subtle">×{r.miss_days}</span>
              </Link>
            ))}
          </div>
          <div className="subtle" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
            These players homered on multiple days while ranked outside the Top 50 — the strongest
            signal that the model has a blind spot for their specific profile.
          </div>
        </div>
      )}
    </div>
  );
}

function MissChipRow({ chips }: { chips: MissChip[] }) {
  if (!chips || chips.length === 0) {
    return (
      <span className="subtle" style={{ fontSize: 11 }}>
        Loading context…
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {chips.map((c) => (
        <span
          key={c.kind}
          title={c.detail ?? c.label}
          style={{
            display: 'inline-block',
            padding: '2px 7px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            background:
              c.tone === 'good' ? 'rgba(64,200,120,0.14)' :
              c.tone === 'bad'  ? 'rgba(255,110,110,0.14)' :
                                  'rgba(160,160,160,0.14)',
            border:
              c.tone === 'good' ? '1px solid rgba(64,200,120,0.45)' :
              c.tone === 'bad'  ? '1px solid rgba(255,110,110,0.45)' :
                                  '1px solid rgba(160,160,160,0.45)',
            color:
              c.tone === 'good' ? 'var(--good, #4cd97a)' :
              c.tone === 'bad'  ? '#ff8d8d' :
                                  'var(--muted)',
          }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
