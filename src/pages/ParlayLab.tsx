/**
 * /lab — "Parlay Lab"
 *
 * Evolves the HR Tracker from a player ranking tool into a parlay-rule lab.
 * Three deterministic styles run live AND historically against saved data:
 *   • Safe   — top model probability, book agrees
 *   • Value  — strong heat + positive edge over the book
 *   • Chaos  — longshots with stacked upside signals
 *
 * The page has two halves:
 *
 *   TOP — Today's 3 parlays. The user can see the same generation rules
 *         that run in the backtest, applied to tonight's data.
 *
 *   BOTTOM — Historical performance. Per-style 3/3 and 2/3 hit rates over
 *            7d/14d/30d windows. Best performing style for the window. A
 *            per-day breakdown table showing legs + hit flags. And a miss
 *            analysis: HR hitters NOT in any parlay with the reason.
 *
 * The goal isn't to bet these directly — it's to TEST repeatable rules
 * and see which historically work before applying them tomorrow.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  supabase, fetchPlayerIndex, fetchPitcherFormIndex, fetchOddsSnapshots,
  type GameRow, type HomeRunRow, type HrTargetSnapshotRow,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  addDays,
  analyzeParlayMisses,
  applyCanonicalTeams,
  backtestParlays,
  computeHrTargets,
  generateParlays,
  hrTargetToParlayCandidate,
  pitcherHrLeaderboard,
  snapshotToParlayCandidate,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  PARLAY_STYLE_LABELS,
  PARLAY_STYLE_DESCRIPTIONS,
  type HrTargetGame,
  type OddsIndex,
  type Parlay,
  type ParlayBacktestResult,
  type ParlayCandidate,
  type ParlayMissAnalysis,
  type ParlayStyle,
  type ParlayStyleSummary,
  type PitcherFormLite,
  type PlayerTeamIndex,
  type RevAnalysisSnapshotRow,
  type SleeperOddsLite,
} from '../lib/stats';

const todayISO = mlbToday;
const PAGE = 1000;

// =============================================================================
//  Fetchers
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
async function fetchSnapshotRange(from: string, to: string): Promise<HrTargetSnapshotRow[]> {
  const all: HrTargetSnapshotRow[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await supabase
      .from('hr_target_snapshots').select('*')
      .gte('target_date', from).lte('target_date', to)
      .order('target_date', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as HrTargetSnapshotRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
async function fetchHrsRange(from: string, to: string): Promise<HomeRunRow[]> {
  const all: HomeRunRow[] = [];
  for (let page = 0; page < 30; page++) {
    const { data, error } = await supabase
      .from('home_runs').select('id, game_pk, game_date, player_id, player_name, team, opponent, inning, pitcher_id, pitcher_name, exit_velocity, launch_angle, distance, batter_side, pitcher_throws, venue_id, venue_name, created_at')
      .gte('game_date', from).lte('game_date', to)
      .order('game_date', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as unknown as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

// =============================================================================
//  Page
// =============================================================================
export default function ParlayLab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTarget = searchParams.get('date') ?? todayISO();
  const [targetDate, setTargetDateState] = useState<string>(initialTarget);
  const asOf = useMemo(() => addDays(targetDate, -1), [targetDate]);

  // ---- Live (today's parlays) data ----
  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [pitcherStartsForm, setPitcherStartsForm] = useState<Map<number, PitcherFormLite>>(new Map());
  const [oddsByPlayer, setOddsByPlayer] = useState<Map<number, SleeperOddsLite>>(new Map());

  // ---- Backtest data ----
  const [backtest, setBacktest] = useState<ParlayBacktestResult | null>(null);
  const [missAnalysis, setMissAnalysis] = useState<ParlayMissAnalysis | null>(null);

  const [loading, setLoading] = useState(true);
  const [bktLoading, setBktLoading] = useState(true);
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

  // ---- Main fetch: today's data for live parlay generation ----
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

  // ---- Historical fetch: 30 days for backtest + miss analysis ----
  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    setBktLoading(true);
    (async () => {
      try {
        const anchor = addDays(targetDate, -1);
        const from30 = addDays(anchor, -29);
        const [snaps, hrs] = await Promise.all([
          fetchSnapshotRange(from30, anchor),
          fetchHrsRange(from30, anchor),
        ]);
        if (cancelled) return;
        const hrByDate = new Map<string, Set<number>>();
        const hrInfo = new Map<number, { player_name: string; team: string }>();
        for (const r of hrs) {
          let s = hrByDate.get(r.game_date);
          if (!s) { s = new Set<number>(); hrByDate.set(r.game_date, s); }
          s.add(r.player_id);
          if (!hrInfo.has(r.player_id)) hrInfo.set(r.player_id, { player_name: r.player_name, team: r.team });
        }
        const minimal: RevAnalysisSnapshotRow[] = snaps.map((r) => ({
          target_date: r.target_date, player_id: r.player_id,
          player_name: r.player_name, team: r.team,
          rank: r.rank, heat_score: r.heat_score, reason: r.reason,
        }));
        // Historical odds index
        const oddsIdx: OddsIndex = new Map();
        try {
          for (let page = 0; page < 30; page++) {
            const { data, error } = await supabase
              .from('odds_snapshots')
              .select('target_date, player_id, american_odds, snapshot_time')
              .gte('target_date', from30).lte('target_date', anchor)
              .order('snapshot_time', { ascending: true })
              .range(page * PAGE, page * PAGE + PAGE - 1);
            if (error) break;
            const rows = (data ?? []) as { target_date: string; player_id: number | null; american_odds: number }[];
            for (const r of rows) {
              if (r.player_id == null) continue;
              oddsIdx.set(`${r.target_date}:${r.player_id}`, r.american_odds);
            }
            if (rows.length < PAGE) break;
          }
        } catch { /* graceful */ }

        const bkt = backtestParlays(minimal, hrByDate, oddsIdx, anchor, 30);
        const miss = analyzeParlayMisses(minimal, hrByDate, oddsIdx, hrInfo, bkt.days, anchor, 30);
        setBacktest(bkt);
        setMissAnalysis(miss);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[lab] backtest fetch failed:', e);
        setBacktest(null);
        setMissAnalysis(null);
      } finally {
        if (!cancelled) setBktLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [targetDate, refreshKey]);

  // ---- Build today's candidate set ----
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
        pitcher_id: p.pitcher_id, pitcher_throws: p.pitcher_throws,
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
      home_lineup: g.home_lineup ?? null, away_lineup: g.away_lineup ?? null,
      lineups_confirmed: g.lineups_confirmed ?? false,
      game_status: g.status ?? null,
    })),
    [games],
  );
  const boards = useMemo(
    () => computeHrTargets(canonHrs, asOf, targetGames, { pitcherIndex, venueIndex, elitePowerIds }),
    [canonHrs, asOf, targetGames, pitcherIndex, venueIndex, elitePowerIds],
  );
  const todayCandidates: ParlayCandidate[] = useMemo(() => {
    const all = boards.flatMap((b) => [...b.away_targets, ...b.home_targets]);
    const eligible = all
      .filter((t) => t.lineup_status === 'confirmed' || t.lineup_status === 'pending')
      .sort((a, b) => b.heat_score - a.heat_score);
    // attach game_pk by matching team to board
    const teamToGame = new Map<string, number>();
    for (const b of boards) {
      teamToGame.set(b.home_team, b.game_pk);
      teamToGame.set(b.away_team, b.game_pk);
    }
    return eligible.map((t, i) => {
      const c = hrTargetToParlayCandidate(t, i + 1, oddsByPlayer.get(t.player_id) ?? null);
      c.game_pk = teamToGame.get(t.team) ?? null;
      return c;
    });
  }, [boards, oddsByPlayer]);

  const todayParlays = useMemo(() => generateParlays(todayCandidates), [todayCandidates]);

  const today = todayISO();
  const tomorrow = addDays(today, 1);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>🧪 Parlay Lab</h1>
        <span className="subtle" style={{ fontSize: 13 }}>
          three deterministic styles — Safe, Value, Chaos — tested against history
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          <Link to={`/card?date=${targetDate}`} style={{ fontSize: 13 }}>The Card →</Link>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* ───────────────── TODAY'S PARLAYS ─────────────────  */}
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Tonight's 3 Parlays</h2>
      <div className="lab-parlay-grid">
        <ParlayCard parlay={todayParlays.safe} accent="#4cd97a" />
        <ParlayCard parlay={todayParlays.value} accent="#ffb86c" />
        <ParlayCard parlay={todayParlays.chaos} accent="#c084fc" />
      </div>
      {loading && <div className="subtle" style={{ marginTop: 6 }}>Loading {targetDate}…</div>}

      {/* ───────────────── BACKTEST RESULTS ─────────────────  */}
      <h2 style={{ fontSize: 18, margin: '20px 0 8px' }}>📊 Historical Performance ({backtest?.days_counted ?? '…'} days)</h2>

      {bktLoading ? (
        <div className="subtle">Running backtest…</div>
      ) : !backtest ? (
        <div className="subtle">No historical data available.</div>
      ) : (
        <>
          <BestStyleCard backtest={backtest} />
          <SummaryGrid backtest={backtest} />
          <BacktestDayTable backtest={backtest} asOf={asOf} />
          {missAnalysis && <MissAnalysisPanel miss={missAnalysis} />}
        </>
      )}

      <p className="subtle" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
        Backtest applies the SAME generation rules used live, against the saved snapshots and saved odds for each
        past date. No outcome peeking, no per-day rule tuning. "Skipped" days are days where the rules couldn't find
        3 qualifying legs — counted honestly rather than padded.
      </p>
      <LabStyles />
    </>
  );
}

