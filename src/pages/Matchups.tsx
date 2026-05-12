/**
 * /matchups — "Today's Matchup Board"
 *
 * For each game on the as-of date:
 *  - Teams + venue
 *  - Probable pitchers (TBD if MLB hasn't announced) + their HR-allowed stats
 *  - Top hot hitters from each team
 *  - Rule-based matchup notes (hot hitter vs HR-prone pitcher, lefty vs RHP, power park, etc.)
 *
 * Source of truth: home_runs (for hitter form, pitcher form, venue history)
 * + games (for schedule, probable pitchers, venue assignment).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, fetchPlayerIndex, type GameRow, type HomeRunRow } from '../lib/supabase';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  addDays,
  aggregateByPlayer,
  applyCanonicalTeams,
  pitcherHrLeaderboard,
  hotHittersLastNGames,
  venueLeaderboard,
  type PitcherAllowed,
  type HotHitter,
  type PlayerTeamIndex,
  type VenueStats,
} from '../lib/stats';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const PAGE_SIZE = 1000;

async function fetchSeasonHrs(asOf: string): Promise<HomeRunRow[]> {
  const start = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('home_runs')
      .select('*')
      .gte('game_date', start)
      .lte('game_date', asOf)
      .order('game_date', { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

async function fetchGamesOn(date: string): Promise<GameRow[]> {
  const { data, error } = await supabase
    .from('games')
    .select('*')
    .eq('game_date', date)
    .order('game_pk', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

interface MatchupNote {
  kind: 'hot-vs-hr-prone' | 'lefty-vs-rhp' | 'righty-vs-lhp' | 'power-park';
  text: string;
}

interface TeamSide {
  team: string;
  hot: HotHitter[];
  pitcher: {
    id: number | null;
    name: string;
    hand: string | null;
    allowed: PitcherAllowed | null;
  };
}

export default function Matchups() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [asOf, setAsOfState] = useState<string>(searchParams.get('asOf') ?? todayISO());
  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlayerIndex()
      .then((m) => { if (!cancelled) setPlayerIndex(m); })
      .catch(() => {/* soft-fail; we'll fall back to per-HR teams */});
    return () => { cancelled = true; };
  }, []);

  const canonHrs = useMemo(() => applyCanonicalTeams(seasonHrs, playerIndex), [seasonHrs, playerIndex]);

  function setAsOf(d: string) {
    setAsOfState(d);
    const next = new URLSearchParams(searchParams);
    next.set('asOf', d);
    setSearchParams(next, { replace: true });
  }

  // Auto-revalidation key — bumps on tab-visible + hourly.
  const refreshKey = useRevalidationKey();

  useEffect(() => {
    if (!asOf) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchSeasonHrs(asOf), fetchGamesOn(asOf)])
      .then(([hrs, gs]) => {
        if (cancelled) return;
        setSeasonHrs(hrs);
        setGames(gs);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asOf, refreshKey]);

  // ---- precompute league-level views once (all use canonical-team rows) ----
  const pitcherIndex = useMemo(() => {
    const board = pitcherHrLeaderboard(canonHrs, asOf);
    return new Map(board.map((p) => [p.pitcher_id, p] as const));
  }, [canonHrs, asOf]);

  const venueIndex = useMemo(() => {
    const board = venueLeaderboard(canonHrs, asOf);
    return new Map(board.map((v) => [v.venue_name, v] as const));
  }, [canonHrs, asOf]);

  const hotHittersByTeam = useMemo(() => {
    const board = hotHittersLastNGames(aggregateByPlayer(canonHrs), asOf, 5);
    const m = new Map<string, HotHitter[]>();
    for (const h of board) {
      if (h.hrs_in_last_n_games < 1) continue;
      let arr = m.get(h.team);
      if (!arr) { arr = []; m.set(h.team, arr); }
      arr.push(h);
    }
    for (const [, arr] of m) arr.sort((a, b) => b.hrs_in_last_n_games - a.hrs_in_last_n_games);
    return m;
  }, [canonHrs, asOf]);

  // L7d HR counts by player — used as input to "lefty vs RHP" rule
  const l7ByPlayerHand = useMemo(() => {
    const map = new Map<number, { name: string; team: string; bat_side: string | null; hrs7: number }>();
    const start = addDays(asOf, -6);
    for (const r of canonHrs) {
      if (r.game_date < start || r.game_date > asOf) continue;
      let p = map.get(r.player_id);
      if (!p) { p = { name: r.player_name, team: r.team, bat_side: r.batter_side ?? null, hrs7: 0 }; map.set(r.player_id, p); }
      if (r.batter_side) p.bat_side = r.batter_side;
      p.hrs7++;
    }
    return map;
  }, [canonHrs, asOf]);

  // L14 league avg per venue — power-park heuristic baseline
  const venueL14Median = useMemo(() => {
    const all = Array.from(venueIndex.values()).map((v) => v.l14d).sort((a, b) => a - b);
    if (all.length === 0) return 0;
    return all[Math.floor(all.length / 2)];
  }, [venueIndex]);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Link to={`/?asOf=${asOf}`}>← Back to dashboard</Link>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
          <span>Date</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{
              background: 'var(--panel)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px',
            }}
          />
        </label>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle">Loading matchups for {asOf}…</div>}

      {!loading && games.length === 0 && !error && (
        <div className="panel">
          <h2>No games scheduled for {asOf}</h2>
          <p className="subtle">
            If today is a game day, run <code>npm run process:date -- {asOf}</code> first to seed the schedule.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {games.map((g) => {
          const venueRow = g.venue_name ? venueIndex.get(g.venue_name) ?? null : null;
          const home: TeamSide = {
            team: g.home_team,
            hot: (hotHittersByTeam.get(g.home_team) ?? []).slice(0, 5),
            pitcher: {
              id: g.away_probable_pitcher_id, // pitcher facing the home hitters is the AWAY pitcher
              name: g.away_probable_pitcher_name ?? 'TBD',
              hand: g.away_probable_pitcher_hand ?? (g.away_probable_pitcher_id ? lookupPitcherHand(pitcherIndex, g.away_probable_pitcher_id) : null),
              allowed: g.away_probable_pitcher_id ? pitcherIndex.get(g.away_probable_pitcher_id) ?? null : null,
            },
          };
          const away: TeamSide = {
            team: g.away_team,
            hot: (hotHittersByTeam.get(g.away_team) ?? []).slice(0, 5),
            pitcher: {
              id: g.home_probable_pitcher_id,
              name: g.home_probable_pitcher_name ?? 'TBD',
              hand: g.home_probable_pitcher_hand ?? (g.home_probable_pitcher_id ? lookupPitcherHand(pitcherIndex, g.home_probable_pitcher_id) : null),
              allowed: g.home_probable_pitcher_id ? pitcherIndex.get(g.home_probable_pitcher_id) ?? null : null,
            },
          };

          const notes: MatchupNote[] = [];
          if (venueRow && venueRow.l14d > 0 && venueRow.l14d >= Math.max(2, venueL14Median + 2)) {
            notes.push({ kind: 'power-park', text: `Power park recently — ${venueRow.l14d} HRs there in last 14 days` });
          }
          for (const side of [home, away]) {
            if (side.pitcher.allowed && side.pitcher.allowed.allowed_last_14_days >= 3) {
              const hot = side.hot.filter((h) => h.hrs_in_last_n_games >= 2);
              for (const h of hot.slice(0, 2)) {
                notes.push({ kind: 'hot-vs-hr-prone', text: `${h.player_name} (${h.hrs_in_last_n_games} HR last 5 G) vs ${side.pitcher.name} — allowing ${side.pitcher.allowed.allowed_last_14_days} HR last 14d` });
              }
            }
            if (side.pitcher.hand) {
              for (const h of side.hot.slice(0, 3)) {
                const handed = l7ByPlayerHand.get(h.player_id);
                const bats = handed?.bat_side ?? null;
                if (!bats) continue;
                if (bats === 'L' && side.pitcher.hand === 'R') {
                  notes.push({ kind: 'lefty-vs-rhp', text: `${h.player_name} (LHB) vs ${side.pitcher.name} (RHP)` });
                } else if (bats === 'R' && side.pitcher.hand === 'L') {
                  notes.push({ kind: 'righty-vs-lhp', text: `${h.player_name} (RHB) vs ${side.pitcher.name} (LHP)` });
                }
              }
            }
          }

          return (
            <div key={g.game_pk} className="panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <h2 style={{ margin: 0, color: 'var(--text)', textTransform: 'none', letterSpacing: 0, fontSize: 18 }}>
                  {g.away_team} @ {g.home_team}
                </h2>
                <div className="subtle" style={{ fontSize: 13 }}>
                  {g.venue_name ? `${g.venue_name} · ` : ''}{g.status}
                </div>
              </div>

              <div className="grid" style={{ marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                <SidePanel side={home} venueRow={venueRow} asOf={asOf} sideLabel="Home" />
                <SidePanel side={away} venueRow={venueRow} asOf={asOf} sideLabel="Away" />
              </div>

              {notes.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>Notes</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {notes.map((n, i) => (
                      <li key={i} className="subtle" style={{ fontSize: 13, lineHeight: 1.45 }}>{n.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SidePanel({ side, venueRow, asOf, sideLabel }: { side: TeamSide; venueRow: VenueStats | null; asOf: string; sideLabel: string }) {
  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <h2>{sideLabel} — {side.team}</h2>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <strong>Probable:</strong>{' '}
        {side.pitcher.name === 'TBD' ? (
          <span className="subtle">TBD</span>
        ) : (
          <>
            {side.pitcher.name}
            {side.pitcher.hand && <span className="pill" style={{ marginLeft: 6 }}>{side.pitcher.hand}HP</span>}
            {side.pitcher.allowed && (
              <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>
                · allowed {side.pitcher.allowed.season_allowed} HR season,
                {' '}{side.pitcher.allowed.allowed_last_14_days} L14d
              </span>
            )}
            {!side.pitcher.allowed && (
              <span className="subtle" style={{ marginLeft: 8, fontSize: 12 }}>· no HR-allowed history</span>
            )}
          </>
        )}
      </div>

      <div style={{ fontSize: 13, marginBottom: 4 }}>
        <strong>Hot hitters:</strong>{' '}
        {side.hot.length === 0 ? (
          <span className="subtle">no recent HR activity</span>
        ) : (
          side.hot.map((h, i) => (
            <span key={h.player_id}>
              {i > 0 && ', '}
              <Link to={`/player/${h.player_id}?asOf=${asOf}`}>
                {h.player_name}
              </Link>
              <span className="subtle"> ({h.hrs_in_last_n_games})</span>
            </span>
          ))
        )}
      </div>

      {venueRow && (
        <div className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
          Venue: {venueRow.season} HR season, {venueRow.l14d} L14d at this park
        </div>
      )}
    </div>
  );
}

function lookupPitcherHand(index: Map<number, PitcherAllowed>, id: number): string | null {
  return index.get(id)?.pitcher_throws ?? null;
}

