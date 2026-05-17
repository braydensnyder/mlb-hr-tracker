import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  supabase,
  fetchPlayerIndex,
  fetchTodayStatus,
  fetchCronState,
  fetchWeatherCoverage,
  type HomeRunRow,
  type TodayStatus,
  type CronStateRow,
  type WeatherCoverage,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import HomeRunCard from '../components/HomeRunCard';
import WeatherLine from '../components/WeatherLine';
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

// "today" = MLB / Pacific calendar date. See src/lib/mlbDate.ts for why
// `new Date().toISOString().slice(0, 10)` is the wrong call here.
const todayISO = mlbToday;

/** Temporary debug toggle — when true, every WeatherLine on the page also
 *  prints the literal `weather_updated_at: <iso | null>` so we can spot
 *  "missing in DB" vs "missing in UI" by eye. Flipped off 2026-05-16
 *  after end-to-end verification (weather coverage 15/15, updated_at
 *  visible in DB and UI). Flip back to true if anything looks off again. */
const WEATHER_DEBUG = false;

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

/** Per-game weather payload — everything the WeatherLine component needs.
 *  Pulled with `weather_updated_at` so the UI can show "Updated 6:14 PM"
 *  AND the temporary debug text the user requested. */
export interface GameWeather {
  condition: string | null;
  temp_f: number | null;
  wind_mph: number | null;
  wind_dir: string | null;
  weather_updated_at: string | null;
}

/**
 * Fetch the games on `date` and return the weather payload per game_pk.
 *
 * Two-tier select so the UI keeps working when migration 010 hasn't been
 * applied yet:
 *   1. Try the full select including `weather_updated_at`.
 *   2. If Postgres rejects the column (PGRST204 / "column does not exist"),
 *      retry with the original four columns and treat updated_at as null.
 *
 * Logs to the browser console either way so you can confirm in dev tools
 * exactly what came back from Supabase.
 */