// =============================================================================
//  Sub-components
// =============================================================================

function ParlayCard({ parlay, accent }: { parlay: Parlay; accent: string }) {
  const label = PARLAY_STYLE_LABELS[parlay.style];
  const desc = PARLAY_STYLE_DESCRIPTIONS[parlay.style];
  const incomplete = parlay.incomplete;
  return (
    <div className="lab-parlay" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: accent }}>{label}</h3>
        <span className="subtle" style={{ fontSize: 11 }}>
          {parlay.legs.length}/3 legs
        </span>
      </div>
      <p className="subtle" style={{ fontSize: 11, margin: '4px 0 6px', lineHeight: 1.35 }}>{desc}</p>
      {incomplete ? (
        <div className="subtle" style={{ fontSize: 12, padding: '6px 0' }}>
          Rules couldn't fill 3 qualifying legs for this date.
        </div>
      ) : (
        <>
          {parlay.legs.map((leg, i) => (
            <div key={leg.player_id} className="lab-leg">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}. {leg.player_name}</span>
                <span className="subtle" style={{ fontSize: 11 }}>
                  {leg.team} · heat <strong>{leg.heat_score.toFixed(0)}</strong>
                </span>
              </div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 1 }}>
                {leg.american_odds != null ? (
                  <>{leg.american_odds > 0 ? '+' : ''}{leg.american_odds} · model {(leg.model_prob * 100).toFixed(1)}%
                    {leg.edge != null && (
                      <> · edge <strong style={{ color: leg.edge > 0 ? '#6bd482' : '#e07a7a' }}>
                        {leg.edge > 0 ? '+' : ''}{(leg.edge * 100).toFixed(1)} pp
                      </strong></>
                    )}
                  </>
                ) : (
                  <>no odds · model {(leg.model_prob * 100).toFixed(1)}%</>
                )}
              </div>
            </div>
          ))}
          {parlay.parlay_american != null && (
            <div className="lab-parlay-payout">
              <span>Parlay {parlay.parlay_american > 0 ? '+' : ''}{parlay.parlay_american}</span>
              {parlay.parlay_implied != null && (
                <span className="subtle" style={{ fontSize: 11, marginLeft: 6 }}>
                  ({(parlay.parlay_implied * 100).toFixed(2)}% book) · model {(parlay.parlay_model_prob * 100).toFixed(2)}%
                </span>
              )}
            </div>
          )}
        </>
      )}
      <p className="subtle" style={{ fontSize: 10, marginTop: 6, opacity: 0.65 }}>
        <em>Rule:</em> {parlay.rule_text}
      </p>
    </div>
  );
}

