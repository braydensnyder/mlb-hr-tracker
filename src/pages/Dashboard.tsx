import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase, fetchPlayerIndex, type HomeRunRow } from '../lib/supabase';
import HomeRunCard from '../components/HomeRunCard';
import Leaderboard, { type LeaderRow } from '../components/Leaderboard';
import TeamLeaderboard from '../components/TeamLeaderboard';
import { BackToBackPanel, MultiHrPanel } from '../components/PlayerStreaks';
import PitcherLeaderboard from '../components/PitcherLeaderboard';
import { LeagueHandednessPanel, PlayerHandednessPanel } from '../components/HandednessPanel';
import VenueLeaderboard from '../components/VenueLeaderboard';
import Filters from '../components/Filters';
import {
  addDays,
  aggregateByPlayer,
  applyCanonicalTeams,
  applyFilters,
  backToBackHr,
  hotHittersLastNGames,
  hrsInLastDays,
  leagueHandednessSplit,
  multiHrInLastNGames,
  pitcherHrLeaderboard,
  playerHandednessSplits,
  seasonLeaders,
  teamHrLeaderboard,
  venueLeaderboard,
  type PlayerTeamIndex,
} from '../lib/stats';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const PAGE_SIZE = 1000;

/**
 * Fetch every home_runs row from {year}-01-01 through asOf inclusive.
 * That's enough history to compute every "as-of" view: HRs today, last 3/5
 * games, last 7/14 days, season total, team season totals, etc.
 *
 * Pages through Supabase's 1k-row default limit. A full MLB season is well
 * under 10k HRs, so even the May-onwards window stays small.
 */
