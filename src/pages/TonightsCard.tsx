/**
 * /card — "The Card"
 *
 * Tonight's parlay-builder page. The user's actual workflow:
 *   - 5-8 leg HR-prop parlays at $0.20-$1 stakes on the MGM app
 *   - Anchor on Cores, sprinkle a Boost, add a Spice for payout variance
 *   - Cross-reference with yesterday's HRs to catch back-to-back candidates
 *     (the founding insight that started this whole platform)
 *
 * The page is intentionally small and screenshot-friendly. The research
 * tools (Heat Score deep-dive, Pool Coverage, Miss Quality, Reverse
 * Engineering) live on /targets. This page is for the 6:45 PM moment.
 *
 * Sections, top to bottom:
 *   1. Per-leg rate tile (last 7d) — calibrates expectations
 *   2. Back-to-Back Watch — yesterday's HR hitters playing tonight, with
 *      an inline edge measurement so the user sees whether the pattern
 *      actually beats baseline (not just vibes).
 *   3. Cores / Boosts / Spice tier columns — the buildable parlay pool
 *   4. Red Flags strip — lineup pending / wind in / postponed
 *   5. Watch list — 5-10 that missed the tiers, with one-line "why not"
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  supabase, fetchPlayerIndex, fetchPitcherFormIndex, fetchDataLastUpdated,
  fetchOddsSnapshots,
  type GameRow, type HomeRunRow, type HrTargetSnapshotRow,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import ReasonChips from '../components/ReasonChips';
import {
  addDays,
  applyCanonicalTeams,
  classifyPickTier,
  computeBackToBackEdge,
  computeHrTargets,
  computeTopNEfficiency,
  pitcherHrLeaderboard,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type BackToBackEdgeResult,
  type HrTarget,
  type HrTargetGame,
  type LineupStatus,
  type PickTier,
  type PitcherFormLite,
  type PlayerTeamIndex,
  type RevAnalysisSnapshotRow,
  type SleeperOddsLite,
  type TopNEfficiencyResult,
} from '../lib/stats';

const todayISO = mlbToday;
const PAGE = 1000;

// =============================================================================
//  Data fetchers (mirrors HrTargets but limited to what The Card needs)
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

async function fetchSavedSnapshot(date: string): Promise<HrTargetSnapshotRow[]> {
  const { data, error } = await supabase
    .from('hr_target_snapshots').select('*')
    .eq('target_date', date).order('rank', { ascending: true });
  if (error) return [];
  return (data ?? []) as HrTargetSnapshotRow[];
}

/** 14d historical snapshot + HR fetch for the per-leg rate + back-to-back
 *  edge measurement. Same shape as HrTargets's 30d fetch but shorter window. */
