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
  fetchModelVersions, fetchLearningPredictions, fetchFeatureImportance,
  type GameRow, type HomeRunRow, type HrTargetSnapshotRow,
  type ModelVersionRow, type LearningPredictionRow, type FeatureImportanceRowDB,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  addDays,
  analyzeParlayMisses,
  applyCanonicalTeams,
  backtestParlays,
  computeCoverageScore,
  computeHrTargets,
  rollupClassifications,
  generateParlays,
  hrTargetToParlayCandidate,
  pitcherHrLeaderboard,
  snapshotToParlayCandidate,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  PARLAY_STYLE_LABELS,
  PARLAY_STYLE_DESCRIPTIONS,
  type CoverageScore,
  type HrTargetGame,
  type MissGameInfo,
  type MissHrRow,
  type OddsIndex,
  type Parlay,
  type ParlayBacktestResult,
  type ParlayCandidate,
  type ParlayMissAnalysis,
  type ParlayMissedHitter,
  type ParlayMissCategory,
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
  const [coverage, setCoverage] = useState<CoverageScore | null>(null);

  // ---- Learning Engine state (migration 013) ----
  const [modelVersions, setModelVersions] = useState<ModelVersionRow[]>([]);
  const [learningPreds, setLearningPreds] = useState<LearningPredictionRow[]>([]);
  const [featureImportance, setFeatureImportance] = useState<FeatureImportanceRowDB[]>([]);
  const [learningLoading, setLearningLoading] = useState<boolean>(true);
  const [learningWindow, setLearningWindow] = useState<7 | 14 | 30>(14);

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

  // ---- Historical fetch: 30 days for backtest + miss analysis + coverage ----
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

        // ---- Build per-date HR set + per-(date,player) HR row info ----
        const hrByDate = new Map<string, Set<number>>();
        const hrRows: MissHrRow[] = [];
        // Aggregate HRs to player-day (a player who hits 2 HR same day = 1 row, hr_count=2)
        const seen = new Map<string, MissHrRow>();
        for (const r of hrs) {
          const key = `${r.game_date}:${r.player_id}`;
          const existing = seen.get(key);
          if (existing) {
            existing.hr_count += 1;
            continue;
          }
          const row: MissHrRow = {
            date: r.game_date,
            player_id: r.player_id,
            player_name: r.player_name,
            team: r.team,
            opponent: r.opponent,
            game_pk: r.game_pk,
            hr_count: 1,
          };
          seen.set(key, row);
          hrRows.push(row);
          let s = hrByDate.get(r.game_date);
          if (!s) { s = new Set<number>(); hrByDate.set(r.game_date, s); }
          s.add(r.player_id);
        }

        const minimal: RevAnalysisSnapshotRow[] = snaps.map((r) => ({
          target_date: r.target_date, player_id: r.player_id,
          player_name: r.player_name, team: r.team,
          rank: r.rank, heat_score: r.heat_score, reason: r.reason,
        }));

        // ---- Historical odds index ----
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

        // ---- Historical games index — powers the data-vs-model miss classification ----
        const gamesByPk = new Map<number, MissGameInfo>();
        try {
          for (let page = 0; page < 10; page++) {
            const { data, error } = await supabase
              .from('games')
              .select('game_pk, game_date, home_team, away_team, status, processed, ' +
                'home_probable_pitcher_id, away_probable_pitcher_id, ' +
                'lineups_confirmed, home_lineup, away_lineup')
              .gte('game_date', from30).lte('game_date', anchor)
              .range(page * PAGE, page * PAGE + PAGE - 1);
            if (error) break;
            const rows = (data ?? []) as unknown as MissGameInfo[];
            for (const g of rows) gamesByPk.set(g.game_pk, g);
            if (rows.length < PAGE) break;
          }
        } catch { /* graceful — missing games table degrades to "missing_from_pool" classification */ }

        const bkt = backtestParlays(minimal, hrByDate, oddsIdx, anchor, 30);
        const miss = analyzeParlayMisses(minimal, hrRows, oddsIdx, gamesByPk, bkt.days, anchor, 30);
        const cov = computeCoverageScore(minimal, hrByDate, bkt.days, anchor, 30);
        setBacktest(bkt);
        setMissAnalysis(miss);
        setCoverage(cov);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[lab] backtest fetch failed:', e);
        setBacktest(null);
        setMissAnalysis(null);
        setCoverage(null);
      } finally {
        if (!cancelled) setBktLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [targetDate, refreshKey]);

  // ---- Learning Engine fetch: model versions + predictions + feature importance ----
  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    setLearningLoading(true);
    (async () => {
      try {
        const anchor = addDays(targetDate, -1);
        const from = addDays(anchor, -(learningWindow - 1));
        const versions = await fetchModelVersions();
        if (cancelled) return;
        setModelVersions(versions);
        const active = versions.find((v) => v.active) ?? versions[0];
        if (!active) {
          setLearningPreds([]);
          setFeatureImportance([]);
          return;
        }
        const [preds, importance] = await Promise.all([
          fetchLearningPredictions({ from, to: anchor, model_version: active.version }),
          fetchFeatureImportance({ model_version: active.version, window_days: learningWindow }),
        ]);
        if (cancelled) return;
        setLearningPreds(preds);
        setFeatureImportance(importance);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[lab] learning fetch failed:', e);
        setLearningPreds([]);
        setFeatureImportance([]);
      } finally {
        if (!cancelled) setLearningLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [targetDate, learningWindow, refreshKey]);

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
          {coverage && <CoveragePanel coverage={coverage} />}
          <BacktestDayTable backtest={backtest} asOf={asOf} />
          {missAnalysis && <MissAnalysisPanelV2 miss={missAnalysis} />}
          <LearningEnginePanel
            modelVersions={modelVersions}
            predictions={learningPreds}
            featureImportance={featureImportance}
            loading={learningLoading}
            windowDays={learningWindow}
            onWindowChange={setLearningWindow}
          />
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

// =============================================================================
//  Coverage Panel — total HRs / in pool / in Top 10 / in parlays / coverage %
// =============================================================================
function CoveragePanel({ coverage }: { coverage: CoverageScore }) {
  const poolColor = coverage.pool_coverage_rate >= 0.7 ? '#6bd482' : coverage.pool_coverage_rate >= 0.5 ? '#ffd28c' : '#e07a7a';
  const top10Color = coverage.top10_coverage_rate >= 0.20 ? '#6bd482' : coverage.top10_coverage_rate >= 0.12 ? '#ffd28c' : '#e07a7a';
  const parlayColor = coverage.parlay_coverage_rate >= 0.10 ? '#6bd482' : coverage.parlay_coverage_rate >= 0.05 ? '#ffd28c' : '#e07a7a';
  return (
    <div className="lab-panel" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>📊 Coverage Score ({coverage.window_days}d)</h3>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        How many actual HR hitters the model considered, ranked highly, and surfaced in parlays.
      </p>
      <div className="lab-coverage-grid" style={{ marginTop: 8 }}>
        <CoverageTile label="Total HR hitters" value={coverage.total_hr_hitters} sub="across all dates" color="#aab1c0" />
        <CoverageTile label="In model pool" value={coverage.total_in_pool} sub={`${(coverage.pool_coverage_rate * 100).toFixed(1)}% of HRs`} color={poolColor} />
        <CoverageTile label="In Top 10" value={coverage.total_in_top_10} sub={`${(coverage.top10_coverage_rate * 100).toFixed(1)}% of HRs`} color={top10Color} />
        <CoverageTile label="In parlays" value={coverage.total_in_parlays} sub={`${(coverage.parlay_coverage_rate * 100).toFixed(1)}% of HRs`} color={parlayColor} />
      </div>
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
          Per-day coverage breakdown ({coverage.days.length} days)
        </summary>
        <div className="diag-table-wrap" style={{ marginTop: 6 }}>
          <table className="lab-miss-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Total HRs</th>
                <th className="num">In pool</th>
                <th className="num">In Top 10</th>
                <th className="num">In parlays</th>
                <th className="num">Pool %</th>
              </tr>
            </thead>
            <tbody>
              {coverage.days.slice().reverse().map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{d.total_hr_hitters}</td>
                  <td className="num">{d.in_pool}</td>
                  <td className="num">{d.in_top_10}</td>
                  <td className="num">{d.in_parlays}</td>
                  <td className={`num ${d.pool_coverage >= 0.7 ? 'lab-pos' : d.pool_coverage >= 0.5 ? '' : 'lab-neg'}`}>
                    {(d.pool_coverage * 100).toFixed(0)}%
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

function CoverageTile({ label, value, sub, color }: { label: string; value: number; sub: string; color: string }) {
  return (
    <div className="lab-coverage-tile" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="lab-coverage-label">{label}</div>
      <div className="lab-coverage-value" style={{ color }}>{value.toLocaleString()}</div>
      <div className="lab-coverage-sub">{sub}</div>
    </div>
  );
}

// =============================================================================
//  Miss Analysis V2 — data vs model taxonomy
// =============================================================================
function MissAnalysisPanelV2({ miss }: { miss: ParlayMissAnalysis }) {
  const dataAggregates = miss.aggregates.filter((a) => a.category === 'data');
  const modelAggregates = miss.aggregates.filter((a) => a.category === 'model');
  const [filterCat, setFilterCat] = useState<'all' | 'data' | 'model'>('all');
  const visibleMisses = miss.missed.filter((m) => filterCat === 'all' || m.category === filterCat);

  return (
    <div className="lab-panel" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>
        🔎 HRs not in any parlay — {miss.total_missed} of {miss.total_hr_hitters}
      </h3>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        Split by category so you can tell <strong>data problems</strong> (we never saw them) from
        <strong> model problems</strong> (we had the data, ranked them low).
      </p>

      {/* Category split summary */}
      <div className="lab-cat-grid" style={{ marginTop: 8 }}>
        <div className="lab-cat-tile lab-cat-tile--data">
          <div className="lab-cat-label">DATA PROBLEMS</div>
          <div className="lab-cat-value">{miss.data_problems}</div>
          <div className="lab-cat-share">
            {miss.total_missed > 0 ? `${((miss.data_problems / miss.total_missed) * 100).toFixed(0)}% of misses` : '—'}
          </div>
          <div className="lab-cat-sub">missing lineup, no pitcher, not in pool, unprocessed</div>
        </div>
        <div className="lab-cat-tile lab-cat-tile--model">
          <div className="lab-cat-label">MODEL PROBLEMS</div>
          <div className="lab-cat-value">{miss.model_problems}</div>
          <div className="lab-cat-share">
            {miss.total_missed > 0 ? `${((miss.model_problems / miss.total_missed) * 100).toFixed(0)}% of misses` : '—'}
          </div>
          <div className="lab-cat-sub">low score, outside Top 50, blocked by filter</div>
        </div>
      </div>

      {/* Per-reason breakdown, grouped by category */}
      <div className="lab-cat-cols" style={{ marginTop: 12 }}>
        <ReasonBreakdown title="Data problems" reasons={dataAggregates} accent="#4cc7ff" />
        <ReasonBreakdown title="Model problems" reasons={modelAggregates} accent="#ffb86c" />
      </div>

      {/* Per-player table */}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.75 }}>
          Per-player miss table ({miss.missed.length} entries)
        </summary>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>Filter:</span>
          <FilterBtn active={filterCat === 'all'} onClick={() => setFilterCat('all')}>All ({miss.missed.length})</FilterBtn>
          <FilterBtn active={filterCat === 'data'} onClick={() => setFilterCat('data')}>Data ({miss.data_problems})</FilterBtn>
          <FilterBtn active={filterCat === 'model'} onClick={() => setFilterCat('model')}>Model ({miss.model_problems})</FilterBtn>
        </div>
        <div className="diag-table-wrap">
          <table className="lab-miss-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Player</th>
                <th>Team</th>
                <th>Opp</th>
                <th className="num">HRs</th>
                <th>Reason missed</th>
                <th className="num">Heat</th>
                <th className="num">Rank</th>
              </tr>
            </thead>
            <tbody>
              {visibleMisses.slice(0, 150).map((m) => (
                <tr key={`${m.date}-${m.player_id}`}>
                  <td>{m.date}</td>
                  <td>{m.player_name}</td>
                  <td>{m.team || '—'}</td>
                  <td>{m.opponent || '—'}</td>
                  <td className="num">{m.hr_count}</td>
                  <td>
                    <span className={`lab-cat-chip lab-cat-chip--${m.category}`}>
                      {prettyReason(m.primary_reason)}
                    </span>
                  </td>
                  <td className="num">{m.heat_score != null ? m.heat_score.toFixed(0) : '—'}</td>
                  <td className="num">{m.rank ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleMisses.length > 150 && (
            <p className="subtle" style={{ fontSize: 11, marginTop: 6, textAlign: 'right' }}>
              Showing 150 of {visibleMisses.length}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function ReasonBreakdown({ title, reasons, accent }: {
  title: string;
  reasons: { reason: string; label: string; count: number; share: number }[];
  accent: string;
}) {
  if (reasons.length === 0) {
    return (
      <div className="lab-reason-col" style={{ borderTop: `3px solid ${accent}` }}>
        <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{title}</h4>
        <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>None.</p>
      </div>
    );
  }
  return (
    <div className="lab-reason-col" style={{ borderTop: `3px solid ${accent}` }}>
      <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{title}</h4>
      <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
        {reasons.map((r) => (
          <li key={r.reason} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--border, #1f2330)' }}>
            <span style={{ fontSize: 12 }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {r.count} <span className="subtle" style={{ fontSize: 10, fontWeight: 400 }}>({(r.share * 100).toFixed(0)}%)</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilterBtn({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? '#2d3a52' : 'var(--panel-2, #14171f)',
        border: `1px solid ${active ? '#4a6fa5' : 'var(--border, #232732)'}`,
        color: active ? '#fff' : '#cfe',
        padding: '3px 9px',
        borderRadius: 6,
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function prettyReason(r: string): string {
  return r.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function pct(n: number, d = 1): string {
  return `${(n * 100).toFixed(d)}%`;
}

// =============================================================================
//  Learning Engine Panel (migration 013)
// =============================================================================

function LearningEnginePanel({
  modelVersions, predictions, featureImportance, loading, windowDays, onWindowChange,
}: {
  modelVersions: ModelVersionRow[];
  predictions: LearningPredictionRow[];
  featureImportance: FeatureImportanceRowDB[];
  loading: boolean;
  windowDays: 7 | 14 | 30;
  onWindowChange: (w: 7 | 14 | 30) => void;
}) {
  // Migration not yet applied → empty state with instructions.
  const migrationApplied = modelVersions.length > 0;
  const captured = predictions.filter((p) => p.classification != null);
  const classCounts = useMemo(
    () => rollupClassifications(captured.map((p) => ({ classification: p.classification! }))),
    [captured],
  );
  const sortedImportance = useMemo(
    () => featureImportance.slice().sort((a, b) => b.importance_score - a.importance_score),
    [featureImportance],
  );

  if (!loading && !migrationApplied) {
    return (
      <div className="lab-panel lab-learning" style={{ marginTop: 14 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>🧠 Learning Engine</h3>
        <p className="subtle" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
          The learning engine tracks every prediction's outcome and surfaces feature importance
          over time. <strong>Migration 013 hasn't been applied yet.</strong>
        </p>
        <pre className="lab-code-block">
{`-- In Supabase SQL editor, run:
supabase/migrations/013_learning_engine.sql

-- Then, after each completed slate:
npm run learning:capture -- yesterday`}
        </pre>
        <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
          Once data is captured, this panel will show TP/FP/FN/TN counts, precision/recall, feature
          importance rankings, and model-version performance over time.
        </p>
      </div>
    );
  }

  return (
    <div className="lab-panel lab-learning" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>🧠 Learning Engine</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, opacity: 0.7 }}>Window:</span>
          {([7, 14, 30] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onWindowChange(w)}
              style={{
                background: windowDays === w ? '#2d3a52' : 'var(--panel-2, #14171f)',
                border: `1px solid ${windowDays === w ? '#4a6fa5' : 'var(--border, #232732)'}`,
                color: windowDays === w ? '#fff' : '#cfe',
                padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
              }}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <p className="subtle" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
        Persistent feedback loop. Each captured day adds rows to <code>learning_predictions</code>,
        then refreshes <code>feature_importance</code>. Surfacing only — nothing here auto-changes the
        live weights.
      </p>

      {loading ? (
        <div className="subtle" style={{ fontSize: 12, marginTop: 8 }}>Loading…</div>
      ) : (
        <>
          {/* Classification breakdown */}
          <div className="lab-class-grid">
            <ClassTile label="True Positives" value={classCounts.TP} color="#6bd482" desc="Top-50 picks that homered" />
            <ClassTile label="False Positives" value={classCounts.FP} color="#ffb86c" desc="Top-50 picks that didn't" />
            <ClassTile label="False Negatives" value={classCounts.FN} color="#e07a7a" desc="Outside Top-50 but homered" />
            <ClassTile label="True Negatives" value={classCounts.TN} color="#aab1c0" desc="Outside Top-50, no HR" />
          </div>

          <div className="lab-class-stats">
            <div><span className="lab-class-stat-label">Precision</span><span className="lab-class-stat-value">{pct(classCounts.precision)}</span></div>
            <div><span className="lab-class-stat-label">Recall</span><span className="lab-class-stat-value">{pct(classCounts.recall)}</span></div>
            <div><span className="lab-class-stat-label">F1</span><span className="lab-class-stat-value">{pct(classCounts.f1)}</span></div>
            <div><span className="lab-class-stat-label">Accuracy</span><span className="lab-class-stat-value">{pct(classCounts.accuracy)}</span></div>
            <div className="subtle" style={{ fontSize: 11, alignSelf: 'center' }}>
              n = {classCounts.total} player-days captured
            </div>
          </div>

          {/* Feature importance */}
          <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>📐 Feature Importance ({windowDays}d)</h4>
          {sortedImportance.length === 0 ? (
            <p className="subtle" style={{ fontSize: 12 }}>
              No feature importance computed yet for {windowDays}d window. Run <code>npm run learning:capture -- yesterday</code> to refresh.
            </p>
          ) : (
            <div className="diag-table-wrap" style={{ marginTop: 4 }}>
              <table className="lab-fi-table">
                <thead>
                  <tr>
                    <th>Signal</th>
                    <th className="num">Importance</th>
                    <th className="num">Lift</th>
                    <th className="num">Present rate</th>
                    <th className="num">Absent rate</th>
                    <th className="num">N present</th>
                    <th>Sample</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedImportance.map((r) => (
                    <tr key={r.signal_key}>
                      <td><strong>{r.signal_label}</strong></td>
                      <td className="num"><strong>{r.importance_score.toFixed(3)}</strong></td>
                      <td className={`num ${r.lift > 1.15 ? 'lab-pos' : r.lift < 0.85 ? 'lab-neg' : ''}`}>
                        {r.lift.toFixed(2)}×
                      </td>
                      <td className="num">{pct(r.rate_present)}</td>
                      <td className="num">{pct(r.rate_absent)}</td>
                      <td className="num">{r.n_present}</td>
                      <td>
                        <span className={`lab-quality lab-quality--${r.sample_quality}`}>{r.sample_quality}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="subtle" style={{ fontSize: 10.5, marginTop: 6 }}>
                Importance = absolute Cohen's h (0 = no effect; ≥ 0.20 small; ≥ 0.50 medium; ≥ 0.80 large).
                Sorted by importance desc. Tiny-sample features are flagged "low" — treat as directional only.
              </p>
            </div>
          )}

          {/* Model version register */}
          <h4 style={{ margin: '14px 0 4px', fontSize: 13 }}>🧬 Model Versions</h4>
          <div className="diag-table-wrap">
            <table className="lab-mv-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Name</th>
                  <th>Created</th>
                  <th className="num">Per-leg</th>
                  <th className="num">Pool cov.</th>
                  <th className="num">Top-10 cov.</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {modelVersions.map((v) => (
                  <tr key={v.version}>
                    <td><strong>v{v.version}</strong></td>
                    <td>{v.name}</td>
                    <td>{v.created_at.slice(0, 10)}</td>
                    <td className="num">{v.per_leg_hit_rate != null ? pct(v.per_leg_hit_rate, 1) : '—'}</td>
                    <td className="num">{v.pool_coverage_rate != null ? pct(v.pool_coverage_rate, 1) : '—'}</td>
                    <td className="num">{v.top10_coverage_rate != null ? pct(v.top10_coverage_rate, 1) : '—'}</td>
                    <td>
                      {v.active && <span className="lab-active-chip">active</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="subtle" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.5 }}>
            History is append-only — no version is ever overwritten. <strong>Phase 3 (auto weight optimization)</strong> and
            <strong> Phase 5 (auto-deploy)</strong> are deferred — Phase 3 needs a schema change to save subscores per snapshot, and Phase 5
            wants approval gating so the live model never auto-updates from one bad sample. Both are tractable follow-ups.
          </p>
        </>
      )}
    </div>
  );
}

function ClassTile({ label, value, color, desc }: { label: string; value: number; color: string; desc: string }) {
  return (
    <div className="lab-class-tile" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="lab-class-label">{label}</div>
      <div className="lab-class-value" style={{ color }}>{value.toLocaleString()}</div>
      <div className="lab-class-desc">{desc}</div>
    </div>
  );
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

      /* Coverage tiles */
      .lab-coverage-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 6px;
      }
      .lab-coverage-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 12px;
      }
      .lab-coverage-label { font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .lab-coverage-value { font-size: 22px; font-weight: 700; margin-top: 2px; }
      .lab-coverage-sub { font-size: 10.5px; opacity: 0.65; margin-top: 1px; }

      /* Miss category split tiles */
      .lab-cat-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .lab-cat-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 10px 12px;
      }
      .lab-cat-tile--data  { border-left: 4px solid #4cc7ff; }
      .lab-cat-tile--model { border-left: 4px solid #ffb86c; }
      .lab-cat-label { font-size: 10.5px; opacity: 0.75; letter-spacing: 0.06em; font-weight: 700; }
      .lab-cat-value { font-size: 26px; font-weight: 700; color: #cfe; margin-top: 2px; }
      .lab-cat-share { font-size: 11px; opacity: 0.7; }
      .lab-cat-sub   { font-size: 10.5px; opacity: 0.6; margin-top: 2px; line-height: 1.35; }
      .lab-cat-cols {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .lab-reason-col {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 12px;
      }
      .lab-cat-chip {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        font-size: 10px; font-weight: 600; white-space: nowrap;
      }
      .lab-cat-chip--data  { background: rgba(76,199,255,0.14); color: #4cc7ff; border: 1px solid rgba(76,199,255,0.4); }
      .lab-cat-chip--model { background: rgba(255,184,108,0.14); color: #ffb86c; border: 1px solid rgba(255,184,108,0.4); }

      @media (max-width: 720px) {
        .lab-cat-grid { grid-template-columns: 1fr; }
        .lab-cat-cols { grid-template-columns: 1fr; }
      }

      /* Learning Engine panel */
      .lab-learning { border-left: 3px solid #c084fc; }
      .lab-code-block {
        background: #0c0e14; border: 1px solid #1f2330; border-radius: 6px;
        padding: 8px 12px; font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        margin: 6px 0; overflow-x: auto; line-height: 1.5;
      }
      .lab-class-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 6px; margin-top: 8px;
      }
      .lab-class-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 6px 10px;
      }
      .lab-class-label { font-size: 10.5px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .lab-class-value { font-size: 22px; font-weight: 700; margin-top: 2px; }
      .lab-class-desc  { font-size: 10px; opacity: 0.6; margin-top: 1px; }

      .lab-class-stats {
        display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
        margin-top: 8px; padding: 6px 10px;
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 6px;
      }
      .lab-class-stats > div { display: flex; flex-direction: column; }
      .lab-class-stat-label { font-size: 10px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .lab-class-stat-value { font-size: 16px; font-weight: 700; color: #cfe; }

      .lab-fi-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .lab-fi-table th, .lab-fi-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .lab-fi-table th.num, .lab-fi-table td.num { text-align: right; }
      .lab-fi-table tbody tr:hover { background: rgba(255,255,255,0.02); }
      .lab-quality {
        display: inline-block; padding: 0 6px; border-radius: 999px;
        font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .lab-quality--high   { background: rgba(64,200,120,0.20); color: #6bd482; }
      .lab-quality--medium { background: rgba(255,210,140,0.20); color: #ffd28c; }
      .lab-quality--low    { background: rgba(170,177,192,0.15); color: #aab1c0; }

      .lab-mv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .lab-mv-table th, .lab-mv-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .lab-mv-table th.num, .lab-mv-table td.num { text-align: right; }
      .lab-active-chip {
        display: inline-block; padding: 1px 8px; border-radius: 999px;
        background: rgba(192,132,252,0.18); color: #c084fc; font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.04em;
      }
    `}</style>
  );
}
