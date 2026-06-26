/**
 * /teams — "Team Board"
 *
 * A second ranking organization layer on top of the existing Heat Score.
 * The user's hypothesis: ranking globally lets one team (Dodgers, Yankees)
 * dominate the Top 10 while quieter teams have nobody — even when those
 * quieter teams have a clear #1 hitter who is the right play for that game.
 * Forcing one pick per team produces a more representative betting board.
 *
 * Three phases on one page, top to bottom (most actionable first):
 *
 *   Phase 3 — "Today's Team-Leader Board" (the betting board)
 *     The 30 team leaders re-ranked globally by Heat Score. This is the
 *     curated 30-hitter pool the user proposed as the new Top 10 source.
 *
 *   Phase 2 — "Today's Team Leaders"
 *     The #1 hitter from every team. Sorted alphabetically by team so it
 *     reads like a league-wide one-pick-per-team checklist.
 *
 *   Phase 1 — "All Team Rankings"
 *     Every team's full ranked list, collapsible. Reveals stack patterns
 *     ("3 of Yankees' top 4 are in your tier") without changing any weights.
 *
 * Weight changes: none. This page is purely a re-organization of the
 * scores HrTargets already produces.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  supabase, fetchPlayerIndex, fetchPitcherFormIndex, fetchOddsSnapshots,
  type GameRow, type HomeRunRow,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import ReasonChips from '../components/ReasonChips';
import {
  addDays,
  applyCanonicalTeams,
  computeHrTargets,
  pitcherHrLeaderboard,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type HrTarget,
  type HrTargetGame,
  type PitcherFormLite,
  type PlayerTeamIndex,
  type SleeperOddsLite,
} from '../lib/stats';

const todayISO = mlbToday;
const PAGE = 1000;

// =============================================================================
//  Fetchers (mirror the HR Targets pattern; minimal duplication)
// =============================================================================
async function fetchSeasonHrs(asOf: string): Promise<HomeRunRow[]> {
  const start = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('home_runs').select('*')
      .gte('game_date', start).lte('game_date', asOf)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
async function fetchGamesOn(date: string): Promise<GameRow[]> {
  const { data, error } = await supabase
    .from('games').select('*').eq('game_date', date)
    .order('game_pk', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

// =============================================================================
//  Page
// =============================================================================
export default function TeamBoard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTarget = searchParams.get('date') ?? todayISO();
  const [targetDate, setTargetDateState] = useState<string>(initialTarget);
  const asOf = useMemo(() => addDays(targetDate, -1), [targetDate]);

  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [pitcherStartsForm, setPitcherStartsForm] = useState<Map<number, PitcherFormLite>>(new Map());
  const [oddsByPlayer, setOddsByPlayer] = useState<Map<number, SleeperOddsLite>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setTargetDate(d: string) {
    setTargetDateState(d);
    const next = new URLSearchParams(searchParams);
    next.set('date', d);
    setSearchParams(next, { replace: true });
  }

  useEffect(() => {
    let cancelled = false;
    fetchPlayerIndex().then((m) => { if (!cancelled) setPlayerIndex(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const refreshKey = useRevalidationKey();

  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const [hrs, gs, odds] = await Promise.all([
          fetchSeasonHrs(asOf),
          fetchGamesOn(targetDate),
          fetchOddsSnapshots(targetDate).catch(() => []),
        ]);
        if (cancelled) return;
        setSeasonHrs(hrs);
        setGames(gs);
        const oddsMap = new Map<number, SleeperOddsLite>();
        const oddsSorted = odds.slice().sort((a, b) => a.snapshot_time < b.snapshot_time ? -1 : 1);
        for (const r of oddsSorted) {
          if (r.player_id == null) continue;
          oddsMap.set(r.player_id, { implied_prob: r.implied_prob, american_odds: r.american_odds });
        }
        setOddsByPlayer(oddsMap);

        const probIds = new Set<number>();
        for (const g of gs) {
          if (g.home_probable_pitcher_id != null) probIds.add(g.home_probable_pitcher_id);
          if (g.away_probable_pitcher_id != null) probIds.add(g.away_probable_pitcher_id);
        }
        if (probIds.size > 0) {
          try {
            const form = await fetchPitcherFormIndex(Array.from(probIds), asOf);
            if (cancelled) return;
            const m = new Map<number, PitcherFormLite>();
            for (const [id, f] of form) {
              m.set(id, {
                pitcher_id: id, pitcher_throws: f.pitcher_throws,
                allowed_last_14_days: f.hr_allowed_l14d,
                allowed_last_3_starts: f.hr_allowed_l3_starts,
                allowed_last_5_starts: f.hr_allowed_l5_starts,
                season_hr_allowed: f.season_hr_allowed,
                starts_known: f.starts_count,
                k_per_9: f.k_per_9 ?? undefined,
                bb_per_9: f.bb_per_9 ?? undefined,
              });
            }
            setPitcherStartsForm(m);
          } catch { setPitcherStartsForm(new Map()); }
        } else setPitcherStartsForm(new Map());
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [asOf, targetDate, refreshKey]);

  // -------- Build the ranked list, same as The Card / HR Targets --------
  const canonHrs = useMemo(() => applyCanonicalTeams(seasonHrs, playerIndex), [seasonHrs, playerIndex]);
  const elitePowerIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, p] of playerIndex) {
      const name = (p.full_name ?? '').trim().toLowerCase();
      if (name && ELITE_POWER_NAMES.has(name)) ids.add(id);
    }
    return ids;
  }, [playerIndex]);
  const pitcherIndex = useMemo(() => {
    const board = pitcherHrLeaderboard(canonHrs, asOf);
    const approx = new Map<number, PitcherFormLite>(
      board.map((p) => [p.pitcher_id, {
        pitcher_id: p.pitcher_id,
        pitcher_throws: p.pitcher_throws,
        allowed_last_14_days: p.allowed_last_14_days,
        allowed_last_3_starts: p.allowed_last_3_starts,
        starts_known: 0,
      }] as const),
    );
    for (const [id, real] of pitcherStartsForm) approx.set(id, real);
    return approx;
  }, [canonHrs, asOf, pitcherStartsForm]);
  const venueIndex = useMemo(() => {
    const board = venueLeaderboard(canonHrs, asOf);
    const total = board.length;
    return new Map(board.map((v, i) => [v.venue_name, {
      venue_name: v.venue_name, l14d: v.l14d, rank_l14d: i + 1, total_ranked: total,
    }] as const));
  }, [canonHrs, asOf]);
  const targetGames: HrTargetGame[] = useMemo(
    () => games.map((g) => ({
      game_pk: g.game_pk, game_date: g.game_date,
      home_team: g.home_team, away_team: g.away_team, venue_name: g.venue_name,
      home_probable_pitcher_id: g.home_probable_pitcher_id,
      home_probable_pitcher_name: g.home_probable_pitcher_name,
      home_probable_pitcher_hand: g.home_probable_pitcher_hand,
      away_probable_pitcher_id: g.away_probable_pitcher_id,
      away_probable_pitcher_name: g.away_probable_pitcher_name,
      away_probable_pitcher_hand: g.away_probable_pitcher_hand,
      weather: g.weather, weather_temp_f: g.weather_temp_f,
      weather_wind_mph: g.weather_wind_mph, weather_wind_dir: g.weather_wind_dir,
      weather_updated_at: g.weather_updated_at,
      home_lineup: g.home_lineup ?? null,
      away_lineup: g.away_lineup ?? null,
      lineups_confirmed: g.lineups_confirmed ?? false,
      game_status: g.status ?? null,
    })),
    [games],
  );
  const boards = useMemo(
    () => computeHrTargets(canonHrs, asOf, targetGames, { pitcherIndex, venueIndex, elitePowerIds }),
    [canonHrs, asOf, targetGames, pitcherIndex, venueIndex, elitePowerIds],
  );
  /** Same filter HR Targets / The Card use — confirmed + pending only. */
  const allRanked = useMemo(() => {
    const all: HrTarget[] = [];
    for (const b of boards) all.push(...b.away_targets, ...b.home_targets);
    return all
      .filter((t) => t.lineup_status === 'confirmed' || t.lineup_status === 'pending')
      .sort((a, b) => b.heat_score - a.heat_score);
  }, [boards]);

  // ============================================================
  //  Phase 1: per-team rankings (Map<team, HrTarget[] sorted desc>)
  // ============================================================
  const teamRankings = useMemo(() => {
    const m = new Map<string, HrTarget[]>();
    for (const t of allRanked) {
      const arr = m.get(t.team);
      if (arr) arr.push(t); else m.set(t.team, [t]);
    }
    // Sort each team's roster by heat desc (allRanked is already sorted, so
    // bucket order is preserved — just rebuild to be explicit/defensive).
    for (const [, arr] of m) arr.sort((a, b) => b.heat_score - a.heat_score);
    return m;
  }, [allRanked]);

  // ============================================================
  //  Phase 2: today's team leaders — the #1 from every team
  // ============================================================
  const teamLeaders = useMemo(() => {
    const out: HrTarget[] = [];
    for (const [, arr] of teamRankings) if (arr.length > 0) out.push(arr[0]);
    return out;
  }, [teamRankings]);

  // ============================================================
  //  Phase 3: re-rank the team leaders globally — THE BETTING BOARD
  // ============================================================
  const teamLeaderBoard = useMemo(() => {
    return teamLeaders.slice().sort((a, b) => b.heat_score - a.heat_score);
  }, [teamLeaders]);

  const today = todayISO();
  const tomorrow = addDays(today, 1);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>🏟 Team Board</h1>
        <span className="subtle" style={{ fontSize: 13 }}>
          One pick per team — league-wide representation instead of stacking the same dugout
        </span>
      </div>

      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-presets" style={{ alignSelf: 'flex-start' }}>
          <button type="button" onClick={() => setTargetDate(today)} aria-pressed={targetDate === today}>Today</button>
          <button type="button" onClick={() => setTargetDate(tomorrow)} aria-pressed={targetDate === tomorrow}>Tomorrow</button>
        </div>
        <label>
          <span>Custom date</span>
          <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link to={`/card?date=${targetDate}`} style={{ fontSize: 13 }}>Compare with The Card →</Link>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading {targetDate}…</div>}

      {!loading && allRanked.length === 0 && !error && (
        <div className="panel">
          <h2>No ranked hitters for {targetDate}</h2>
          <p className="subtle">Lineups haven't posted yet or no games scheduled. Check back closer to game time.</p>
        </div>
      )}

      {/* ───────────────── PHASE 3 — Team-Leader Board (betting board) ───────────────── */}
      {teamLeaderBoard.length > 0 && (
        <section className="tb-panel">
          <div className="tb-head">
            <h2 style={{ margin: 0, fontSize: 17 }}>🥇 Today's Team-Leader Board</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              {teamLeaderBoard.length} team leaders, re-ranked globally — the proposed betting board
            </span>
          </div>
          <TeamLeaderTable leaders={teamLeaderBoard.slice(0, 30)} asOf={asOf} oddsByPlayer={oddsByPlayer} />
          <p className="subtle" style={{ fontSize: 11, marginTop: 8 }}>
            One pick per team, then re-ranked. Compare to <Link to={`/card?date=${targetDate}`}>The Card</Link>'s
            global Cores/Boosts/Spice to see how team-balancing changes who surfaces.
          </p>
        </section>
      )}

      {/* ───────────────── PHASE 2 — Today's Team Leaders (alphabetical) ───────────────── */}
      {teamLeaders.length > 0 && (
        <section className="tb-panel">
          <div className="tb-head">
            <h2 style={{ margin: 0, fontSize: 17 }}>👑 Today's Team Leaders</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              The #1-ranked hitter on every team playing today — alphabetical
            </span>
          </div>
          <TeamLeaderGrid leaders={teamLeaders.slice().sort((a, b) => a.team.localeCompare(b.team))} asOf={asOf} oddsByPlayer={oddsByPlayer} />
        </section>
      )}

      {/* ───────────────── PHASE 1 — All Team Rankings ───────────────── */}
      {teamRankings.size > 0 && (
        <section className="tb-panel">
          <div className="tb-head">
            <h2 style={{ margin: 0, fontSize: 17 }}>🏟 All Team Rankings</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Every team's hitters, ranked within team — no weight changes, just re-organization
            </span>
          </div>
          <AllTeamRankings teams={teamRankings} asOf={asOf} oddsByPlayer={oddsByPlayer} />
        </section>
      )}

      <p className="subtle" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
        Team Board is a re-organization layer on top of the existing Heat Score. <strong>No weights
        change here.</strong> If the team-leader approach surfaces better candidates than the global
        Top 10, that's evidence to adopt it; if not, it's evidence that the global ranking is right.
      </p>

      <TeamBoardStyles />
    </>
  );
}