async function fetchHistoricalSnaps(from: string, to: string): Promise<HrTargetSnapshotRow[]> {
  const all: HrTargetSnapshotRow[] = [];
  for (let page = 0; page < 20; page++) {
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
async function fetchHistoricalHrs(from: string, to: string): Promise<HomeRunRow[]> {
  const all: HomeRunRow[] = [];
  for (let page = 0; page < 20; page++) {
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
export default function TonightsCard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTarget = searchParams.get('date') ?? todayISO();
  const [targetDate, setTargetDateState] = useState<string>(initialTarget);
  const asOf = useMemo(() => addDays(targetDate, -1), [targetDate]);

  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [pitcherStartsForm, setPitcherStartsForm] = useState<Map<number, PitcherFormLite>>(new Map());
  const [oddsByPlayer, setOddsByPlayer] = useState<Map<number, SleeperOddsLite>>(new Map());
  const [savedSnapshot, setSavedSnapshot] = useState<HrTargetSnapshotRow[]>([]);
  const [dataLastUpdated, setDataLastUpdated] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Diagnostics — last-14d per-leg rate + back-to-back edge
  const [topNEff, setTopNEff] = useState<TopNEfficiencyResult | null>(null);
  const [b2bEdge, setB2bEdge] = useState<BackToBackEdgeResult | null>(null);

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

  // Main fetch: today's data
  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [hrs, gs, snap, lu, odds] = await Promise.all([
          fetchSeasonHrs(asOf),
          fetchGamesOn(targetDate),
          fetchSavedSnapshot(targetDate).catch(() => []),
          fetchDataLastUpdated().catch(() => null),
          fetchOddsSnapshots(targetDate).catch(() => []),
        ]);
        if (cancelled) return;
        setSeasonHrs(hrs);
        setGames(gs);
        setSavedSnapshot(snap);
        setDataLastUpdated(lu);
        // Latest odds per player_id
        const oddsMap = new Map<number, SleeperOddsLite>();
        const oddsSorted = odds.slice().sort((a, b) => a.snapshot_time < b.snapshot_time ? -1 : 1);
        for (const r of oddsSorted) {
          if (r.player_id == null) continue;
          oddsMap.set(r.player_id, { implied_prob: r.implied_prob, american_odds: r.american_odds });
        }
        setOddsByPlayer(oddsMap);
        // Probable pitcher form
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
                pitcher_id: id,
                pitcher_throws: f.pitcher_throws,
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

  // Historical fetch: powers per-leg rate + back-to-back edge
  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    (async () => {
      try {
        const anchor = addDays(targetDate, -1);
        const from30 = addDays(anchor, -29);
        const [snaps, hrs] = await Promise.all([
          fetchHistoricalSnaps(from30, anchor),
          fetchHistoricalHrs(from30, anchor),
        ]);
        if (cancelled) return;
        const hrByDate = new Map<string, Set<number>>();
        for (const r of hrs) {
          let s = hrByDate.get(r.game_date);
          if (!s) { s = new Set<number>(); hrByDate.set(r.game_date, s); }
          s.add(r.player_id);
        }
        const minimal: RevAnalysisSnapshotRow[] = snaps.map((r) => ({
          target_date: r.target_date, player_id: r.player_id,
          player_name: r.player_name, team: r.team,
          rank: r.rank, heat_score: r.heat_score, reason: r.reason,
        }));
        setTopNEff(computeTopNEfficiency(minimal, hrByDate, anchor, 14));
        setB2bEdge(computeBackToBackEdge(minimal, hrByDate, anchor, 30));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[card] historical fetch failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [targetDate, refreshKey]);

  // ---- Build the ranked list (same model as HR Targets) ----
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
    [canonHrs, targetGames, asOf, pitcherIndex, venueIndex, elitePowerIds],
  );
  /** All ranked players from all games, sorted by heat desc, 1-based rank attached. */
  const allRanked = useMemo(() => {
    const all: HrTarget[] = [];
    for (const b of boards) { all.push(...b.away_targets, ...b.home_targets); }
    return all
      .filter((t) => t.lineup_status === 'confirmed' || t.lineup_status === 'pending')
      .sort((a, b) => b.heat_score - a.heat_score);
  }, [boards]);
  const allRankedRaw = useMemo(() => {
    const all: HrTarget[] = [];
    for (const b of boards) all.push(...b.away_targets, ...b.home_targets);
    return all.sort((a, b) => b.heat_score - a.heat_score);
  }, [boards]);

  // ---- Back-to-Back Watch: yesterday's HRs ∩ today's allRanked ----
  const yesterdaysHrIds = useMemo(() => {
    const yesterday = asOf;
    const ids = new Set<number>();
    for (const r of seasonHrs) {
      if (r.game_date === yesterday) ids.add(r.player_id);
    }
    return ids;
  }, [seasonHrs, asOf]);
  const backToBackCandidates = useMemo(() => {
    return allRanked
      .filter((t) => yesterdaysHrIds.has(t.player_id))
      .slice(0, 10);
  }, [allRanked, yesterdaysHrIds]);

  // ---- Tier classification ----
  type RankedPick = { target: HrTarget; rank: number; tier: PickTier; odds: SleeperOddsLite | null };
  const ranked: RankedPick[] = useMemo(() => {
    return allRanked.slice(0, 80).map((t, i) => {
      const rank = i + 1;
      const odds = oddsByPlayer.get(t.player_id) ?? null;
      const goodChips = t.reason_chips.filter((c) => c.tone === 'good').length;
      const tier = classifyPickTier(rank, t.heat_score, odds?.american_odds, goodChips);
      return { target: t, rank, tier, odds };
    });
  }, [allRanked, oddsByPlayer]);

  const cores = useMemo(() => ranked.filter((r) => r.tier === 'core').slice(0, 8), [ranked]);
  const boosts = useMemo(() => ranked.filter((r) => r.tier === 'boost').slice(0, 10), [ranked]);
  // Spice: require ≥1 good chip so we don't surface noise
  const spice = useMemo(() => {
    return ranked
      .filter((r) => r.tier === 'spice' && r.target.reason_chips.some((c) => c.tone === 'good'))
      .slice(0, 6);
  }, [ranked]);

  // ---- Red flags ----
  const redFlags = useMemo(() => {
    const lineupPending: HrTarget[] = [];
    const windIn: HrTarget[] = [];
    const postponed: HrTarget[] = [];
    const onCard = new Set<number>([...cores, ...boosts, ...spice].map((r) => r.target.player_id));
    for (const r of ranked) {
      if (!onCard.has(r.target.player_id)) continue;
      const t = r.target;
      if (t.lineup_status === 'pending') lineupPending.push(t);
      const dir = (t.weather_wind_dir ?? '').toLowerCase();
      const mph = t.weather_wind_mph ?? 0;
      if (/in from/.test(dir) && mph >= 10) windIn.push(t);
      // Postponed wouldn't pass the confirmed/pending filter, but check raw:
    }
    for (const t of allRankedRaw) {
      if (!onCard.has(t.player_id)) continue;
      if (t.lineup_status === 'postponed') postponed.push(t);
    }
    return { lineupPending, windIn, postponed };
  }, [cores, boosts, spice, ranked, allRankedRaw]);

  // ---- Watch list: ranks 31-50 that didn't make a tier, with one-line "why not" ----
  const watchList = useMemo(() => {
    const onCard = new Set<number>([...cores, ...boosts, ...spice].map((r) => r.target.player_id));
    return ranked
      .filter((r) => !onCard.has(r.target.player_id))
      .slice(0, 8)
      .map((r) => ({
        ...r,
        reason: passReason(r),
      }));
  }, [ranked, cores, boosts, spice]);

  const today = todayISO();
  const tomorrow = addDays(today, 1);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>🎴 Tonight's Card</h1>
        <span className="subtle" style={{ fontSize: 13 }}>
          built for parlay legs — Cores anchor, Boosts mix, Spice for variance
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
          <Link to={`/targets?date=${targetDate}`} style={{ fontSize: 13 }}>Open in Research →</Link>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading {targetDate}…</div>}

      {/* Per-leg rate strip */}
      <PerLegRateStrip eff={topNEff} dataLastUpdated={dataLastUpdated} />

      {/* Back-to-Back Watch */}
      <BackToBackWatchCard
        candidates={backToBackCandidates}
        edge={b2bEdge}
        asOf={asOf}
      />

      {/* Cores / Boosts / Spice */}
      <div className="card-tiers">
        <TierColumn
          title="🎯 Cores"
          subtitle="Anchor picks. Model + book agree. Lower variance."
          accent="#4cd97a"
          picks={cores}
          asOf={asOf}
        />
        <TierColumn
          title="⚡ Boosts"
          subtitle="Strong signal at longer odds, or mid-rank with chips."
          accent="#ffb86c"
          picks={boosts}
          asOf={asOf}
        />
        <TierColumn
          title="🌶 Spice"
          subtitle="Longshots with real signal. Add 1 for parlay payout variance."
          accent="#c084fc"
          picks={spice}
          asOf={asOf}
          warnText="Spice hits ~10-15% of the time even when 'right'. One per ticket, max."
        />
      </div>

      {/* Red flags */}
      <RedFlagsStrip
        flags={redFlags}
        asOf={asOf}
      />

      {/* Watch list */}
      {watchList.length > 0 && (
        <WatchList items={watchList} asOf={asOf} />
      )}

      <p className="subtle" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
        This page is the parlay-builder view. Heat Score model details, Pool Coverage, Miss Quality,
        and reverse-engineering tools live on the <Link to={`/targets?date=${targetDate}`}>HR Targets</Link> page.
        Picks are research, not financial advice.
      </p>

      <CardStyles />
    </>
  );
}

// =============================================================================
//  Helpers + sub-components
// =============================================================================

function passReason({ target, rank, odds, tier }: { target: HrTarget; rank: number; odds: SleeperOddsLite | null; tier: PickTier }): string {
  const t = target;
  if (t.lineup_status === 'pending') return 'Lineup not posted yet';
  if (t.lineup_status === 'postponed') return 'Game postponed';
  if (odds && odds.american_odds < 200) return 'Book has them too short';
  if (t.reason_chips.some((c) => c.kind === 'cold')) return 'Model cold-penalty drag';
  if (t.reason_chips.some((c) => c.kind === 'low_conf')) return 'Low data confidence';
  if (rank > 30 && tier === 'spice' && t.reason_chips.filter((c) => c.tone === 'good').length < 2) return 'Single thin signal';
  if (t.heat_score < 40) return 'Heat below cutoff';
  return 'Just outside tier cutoffs';
}

function PerLegRateStrip({ eff, dataLastUpdated }: { eff: TopNEfficiencyResult | null; dataLastUpdated: string | null }) {
  const fmt = (x: number) => `${(x * 100).toFixed(1)}%`;
  return (
    <div className="card-strip">
      <div className="card-strip-tile card-strip-tile--core">
        <div className="card-strip-label">Top-10 hit rate (14d)</div>
        <div className="card-strip-value">{eff ? fmt(eff.top10_efficiency) : '…'}</div>
        <div className="card-strip-sub">{eff ? `${eff.top10_hits}/${eff.top10_slots} legs` : '—'}</div>
      </div>
      <div className="card-strip-tile card-strip-tile--boost">
        <div className="card-strip-label">Top-25 coverage (14d)</div>
        <div className="card-strip-value">{eff ? fmt(eff.top25_coverage) : '…'}</div>
        <div className="card-strip-sub">{eff ? `${eff.top25_hits}/${eff.total_hr_hitters} HRs caught` : '—'}</div>
      </div>
      <div className="card-strip-tile card-strip-tile--spice">
        <div className="card-strip-label">Data last updated</div>
        <div className="card-strip-value" style={{ fontSize: 13, fontWeight: 600 }}>
          {dataLastUpdated ? new Date(dataLastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
        </div>
        <div className="card-strip-sub">most recent HR ingest</div>
      </div>
    </div>
  );
}

function BackToBackWatchCard({
  candidates, edge, asOf,
}: {
  candidates: HrTarget[];
  edge: BackToBackEdgeResult | null;
  asOf: string;
}) {
  const liftBadge = edge && edge.n_pairs >= 30 ? (
    <span className={`card-b2b-badge ${edge.lift >= 1.5 ? 'card-b2b-badge--strong' : edge.lift >= 1.15 ? 'card-b2b-badge--modest' : 'card-b2b-badge--none'}`}>
      {edge.lift.toFixed(2)}× baseline · n={edge.n_pairs}
    </span>
  ) : null;
  return (
    <div className="card-panel">
      <div className="card-panel-head">
        <h3 style={{ margin: 0, fontSize: 15 }}>🔁 Back-to-Back Watch</h3>
        {liftBadge}
      </div>
      <p className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
        Yesterday's HR hitters playing tonight, ranked by today's Heat Score.
      </p>
      {edge && (
        <p className="subtle" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>
          <strong>Edge check:</strong> {edge.diagnosis}
        </p>
      )}
      {candidates.length === 0 ? (
        <p className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
          No yesterday-HR hitters in tonight's confirmed/pending lineups yet. Check back closer to game time.
        </p>
      ) : (
        <div className="card-b2b-grid" style={{ marginTop: 8 }}>
          {candidates.map((t) => (
            <div key={t.player_id} className="card-b2b-row">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`} style={{ fontSize: 13, fontWeight: 700 }}>
                  {t.player_name}
                </Link>
                <span className="subtle" style={{ fontSize: 11 }}>{t.team} vs {t.opponent}</span>
                {t.hr_streak >= 2 && (
                  <span className="card-streak-chip">🔥 {t.hr_streak}d streak</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                <span className="subtle" style={{ fontSize: 11 }}>Heat <strong>{t.heat_score.toFixed(0)}</strong></span>
                <span className="subtle" style={{ fontSize: 11 }}>·</span>
                <span className="subtle" style={{ fontSize: 11 }}>{t.season_hr} season HR</span>
                <span style={{ flex: 1 }} />
                <ReasonChips chips={t.reason_chips.slice(0, 3)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TierColumn({
  title, subtitle, accent, picks, asOf, warnText,
}: {
  title: string; subtitle: string; accent: string;
  picks: { target: HrTarget; rank: number; tier: PickTier; odds: SleeperOddsLite | null }[];
  asOf: string;
  warnText?: string;
}) {
  return (
    <div className="card-tier" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="card-tier-head">
        <h3 style={{ margin: 0, fontSize: 14, color: accent }}>{title}</h3>
        <span className="subtle" style={{ fontSize: 11 }}>{picks.length}</span>
      </div>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2, marginBottom: 8, lineHeight: 1.35 }}>
        {subtitle}
      </p>
      {warnText && (
        <p style={{ fontSize: 11, color: '#ffb86c', marginTop: -4, marginBottom: 8, lineHeight: 1.35 }}>
          ⚠ {warnText}
        </p>
      )}
      {picks.length === 0 ? (
        <p className="subtle" style={{ fontSize: 11 }}>— none in this tier —</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {picks.map((p) => <PickCard key={p.target.player_id} pick={p} asOf={asOf} />)}
        </div>
      )}
    </div>
  );
}

function PickCard({ pick, asOf }: { pick: { target: HrTarget; rank: number; tier: PickTier; odds: SleeperOddsLite | null }; asOf: string }) {
  const t = pick.target;
  const odds = pick.odds;
  return (
    <div className="card-pick">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`} style={{ fontSize: 13, fontWeight: 700 }}>
          {t.player_name}
        </Link>
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          #{pick.rank} · {t.heat_score.toFixed(0)}
        </span>
      </div>
      <div className="subtle" style={{ fontSize: 11, marginTop: 1 }}>
        {t.team} vs {t.opponent}{odds && (
          <> · <strong style={{ color: '#cfe' }}>{odds.american_odds > 0 ? '+' : ''}{odds.american_odds}</strong> ({(odds.implied_prob * 100).toFixed(0)}%)</>
        )}
        {t.lineup_status === 'pending' && <> · <span style={{ color: '#ffd28c' }}>pending</span></>}
      </div>
      <div style={{ marginTop: 5 }}>
        <ReasonChips chips={t.reason_chips.slice(0, 3)} />
      </div>
    </div>
  );
}

function RedFlagsStrip({
  flags, asOf,
}: {
  flags: { lineupPending: HrTarget[]; windIn: HrTarget[]; postponed: HrTarget[] };
  asOf: string;
}) {
  const total = flags.lineupPending.length + flags.windIn.length + flags.postponed.length;
  if (total === 0) return null;
  return (
    <div className="card-flags">
      <h4 style={{ margin: 0, fontSize: 13 }}>🚨 Red flags on your card</h4>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        Re-check these before you submit the parlay.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, marginTop: 6 }}>
        {flags.lineupPending.length > 0 && (
          <FlagBucket label="Lineup pending" tone="warn" players={flags.lineupPending} asOf={asOf} />
        )}
        {flags.windIn.length > 0 && (
          <FlagBucket label="Wind blowing IN" tone="warn" players={flags.windIn} asOf={asOf} />
        )}
        {flags.postponed.length > 0 && (
          <FlagBucket label="Postponed" tone="bad" players={flags.postponed} asOf={asOf} />
        )}
      </div>
    </div>
  );
}

function FlagBucket({ label, tone, players, asOf }: { label: string; tone: 'warn' | 'bad'; players: HrTarget[]; asOf: string }) {
  const color = tone === 'bad' ? '#e07a7a' : '#ffd28c';
  return (
    <div className="card-flag-bucket" style={{ borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.05 }}>
        {label} ({players.length})
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', fontSize: 12 }}>
        {players.slice(0, 5).map((t) => (
          <li key={t.player_id} style={{ padding: '2px 0' }}>
            <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`} style={{ fontSize: 12 }}>
              {t.player_name}
            </Link>
            <span className="subtle" style={{ fontSize: 10, marginLeft: 4 }}>{t.team}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WatchList({ items, asOf }: {
  items: { target: HrTarget; rank: number; tier: PickTier; odds: SleeperOddsLite | null; reason: string }[];
  asOf: string;
}) {
  return (
    <div className="card-panel">
      <h4 style={{ margin: 0, fontSize: 13 }}>👀 Watch / Passed on</h4>
      <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
        Solid signal but missed a tier cutoff. Receipts for what the model deprioritized tonight.
      </p>
      <div className="card-watch-list" style={{ marginTop: 6 }}>
        {items.map((it) => {
          const t = it.target;
          return (
            <div key={t.player_id} className="card-watch-row">
              <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`} style={{ fontSize: 12, fontWeight: 600 }}>
                {t.player_name}
              </Link>
              <span className="subtle" style={{ fontSize: 10, marginLeft: 4 }}>
                {t.team} vs {t.opponent} · #{it.rank}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#aab1c0' }}>
                {it.reason}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CardStyles() {
  return (
    <style>{`
      .card-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      .card-strip-tile {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-left: 3px solid #aab1c0;
        border-radius: 8px;
        padding: 8px 12px;
      }
      .card-strip-tile--core  { border-left-color: #4cd97a; }
      .card-strip-tile--boost { border-left-color: #ffb86c; }
      .card-strip-tile--spice { border-left-color: #c084fc; }
      .card-strip-label { font-size: 10.5px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.06em; }
      .card-strip-value { font-size: 20px; font-weight: 700; color: #cfe; margin-top: 2px; }
      .card-strip-sub   { font-size: 10.5px; opacity: 0.65; margin-top: 1px; }

      .card-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 12px;
      }
      .card-panel-head {
        display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap;
      }
      .card-b2b-badge {
        display: inline-block; padding: 2px 9px; border-radius: 999px;
        font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
        background: #2a2d36; color: #aab1c0;
      }
      .card-b2b-badge--strong { background: rgba(64,200,120,0.18); color: #4cd97a; }
      .card-b2b-badge--modest { background: rgba(255,184,108,0.18); color: #ffd28c; }
      .card-b2b-badge--none   { background: rgba(150,150,170,0.18); color: #aab1c0; }
      .card-b2b-grid { display: grid; gap: 6px; }
      .card-b2b-row {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-left: 3px solid #ffd28c;
        border-radius: 6px;
        padding: 6px 9px;
      }
      .card-streak-chip {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        font-size: 10px; font-weight: 700;
        background: rgba(255,122,24,0.15); color: #ff7a18;
        border: 1px solid rgba(255,122,24,0.4);
      }

      .card-tiers {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 10px;
        margin-bottom: 12px;
      }
      .card-tier {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 10px 12px;
      }
      .card-tier-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
      .card-pick {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 7px;
        padding: 7px 9px;
      }

      .card-flags {
        background: var(--panel, #11141c);
        border: 1px solid rgba(255,210,140,0.35);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
      }
      .card-flag-bucket {
        background: var(--panel-2, #14171f);
        padding: 6px 10px;
        border-radius: 6px;
      }

      .card-watch-list { display: grid; gap: 4px; }
      .card-watch-row {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 8px;
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 6px;
      }
    `}</style>
  );
}