async function fetchGameWeather(date: string): Promise<Map<number, GameWeather>> {
  type Wide = {
    game_pk: number;
    weather: { condition?: string } | null;
    weather_temp_f: number | null;
    weather_wind_mph: number | null;
    weather_wind_dir: string | null;
    weather_updated_at: string | null;
  };
  type Narrow = Omit<Wide, 'weather_updated_at'>;

  let rows: Wide[] = [];
  let migrationApplied = true;

  // Tier 1 — preferred path, includes weather_updated_at.
  {
    const { data, error } = await supabase
      .from('games')
      .select(
        'game_pk, weather, weather_temp_f, weather_wind_mph, weather_wind_dir, weather_updated_at',
      )
      .eq('game_date', date);

    if (error) {
      // "column ... does not exist" / "could not find ... in the schema cache"
      const msg = error.message ?? '';
      const isMissingColumn =
        /weather_updated_at/i.test(msg) &&
        /(does not exist|schema cache|column)/i.test(msg);
      if (!isMissingColumn) throw new Error(msg);
      migrationApplied = false;
      console.warn(
        '[weather] Dashboard fetchGameWeather: weather_updated_at column not found in games. ' +
          'Run supabase/migrations/010_weather_updated_at.sql. Falling back to select without it.',
      );
      // Tier 2 — without the new column.
      const { data: data2, error: error2 } = await supabase
        .from('games')
        .select('game_pk, weather, weather_temp_f, weather_wind_mph, weather_wind_dir')
        .eq('game_date', date);
      if (error2) throw new Error(error2.message);
      rows = ((data2 ?? []) as Narrow[]).map((g) => ({ ...g, weather_updated_at: null }));
    } else {
      rows = (data ?? []) as Wide[];
    }
  }

  const out = new Map<number, GameWeather>();
  let withTemp = 0;
  let withUpdatedAt = 0;
  for (const g of rows) {
    out.set(g.game_pk, {
      condition: g.weather?.condition ?? null,
      temp_f: g.weather_temp_f,
      wind_mph: g.weather_wind_mph,
      wind_dir: g.weather_wind_dir,
      weather_updated_at: g.weather_updated_at,
    });
    if (g.weather_temp_f != null) withTemp++;
    if (g.weather_updated_at) withUpdatedAt++;
  }

  // Visible breadcrumb in dev tools so you can see whether Supabase is
  // returning weather data at all.
  console.log(
    `[weather] Dashboard fetchGameWeather(${date}) → ${rows.length} games, ` +
      `${withTemp} with temp, ${withUpdatedAt} with weather_updated_at` +
      (migrationApplied ? '' : ' (migration 010 not applied — updated_at always null)'),
  );

  return out;
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
  /** Today's actual-results snapshot — drives the Dashboard status card.
   *  Re-fetched on every refresh tick so the card stays current as the
   *  cron lands new live-game HRs into Supabase. */
  const [todayStatus, setTodayStatus] = useState<TodayStatus | null>(null);
  /** Cron singleton — "Last cron run" / "Last cron mode" tiles. */
  const [cronState, setCronState] = useState<CronStateRow | null>(null);
  /** Weather coverage on `asOf` — drives "Weather: 12/15 games" tile. */
  const [weatherCoverage, setWeatherCoverage] = useState<WeatherCoverage | null>(null);
  /** game_pk → weather payload, for labelling the HRs-today cards. The
   *  WeatherLine component renders "Weather pending" when a game has no
   *  entry, so cards never go un-labelled. */
  const [weatherByGame, setWeatherByGame] = useState<Map<number, GameWeather>>(new Map());
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

  // Auto-revalidation key — bumps on tab-visible + hourly.
  const refreshKey = useRevalidationKey();

  // ---- fetch season-to-date whenever asOf changes OR auto-refresh fires ----
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

    // Fetch today's actual-results status for the Dashboard status card.
    // Independent of the season fetch so a soft failure here doesn't
    // hide the rest of the dashboard. Re-runs on every refreshKey bump
    // so the card stays fresh during live games.
    fetchTodayStatus(asOf)
      .then((s) => { if (!cancelled) setTodayStatus(s); })
      .catch(() => { if (!cancelled) setTodayStatus(null); });

    // Cron singleton — "Last cron run" + "Last cron mode" tiles.
    fetchCronState()
      .then((c) => { if (!cancelled) setCronState(c); })
      .catch(() => { if (!cancelled) setCronState(null); });

    // Weather coverage on the as-of date.
    fetchWeatherCoverage(asOf)
      .then((w) => { if (!cancelled) setWeatherCoverage(w); })
      .catch(() => { if (!cancelled) setWeatherCoverage(null); });

    // Game weather for the as-of date — used to tag the HRs-today cards.
    fetchGameWeather(asOf)
      .then((m) => { if (!cancelled) setWeatherByGame(m); })
      .catch(() => { if (!cancelled) setWeatherByGame(new Map()); });

    return () => {
      cancelled = true;
    };
  }, [asOf, refreshKey]);

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

      {/* ---- Today's actual results status card ----
          Reads from the `games` table (status counts) + home_runs
          (HR count + freshest created_at on game_date == asOf). The
          card answers "is the cron actually pulling today's games?". */}
      <TodayStatusCard
        status={todayStatus}
        asOf={asOf}
        cronState={cronState}
        weather={weatherCoverage}
      />

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
              <HomeRunCard
                key={hr.id}
                hr={hr}
                asOf={asOf}
                weather={weatherByGame.get(hr.game_pk) ?? null}
                showWeatherDebug={WEATHER_DEBUG}
              />
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

/**
 * "Today's actual results" status card. Six tiles plus a freshness
 * timestamp. Re-fetched alongside everything else on tab focus + hourly.
 *
 * The card answers a single operational question: "is the cron actually
 * pulling today's games, or is the dashboard frozen?"
 *
 * Tile values:
 *   - Today's games checked: total games on date (live + final + pregame + processed)
 *   - Today's HRs found: SELECT COUNT(*) FROM home_runs WHERE game_date = asOf
 *   - Final games processed: games marked processed=true
 *   - Live games still in progress: games whose status is in LIVE_STATUSES
 *   - Finals awaiting ingest: status=Final but processed=false (next cron picks them up)
 *   - Pregame: games not yet started
 *   - Last actual results update: MAX(home_runs.created_at) where game_date = asOf
 */