function BestStyleCard({ backtest }: { backtest: ParlayBacktestResult }) {
  const labels: Record<ParlayStyle, string> = PARLAY_STYLE_LABELS;
  const colors: Record<ParlayStyle, string> = { safe: '#4cd97a', value: '#ffb86c', chaos: '#c084fc' };
  const bestSummary = backtest[`${backtest.best_style}_summary` as 'safe_summary' | 'value_summary' | 'chaos_summary'];
  return (
    <div className="lab-best">
      <div style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.05 }}>
        Best performing style ({backtest.best_style_window})
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: colors[backtest.best_style] }}>
          {labels[backtest.best_style]}
        </span>
        <span style={{ fontSize: 14 }}>
          {(bestSummary.full_hit_rate * 100).toFixed(1)}% full hit · {(bestSummary.partial_2of3_rate * 100).toFixed(1)}% 2/3 · {(bestSummary.per_leg_hit_rate * 100).toFixed(1)}% per leg
        </span>
      </div>
      <div className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
        Picked by 3/3 hit rate, with 2/3 and per-leg as tiebreakers. {bestSummary.parlays_built} parlays built.
      </div>
    </div>
  );
}

function SummaryGrid({ backtest }: { backtest: ParlayBacktestResult }) {
  return (
    <div className="lab-summary-grid">
      <SummaryColumn label="Safe" summary={backtest.safe_summary} accent="#4cd97a" rolling7={backtest.rolling_7d.safe} rolling14={backtest.rolling_14d.safe} rolling30={backtest.rolling_30d.safe} />
      <SummaryColumn label="Value" summary={backtest.value_summary} accent="#ffb86c" rolling7={backtest.rolling_7d.value} rolling14={backtest.rolling_14d.value} rolling30={backtest.rolling_30d.value} />
      <SummaryColumn label="Chaos" summary={backtest.chaos_summary} accent="#c084fc" rolling7={backtest.rolling_7d.chaos} rolling14={backtest.rolling_14d.chaos} rolling30={backtest.rolling_30d.chaos} />
    </div>
  );
}