// =============================================================================
//  Sub-components
// =============================================================================

function TeamLeaderTable({ leaders, asOf, oddsByPlayer }: {
  leaders: HrTarget[]; asOf: string; oddsByPlayer: Map<number, SleeperOddsLite>;
}) {
  return (
    <div className="tb-table-wrap" style={{ marginTop: 8 }}>
      <table className="tb-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Player</th>
            <th>Team</th>
            <th>Opponent</th>
            <th className="num">Heat</th>
            <th>Confidence</th>
            <th className="num">Odds</th>
            <th>Matchup chips</th>
          </tr>
        </thead>
        <tbody>
          {leaders.map((t, i) => {
            const odds = oddsByPlayer.get(t.player_id) ?? null;
            return (
              <tr key={t.player_id}>
                <td className="num"><strong>{i + 1}</strong></td>
                <td>
                  <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`}>
                    {t.player_name}
                  </Link>
                  {t.is_elite_power && <span style={{ marginLeft: 4, color: 'var(--accent-2, #ff7a18)' }}>★</span>}
                </td>
                <td><span className="pill">{t.team}</span></td>
                <td className="subtle" style={{ fontSize: 12 }}>vs {t.opponent}</td>
                <td className="num"><strong>{t.heat_score.toFixed(1)}</strong></td>
                <td><ConfidenceBadge confidence={t.confidence} /></td>
                <td className="num">
                  {odds ? <>
                    <strong>{odds.american_odds > 0 ? '+' : ''}{odds.american_odds}</strong>
                    <span className="subtle" style={{ fontSize: 10, marginLeft: 4 }}>
                      {(odds.implied_prob * 100).toFixed(0)}%
                    </span>
                  </> : <span className="subtle">—</span>}
                </td>
                <td><ReasonChips chips={t.reason_chips.slice(0, 3)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TeamLeaderGrid({ leaders, asOf, oddsByPlayer }: {
  leaders: HrTarget[]; asOf: string; oddsByPlayer: Map<number, SleeperOddsLite>;
}) {
  return (
    <div className="tb-grid" style={{ marginTop: 8 }}>
      {leaders.map((t) => {
        const odds = oddsByPlayer.get(t.player_id) ?? null;
        return (
          <div key={t.player_id} className="tb-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="pill" style={{ fontSize: 10 }}>{t.team}</span>
              <span className="subtle" style={{ fontSize: 10 }}>heat <strong>{t.heat_score.toFixed(0)}</strong></span>
            </div>
            <div style={{ marginTop: 4 }}>
              <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`} style={{ fontSize: 13, fontWeight: 700 }}>
                {t.player_name}
              </Link>
              {t.is_elite_power && <span style={{ marginLeft: 4, color: 'var(--accent-2, #ff7a18)' }}>★</span>}
            </div>
            <div className="subtle" style={{ fontSize: 11, marginTop: 1 }}>
              vs {t.opponent}
              {odds && <> · <strong style={{ color: '#cfe' }}>{odds.american_odds > 0 ? '+' : ''}{odds.american_odds}</strong></>}
            </div>
            <div style={{ marginTop: 5 }}>
              <ReasonChips chips={t.reason_chips.slice(0, 2)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AllTeamRankings({ teams, asOf, oddsByPlayer }: {
  teams: Map<string, HrTarget[]>; asOf: string; oddsByPlayer: Map<number, SleeperOddsLite>;
}) {
  // Sort teams by their #1 hitter's heat score desc — strongest dugouts first.
  const teamOrder = useMemo(() => {
    return Array.from(teams.entries())
      .sort(([, a], [, b]) => (b[0]?.heat_score ?? 0) - (a[0]?.heat_score ?? 0));
  }, [teams]);

  return (
    <div className="tb-team-grid" style={{ marginTop: 8 }}>
      {teamOrder.map(([team, hitters]) => (
        <TeamCard
          key={team}
          team={team}
          hitters={hitters}
          asOf={asOf}
          oddsByPlayer={oddsByPlayer}
        />
      ))}
    </div>
  );
}

function TeamCard({ team, hitters, asOf, oddsByPlayer }: {
  team: string; hitters: HrTarget[]; asOf: string; oddsByPlayer: Map<number, SleeperOddsLite>;
}) {
  const top1 = hitters[0];
  return (
    <details className="tb-team-card">
      <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{team}</div>
            <div className="subtle" style={{ fontSize: 11 }}>
              #1 {top1.player_name} · {hitters.length} ranked
            </div>
          </div>
          <span className="subtle" style={{ fontSize: 11 }}>heat <strong>{top1.heat_score.toFixed(0)}</strong></span>
        </div>
      </summary>
      <div className="tb-table-wrap" style={{ marginTop: 8 }}>
        <table className="tb-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Player</th>
              <th className="num">Heat</th>
              <th>Conf</th>
              <th className="num">Odds</th>
              <th>Chips</th>
            </tr>
          </thead>
          <tbody>
            {hitters.map((t, i) => {
              const odds = oddsByPlayer.get(t.player_id) ?? null;
              return (
                <tr key={t.player_id}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`}>
                      {t.player_name}
                    </Link>
                    {t.is_elite_power && <span style={{ marginLeft: 4, color: 'var(--accent-2, #ff7a18)' }}>★</span>}
                  </td>
                  <td className="num"><strong>{t.heat_score.toFixed(1)}</strong></td>
                  <td><ConfidenceBadge confidence={t.confidence} compact /></td>
                  <td className="num">{odds ? `${odds.american_odds > 0 ? '+' : ''}${odds.american_odds}` : '—'}</td>
                  <td><ReasonChips chips={t.reason_chips.slice(0, 2)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ConfidenceBadge({ confidence, compact }: { confidence: 'high' | 'medium' | 'low'; compact?: boolean }) {
  const color = confidence === 'high' ? '#6bd482' : confidence === 'medium' ? '#ffd28c' : '#aab1c0';
  return (
    <span
      title={`${confidence} confidence`}
      style={{
        display: 'inline-block',
        padding: compact ? '0 5px' : '1px 7px',
        borderRadius: 999,
        fontSize: compact ? 9 : 10,
        fontWeight: 700,
        background: 'transparent',
        border: `1px solid ${color}`,
        color,
      }}
    >
      {compact ? confidence.charAt(0).toUpperCase() : confidence}
    </span>
  );
}

function TeamBoardStyles() {
  return (
    <style>{`
      .tb-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 12px;
      }
      .tb-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
      .tb-table-wrap { overflow-x: auto; }
      .tb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .tb-table th, .tb-table td {
        text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330);
        white-space: nowrap;
      }
      .tb-table th.num, .tb-table td.num { text-align: right; }
      .tb-table tbody tr:hover { background: rgba(255,255,255,0.02); }
      .tb-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px;
      }
      .tb-card {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 10px;
      }
      .tb-team-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 8px;
      }
      .tb-team-card {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 10px;
      }
      .tb-team-card[open] { border-color: var(--accent-2, #ff7a18); }
    `}</style>
  );
}