async function fetchSeasonToDate(asOf: string): Promise<HomeRunRow[]> {
  const seasonStart = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('home_runs')
      .select('*')
      .gte('game_date', seasonStart)
      .lte('game_date', asOf)
      .order('game_date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export default function Dashboard() {
  // ---- single source of truth: the as-of date ----
  // Honor ?asOf= from the URL so navigating back from a player page keeps context.
  const [searchParams, setSearchParams] = useSearchParams();
  const [asOf, setAsOfState] = useState<string>(searchParams.get('asOf') ?? todayISO());
  const [team, setTeam] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  function setAsOf(d: string | ((prev: string) => string)) {
    setAsOfState((prev) => {
      const next = typeof d === 'function' ? d(prev) : d;
      const params = new URLSearchParams(searchParams);
      params.set('asOf', next);
      setSearchParams(params, { replace: true });
      return next;
    });
  }

  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Player index is small and stable — fetch once.
  useEffect(() => {
    let cancelled = false;
    fetchPlayerIndex()
      .then((m) => { if (!cancelled) setPlayerIndex(m); })
      .catch((e) => {
        // Soft failure: dashboard still works, it just uses per-HR team strings.
        // eslint-disable-next-line no-console
        console.warn('[Dashboard] fetchPlayerIndex failed; falling back to per-HR team strings:', e);
      });
    return () => { cancelled = true; };
  }, []);

  // ---- fetch season-to-date whenever asOf changes ----
  useEffect(() => {
    if (!asOf) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSeasonToDate(asOf)
      .then((rows) => {
        if (cancelled) return;
        setSeasonHrs(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [asOf]);

  // ---- canonical team remap: replace per-HR team strings with the player's
  //      current MLB team. Falls back to per-HR team if the player isn't in
  //      the index yet (i.e., enrich:players hasn't run). ----
  const canonHrs = useMemo(
    () => applyCanonicalTeams(seasonHrs, playerIndex),
    [seasonHrs, playerIndex],
  );

  // ---- team list (from canonical season HRs so dropdown is stable) ----
  const teams = useMemo(() => {
    const s = new Set<string>();
    for (const h of canonHrs) s.add(h.team);
    return Array.from(s).sort();
  }, [canonHrs]);

  // ---- apply team + search filters once, share across all aggregations ----
  const filteredHrs = useMemo(
    () => applyFilters(canonHrs, { team, search }),
    [canonHrs, team, search],
  );

  const byPlayer = useMemo(() => aggregateByPlayer(filteredHrs), [filteredHrs]);

  // anchor = the as-of date; all rolling views look BACKWARD from here
  const anchor = asOf;

  // ---- "today" (HRs whose game_date == asOf) ----
  const hrsToday = useMemo(
    () => filteredHrs.filter((h) => h.game_date === anchor),
    [filteredHrs, anchor],
  );

  // ---- per-player rolling views (all anchored at asOf, looking back across full season) ----
  const hot3 = useMemo(() => hotHittersLastNGames(byPlayer, anchor, 3), [byPlayer, anchor]);
  const hot5 = useMemo(() => hotHittersLastNGames(byPlayer, anchor, 5), [byPlayer, anchor]);
  const last7 = useMemo(() => hrsInLastDays(byPlayer, anchor, 7), [byPlayer, anchor]);
  const last14 = useMemo(() => hrsInLastDays(byPlayer, anchor, 14), [byPlayer, anchor]);
  const season = useMemo(() => seasonLeaders(byPlayer), [byPlayer]);
  const b2b = useMemo(() => backToBackHr(byPlayer, anchor), [byPlayer, anchor]);
  const multi = useMemo(() => multiHrInLastNGames(byPlayer, anchor, 5, 2), [byPlayer, anchor]);

  // ---- team views ----
  const teamLast7 = useMemo(
    () => teamHrLeaderboard(filteredHrs, { since: addDays(anchor, -6), until: anchor }),
    [filteredHrs, anchor],
  );
  const teamSeason = useMemo(
    () => teamHrLeaderboard(filteredHrs, { until: anchor }),
    [filteredHrs, anchor],
  );

  // ---- matchup-context views ----
  const pitchers = useMemo(() => pitcherHrLeaderboard(filteredHrs, anchor), [filteredHrs, anchor]);
  const handedness = useMemo(() => leagueHandednessSplit(filteredHrs, anchor), [filteredHrs, anchor]);
  const playerSplits = useMemo(() => playerHandednessSplits(filteredHrs, anchor), [filteredHrs, anchor]);
  const venues = useMemo(() => venueLeaderboard(filteredHrs, anchor), [filteredHrs, anchor]);

  // ---- shape generic leaderboard rows ----
  const hot3Rows: LeaderRow[] = hot3.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    metric: r.hrs_in_last_n_games,
    extra: r.total_in_window,
  }));
  const hot5Rows: LeaderRow[] = hot5.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    metric: r.hrs_in_last_n_games,
    extra: r.total_in_window,
  }));
  const last7Rows: LeaderRow[] = last7.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    metric: r.hrs,
    extra: r.total_in_window,
  }));
  const last14Rows: LeaderRow[] = last14.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    metric: r.hrs,
    extra: r.total_in_window,
  }));
  const seasonRows: LeaderRow[] = season.map((r) => ({
    player_id: r.player_id,
    player_name: r.player_name,
    team: r.team,
    metric: r.hrs,
    extra: r.last_hr,
  }));

  // ---- date controls ----
  function shiftDays(delta: number) {
    setAsOf((d) => addDays(d, delta));
  }
  function reset() {
    setAsOf(todayISO());
    setTeam('');
    setSearch('');
  }

  // KPI counts
  const todaysHrCount = hrsToday.length;
  const playersToday = useMemo(() => new Set(hrsToday.map((h) => h.player_id)).size, [hrsToday]);

  return (
    <>
      <Filters
        asOfDate={asOf}
        onAsOfDateChange={setAsOf}
        team={team}
        teams={teams}
        onTeamChange={setTeam}
        search={search}
        onSearchChange={setSearch}
        onShiftDays={shiftDays}
        onJumpToToday={() => setAsOf(todayISO())}
        onReset={reset}
      />

      {error && <div className="error">{error}</div>}
      {loading && (
        <div className="subtle" style={{ marginBottom: 12 }}>
          Loading season data through {asOf}…
        </div>
      )}
      {!loading && seasonHrs.length === 0 && !error && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>No data yet for the {asOf.slice(0, 4)} season</h2>
          <p className="subtle">
            Run <code>npm run backfill:season -- {asOf.slice(0, 4)}-03-01 {asOf}</code> to ingest
            the season so far, or <code>npm run process:date -- {asOf}</code> for a single day.
          </p>
        </div>
      )}

      {/* ---- KPI strip ---- */}
      <div className="kpi-strip">
        <Kpi label="As of" value={asOf} />
        <Kpi label="HRs today" value={todaysHrCount} />
        <Kpi label="Players w/ HR today" value={playersToday} />
        <Kpi label="Season HRs (filtered)" value={filteredHrs.length} />
      </div>

      {/* ---- HRs today ---- */}
      <h3 className="section">HRs on {asOf}</h3>
      <div className="panel" style={{ marginBottom: 16 }}>
        {hrsToday.length === 0 ? (
          <div className="empty">
            No home runs on {asOf}{team ? ` for ${team}` : ''}{search ? ` matching “${search}”` : ''}.
            Try a different date or clear filters.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {hrsToday.map((hr) => (
              <HomeRunCard key={hr.id} hr={hr} asOf={asOf} />
            ))}
          </div>
        )}
      </div>

      {/* ---- Player rolling views ---- */}
      <h3 className="section">Who's hot — rolling player views</h3>
      <div className="grid">
        <Leaderboard
          title="Hot hitters — last 3 games"
          rows={hot3Rows}
          metricLabel="L3 HR"
          extraLabel="Season HR"
          asOf={asOf}
        />
        <Leaderboard
          title="Hot hitters — last 5 games"
          rows={hot5Rows}
          metricLabel="L5 HR"
          extraLabel="Season HR"
          asOf={asOf}
        />
        <Leaderboard
          title="HRs — last 7 days"
          rows={last7Rows}
          metricLabel="L7d HR"
          extraLabel="Season HR"
          asOf={asOf}
        />
        <Leaderboard
          title="HRs — last 14 days"
          rows={last14Rows}
          metricLabel="L14d HR"
          extraLabel="Season HR"
          asOf={asOf}
        />
        <Leaderboard
          title="Season HR leaderboard"
          rows={seasonRows}
          metricLabel="HR"
          extraLabel="Last HR"
          limit={20}
          asOf={asOf}
        />
      </div>

      {/* ---- Team views ---- */}
      <h3 className="section">Team views</h3>
      <div className="grid">
        <TeamLeaderboard title="Team HRs — last 7 days" rows={teamLast7} />
        <TeamLeaderboard title="Team HRs — season-to-date" rows={teamSeason} />
      </div>

      {/* ---- Streaks / hot patterns ---- */}
      <h3 className="section">Betting research</h3>
      <div className="grid">
        <BackToBackPanel rows={b2b} asOf={asOf} />
        <MultiHrPanel rows={multi} asOf={asOf} />
      </div>

      {/* ---- Pitchers ---- */}
      <h3 className="section">Pitchers — HR allowed</h3>
      <div className="grid">
        <PitcherLeaderboard title="Most HRs allowed (season-to-date)" rows={pitchers} limit={20} />
      </div>

      {/* ---- Handedness ---- */}
      <h3 className="section">Handedness splits</h3>
      <div className="grid">
        <LeagueHandednessPanel split={handedness} />
        <PlayerHandednessPanel rows={playerSplits} asOf={asOf} />
      </div>

      {/* ---- Ballparks ---- */}
      <h3 className="section">Ballparks</h3>
      <div className="grid">
        <VenueLeaderboard rows={venues} />
      </div>
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