function SummaryColumn({ label, summary, accent, rolling7, rolling14, rolling30 }: {
  label: string; summary: ParlayStyleSummary; accent: string;
  rolling7: ParlayStyleSummary; rolling14: ParlayStyleSummary; rolling30: ParlayStyleSummary;
}) {
  return (
    <div className="lab-summary" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 14, color: accent }}>{label}</h3>
        <span className="subtle" style={{ fontSize: 11 }}>{summary.parlays_built}/{summary.parlays_built + summary.days_skipped} days</span>
      </div>
      <table className="lab-summary-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">7d</th>
            <th className="num">14d</th>
            <th className="num">30d</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Full (3/3)</td>
            <td className="num">{pct(rolling7.full_hit_rate)} <small className="subtle">({rolling7.full_hits}/{rolling7.parlays_built})</small></td>
            <td className="num">{pct(rolling14.full_hit_rate)} <small className="subtle">({rolling14.full_hits}/{rolling14.parlays_built})</small></td>
            <td className="num">{pct(rolling30.full_hit_rate)} <small className="subtle">({rolling30.full_hits}/{rolling30.parlays_built})</small></td>
          </tr>
          <tr>
            <td>2/3</td>
            <td className="num">{pct(rolling7.partial_2of3_rate)}</td>
            <td className="num">{pct(rolling14.partial_2of3_rate)}</td>
            <td className="num">{pct(rolling30.partial_2of3_rate)}</td>
          </tr>
          <tr>
            <td>Per leg</td>
            <td className="num">{pct(rolling7.per_leg_hit_rate)}</td>
            <td className="num">{pct(rolling14.per_leg_hit_rate)}</td>
            <td className="num">{pct(rolling30.per_leg_hit_rate)}</td>
          </tr>
          <tr>
            <td>Avg parlay odds</td>
            <td className="num">{rolling7.avg_parlay_american != null ? `${rolling7.avg_parlay_american > 0 ? '+' : ''}${Math.round(rolling7.avg_parlay_american)}` : '—'}</td>
            <td className="num">{rolling14.avg_parlay_american != null ? `${rolling14.avg_parlay_american > 0 ? '+' : ''}${Math.round(rolling14.avg_parlay_american)}` : '—'}</td>
            <td className="num">{rolling30.avg_parlay_american != null ? `${rolling30.avg_parlay_american > 0 ? '+' : ''}${Math.round(rolling30.avg_parlay_american)}` : '—'}</td>
          </tr>
          <tr>
            <td>Avg $/parlay</td>
            <td className={`num ${rolling7.avg_payout_per_dollar != null && rolling7.avg_payout_per_dollar > 0 ? 'lab-pos' : 'lab-neg'}`}>
              {rolling7.avg_payout_per_dollar != null ? `${rolling7.avg_payout_per_dollar > 0 ? '+' : ''}$${rolling7.avg_payout_per_dollar.toFixed(2)}` : '—'}
            </td>
            <td className={`num ${rolling14.avg_payout_per_dollar != null && rolling14.avg_payout_per_dollar > 0 ? 'lab-pos' : 'lab-neg'}`}>
              {rolling14.avg_payout_per_dollar != null ? `${rolling14.avg_payout_per_dollar > 0 ? '+' : ''}$${rolling14.avg_payout_per_dollar.toFixed(2)}` : '—'}
            </td>
            <td className={`num ${rolling30.avg_payout_per_dollar != null && rolling30.avg_payout_per_dollar > 0 ? 'lab-pos' : 'lab-neg'}`}>
              {rolling30.avg_payout_per_dollar != null ? `${rolling30.avg_payout_per_dollar > 0 ? '+' : ''}$${rolling30.avg_payout_per_dollar.toFixed(2)}` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function BacktestDayTable({ backtest, asOf }: { backtest: ParlayBacktestResult; asOf: string }) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const sorted = backtest.days.slice().reverse(); // most recent first
  const focused = selectedDate ? backtest.days.find((d) => d.date === selectedDate) : null;
  return (
    <div className="lab-panel" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>Per-day Backtest</h3>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        Click a row to see the parlay legs + hit flags for that date.
      </p>
      <div className="diag-table-wrap" style={{ marginTop: 8 }}>
        <table className="lab-day-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Safe</th>
              <th>Value</th>
              <th>Chaos</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => (
              <tr
                key={d.date}
                onClick={() => setSelectedDate(d.date === selectedDate ? null : d.date)}
                style={{ cursor: 'pointer', background: d.date === selectedDate ? 'rgba(255,255,255,0.04)' : undefined }}
              >
                <td><strong>{d.date}</strong></td>
                <td><LegPills hits={d.safe.leg_hits} incomplete={d.safe.parlay.incomplete} full={d.safe.full_hit} partial={d.safe.partial_2of3} /></td>
                <td><LegPills hits={d.value.leg_hits} incomplete={d.value.parlay.incomplete} full={d.value.full_hit} partial={d.value.partial_2of3} /></td>
                <td><LegPills hits={d.chaos.leg_hits} incomplete={d.chaos.parlay.incomplete} full={d.chaos.full_hit} partial={d.chaos.partial_2of3} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {focused && (
        <div className="lab-focused">
          <FocusedDay day={focused} />
        </div>
      )}
    </div>
  );
}

function LegPills({ hits, incomplete, full, partial }: { hits: boolean[]; incomplete: boolean; full: boolean; partial: boolean }) {
  if (incomplete) return <span className="subtle" style={{ fontSize: 11 }}>skipped</span>;
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
      {hits.map((h, i) => (
        <span key={i} className={`lab-leg-pill ${h ? 'lab-leg-pill--hit' : 'lab-leg-pill--miss'}`}>{h ? '✓' : '·'}</span>
      ))}
      {full && <span className="lab-result lab-result--full">3/3</span>}
      {!full && partial && <span className="lab-result lab-result--partial">2/3</span>}
      {!full && !partial && <span className="lab-result lab-result--bust">{hits.filter(Boolean).length}/3</span>}
    </div>
  );
}