function TodayStatusCard({
  status,
  asOf,
  cronState,
  weather,
}: {
  status: TodayStatus | null;
  asOf: string;
  cronState: CronStateRow | null;
  weather: WeatherCoverage | null;
}) {
  if (!status) {
    return (
      <div className="panel" style={{ marginBottom: 12, padding: 10 }}>
        <div className="subtle" style={{ fontSize: 12 }}>
          Today's actual results — loading…
        </div>
      </div>
    );
  }

  const fmt = (s: string | null) =>
    s ? new Date(s).toLocaleString() : <span className="subtle">—</span>;

  // Color the live tile differently so an "is anything happening right now?"
  // glance is obvious.
  const liveStyle = status.liveGames > 0
    ? { color: 'var(--good)', fontWeight: 700 as const }
    : undefined;

  // Weather coverage tile — null while loading, "Pending" when no game has
  // weather yet (MLB hasn't published), "12/15 games" otherwise.
  const weatherTile = (() => {
    if (!weather) return { value: '—', accent: false };
    if (weather.totalGames === 0) return { value: 'No games', accent: false };
    if (weather.withWeather === 0) return { value: 'Pending', accent: false };
    return {
      value: `${weather.withWeather}/${weather.totalGames}`,
      accent: weather.withWeather === weather.totalGames,
    };
  })();

  return (
    <div
      className="panel"
      style={{ marginBottom: 16, padding: 10 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Today's actual results — {asOf}</strong>
        <span className="subtle" style={{ fontSize: 11 }}>
          (refreshed from Supabase on tab-focus and hourly)
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          fontSize: 12,
        }}
      >
        <StatusTile label="Games checked"     value={status.totalGames} />
        <StatusTile label="HRs found today"   value={status.hrsToday} accent />
        <StatusTile label="Final processed"   value={status.processedGames} />
        <StatusTile label="Live in progress"  value={status.liveGames} valueStyle={liveStyle} />
        <StatusTile label="Finals awaiting"   value={status.finalsAwaitingIngest} />
        <StatusTile label="Pregame"           value={status.pregameGames} />
        <StringTile label="Weather coverage"  value={weatherTile.value} accent={weatherTile.accent} />
        <StringTile
          label="Last cron run"
          value={cronState?.last_run_at ? new Date(cronState.last_run_at).toLocaleTimeString() : '—'}
        />
        <StringTile
          label="Last cron mode"
          value={cronState?.last_run_mode ?? '—'}
        />
      </div>
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 11,
          display: 'grid',
          gap: 4,
        }}
      >
        <div>
          <span className="subtle" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Last actual results update
          </span>
          <span style={{ marginLeft: 8 }}>{fmt(status.lastActualHrCreatedAt)}</span>
          {status.liveGames > 0 && (
            <span className="subtle" style={{ marginLeft: 12 }}>
              (next cron tick will re-check the {status.liveGames} live game{status.liveGames === 1 ? '' : 's'})
            </span>
          )}
        </div>
        <div>
          <span className="subtle" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Last cron run
          </span>
          <span style={{ marginLeft: 8 }}>{fmt(cronState?.last_run_at ?? null)}</span>
          {cronState?.last_run_mode && (
            <span className="subtle" style={{ marginLeft: 8 }}>
              ({cronState.last_run_mode}{cronState.run_count ? ` · run #${cronState.run_count}` : ''})
            </span>
          )}
          {cronState?.running && (
            <span style={{ marginLeft: 8, color: 'var(--good)', fontWeight: 600 }}>
              · running now
            </span>
          )}
        </div>
        <div>
          <span className="subtle" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Last weather update
          </span>
          <span style={{ marginLeft: 8 }}>{fmt(weather?.lastWeatherUpdatedAt ?? null)}</span>
          {weather && weather.totalGames > 0 && weather.withWeather === 0 && (
            <span className="subtle" style={{ marginLeft: 8 }}>
              (MLB hasn't published weather yet — usually a few hours before first pitch)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function StringTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="subtle" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: accent ? 'var(--accent)' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusTile({
  label,
  value,
  accent,
  valueStyle,
}: {
  label: string;
  value: number;
  accent?: boolean;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
      }}
    >
      <div
        className="subtle"
        style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 2,
          fontSize: 18,
          fontWeight: 700,
          color: accent ? 'var(--accent-2)' : 'var(--text)',
          ...valueStyle,
        }}
      >
        {value}
      </div>
    </div>
  );
}