function FocusedDay({ day }: { day: ParlayBacktestResult['days'][number] }) {
  return (
    <div style={{ marginTop: 10 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{day.date} — full breakdown</h4>
      <div className="lab-parlay-grid">
        <FocusedParlay r={day.safe} accent="#4cd97a" />
        <FocusedParlay r={day.value} accent="#ffb86c" />
        <FocusedParlay r={day.chaos} accent="#c084fc" />
      </div>
    </div>
  );
}

function FocusedParlay({ r, accent }: {
  r: ParlayBacktestResult['days'][number]['safe'];
  accent: string;
}) {
  const p = r.parlay;
  if (p.incomplete) {
    return (
      <div className="lab-parlay" style={{ borderTop: `3px solid ${accent}` }}>
        <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{PARLAY_STYLE_LABELS[p.style]}</h4>
        <p className="subtle" style={{ fontSize: 11, marginTop: 4 }}>Skipped — rules couldn't fill 3 legs.</p>
      </div>
    );
  }
  return (
    <div className="lab-parlay" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{PARLAY_STYLE_LABELS[p.style]}</h4>
        <span style={{ fontSize: 12, fontWeight: 700, color: r.full_hit ? '#6bd482' : r.partial_2of3 ? '#ffd28c' : '#e07a7a' }}>
          {r.legs_hit}/3
        </span>
      </div>
      <div style={{ marginTop: 4 }}>
        {p.legs.map((leg, i) => (
          <div key={leg.player_id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, padding: '3px 0' }}>
            <span style={{ color: r.leg_hits[i] ? '#6bd482' : '#aab1c0', fontWeight: 700, width: 16 }}>
              {r.leg_hits[i] ? '✓' : '·'}
            </span>
            <span style={{ fontWeight: 600 }}>{leg.player_name}</span>
            <span className="subtle" style={{ fontSize: 10 }}>{leg.team}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.7 }}>
              {leg.american_odds != null ? `${leg.american_odds > 0 ? '+' : ''}${leg.american_odds}` : '—'}
            </span>
          </div>
        ))}
      </div>
      {p.parlay_american != null && (
        <div className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
          Parlay {p.parlay_american > 0 ? '+' : ''}{p.parlay_american} · {r.full_hit ? `won $${(p.parlay_decimal! - 1).toFixed(2)}/$1` : 'lost $1'}
        </div>
      )}
    </div>
  );
}

function MissAnalysisPanel({ miss }: { miss: ParlayMissAnalysis }) {
  return (
    <div className="lab-panel" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>🔎 HRs not in any parlay ({miss.total_missed} of {miss.total_hr_hitters})</h3>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        For HR hitters the model didn't include in Safe, Value, or Chaos — why the rules excluded them.
      </p>
      <div className="lab-miss-grid" style={{ marginTop: 8 }}>
        {miss.aggregates.map((a) => (
          <div key={a.reason} className="lab-miss-tile">
            <div className="lab-miss-count">{a.count}</div>
            <div className="lab-miss-label">{a.label}</div>
            <div className="lab-miss-share">{pct(a.share, 0)}</div>
          </div>
        ))}
      </div>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
          Per-player miss list ({miss.missed.length})
        </summary>
        <div className="diag-table-wrap" style={{ marginTop: 6 }}>
          <table className="lab-miss-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Player</th>
                <th>Team</th>
                <th className="num">Rank</th>
                <th className="num">Heat</th>
                <th className="num">Odds</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {miss.missed.slice(0, 100).map((m) => (
                <tr key={`${m.date}-${m.player_id}`}>
                  <td>{m.date}</td>
                  <td>{m.player_name}</td>
                  <td>{m.team || '—'}</td>
                  <td className="num">{m.rank ?? '—'}</td>
                  <td className="num">{m.heat_score?.toFixed(0) ?? '—'}</td>
                  <td className="num">{m.american_odds != null ? `${m.american_odds > 0 ? '+' : ''}${m.american_odds}` : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {m.reasons.map((r) => (
                        <span key={r} className="lab-miss-chip">{r.replace(/_/g, ' ')}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function pct(n: number, d = 1): string {
  return `${(n * 100).toFixed(d)}%`;
}

function LabStyles() {
  return (
    <style>{`
      .lab-parlay-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 10px;
      }
      .lab-parlay {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 10px 12px;
      }
      .lab-leg {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 6px;
        padding: 6px 9px;
        margin-top: 4px;
      }
      .lab-parlay-payout {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px solid var(--border, #232732);
        font-size: 13px;
        font-weight: 700;
        color: #cfe;
      }
      .lab-best {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-left: 4px solid #ffd28c;
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 10px;
      }
      .lab-summary-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 10px;
      }
      .lab-summary {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .lab-summary-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
      .lab-summary-table th, .lab-summary-table td { padding: 4px 5px; border-bottom: 1px solid var(--border, #1f2330); text-align: left; }
      .lab-summary-table th.num, .lab-summary-table td.num { text-align: right; }
      .lab-pos { color: #6bd482; }
      .lab-neg { color: #e07a7a; }

      .lab-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 12px 14px;
      }
      .lab-day-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .lab-day-table th, .lab-day-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .lab-day-table tbody tr:hover { background: rgba(255,255,255,0.02); }

      .lab-leg-pill {
        display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center;
        border-radius: 4px; font-size: 11px; font-weight: 700;
      }
      .lab-leg-pill--hit  { background: rgba(64,200,120,0.20); color: #6bd482; }
      .lab-leg-pill--miss { background: rgba(170,177,192,0.15); color: #aab1c0; }
      .lab-result {
        margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
      }
      .lab-result--full    { background: rgba(64,200,120,0.20); color: #6bd482; }
      .lab-result--partial { background: rgba(255,210,140,0.20); color: #ffd28c; }
      .lab-result--bust    { background: rgba(150,150,170,0.15); color: #aab1c0; }
      .lab-focused {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--border, #232732);
      }

      .lab-miss-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 6px;
      }
      .lab-miss-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 6px;
        padding: 6px 9px;
        text-align: center;
      }
      .lab-miss-count { font-size: 18px; font-weight: 700; color: #cfe; }
      .lab-miss-label { font-size: 11px; opacity: 0.8; margin-top: 1px; }
      .lab-miss-share { font-size: 10px; opacity: 0.55; }
      .lab-miss-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .lab-miss-table th, .lab-miss-table td { padding: 4px 6px; border-bottom: 1px solid var(--border, #1f2330); text-align: left; white-space: nowrap; }
      .lab-miss-table th.num, .lab-miss-table td.num { text-align: right; }
      .lab-miss-chip {
        display: inline-block; padding: 1px 6px; border-radius: 999px;
        font-size: 9.5px; font-weight: 600;
        background: rgba(192,132,252,0.12); color: #c084fc; border: 1px solid rgba(192,132,252,0.35);
        text-transform: capitalize;
      }
    `}</style>
  );
}
