/**
 * /targets — "HR Targets"
 *
 * RESEARCH RANKING — NOT a guaranteed pick.
 *
 * For a chosen date (Today / Tomorrow / Custom), pulls scheduled games
 * from the `games` table and ranks each team's hitters by an "HR Heat
 * Score" computed in stats.ts (computeHrTargets). The score is a
 * transparent sum of:
 *
 *   recent_form (L3/L5/L7d), season_power, handedness_edge,
 *   pitcher_weakness (L14d HR allowed), park_boost (L14d HRs at venue).
 *
 * Each component degrades gracefully when its inputs are missing — a
 * game with no probable pitcher still ranks hitters by recent form +
 * season power + park boost.
 */
import React, { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, fetchPlayerIndex, fetchPitcherFormIndex, type GameRow, type HomeRunRow, type HrTargetSnapshotRow } from '../lib/supabase';
import {
  addDays,
  applyCanonicalTeams,
  computeHrTargets,
  pitcherHrLeaderboard,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type HrTarget,
  type HrTargetGame,
  type HrTargetsBoard,
  type PitcherFormLite,
  type PlayerTeamIndex,
} from '../lib/stats';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const PAGE = 1000;

async function fetchSeasonHrs(asOf: string): Promise<HomeRunRow[]> {
  const start = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
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
    if (rows.length < PAGE) break;
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

/** Persisted Top-N for the date, if a snapshot exists. Drives the
 *  saved-snapshot default view so Backtest and HR Targets agree. */
async function fetchSavedSnapshot(date: string): Promise<HrTargetSnapshotRow[]> {
  const { data, error } = await supabase
    .from('hr_target_snapshots')
    .select('*')
    .eq('target_date', date)
    .order('rank', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as HrTargetSnapshotRow[];
}

export default function HrTargets() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTarget = searchParams.get('date') ?? todayISO();

  // The date for which we want scheduled games + targets.
  const [targetDate, setTargetDateState] = useState<string>(initialTarget);

  // The "as of" date for player stats — usually one day BEFORE the target so
  // we don't peek at HRs hit in the same game we're trying to predict. For
  // past target dates (researching historical performance), use target - 1
  // too. For today/tomorrow the stats use yesterday's HRs as the latest input.
  const [asOf, setAsOfState] = useState<string>(addDays(initialTarget, -1));

  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  // Real pitcher form from pitcher_starts (populated by enrich:pitcher-starts +
  // forward ingest in processDate). Falls back to home_runs approximation when empty.
  const [pitcherStartsForm, setPitcherStartsForm] = useState<Map<number, PitcherFormLite>>(new Map());
  // Saved snapshot for the target date (if one exists). Drives the default
  // view so HR Targets and Backtest show the same Top 10.
  const [savedSnapshot, setSavedSnapshot] = useState<HrTargetSnapshotRow[]>([]);
  // 'saved' = use saved snapshot rows (default when one exists).
  // 'live'  = recompute live (default when no snapshot).
  // 'compare' = paired Saved vs Live ranks side-by-side.
  type ViewMode = 'saved' | 'live' | 'compare';
  const initialView = (searchParams.get('view') as ViewMode | null) ?? null;
  const [viewMode, setViewModeState] = useState<ViewMode>(initialView ?? 'live');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function setViewMode(m: ViewMode) {
    setViewModeState(m);
    const next = new URLSearchParams(searchParams);
    next.set('view', m);
    setSearchParams(next, { replace: true });
  }

  function setTargetDate(d: string) {
    setTargetDateState(d);
    setAsOfState(addDays(d, -1));
    const next = new URLSearchParams(searchParams);
    next.set('date', d);
    setSearchParams(next, { replace: true });
  }

  useEffect(() => {
    let cancelled = false;
    fetchPlayerIndex()
      .then((m) => { if (!cancelled) setPlayerIndex(m); })
      .catch(() => {/* soft-fail; per-HR teams still display */});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!targetDate) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [hrs, gs, snap] = await Promise.all([
          fetchSeasonHrs(asOf),
          fetchGamesOn(targetDate),
          fetchSavedSnapshot(targetDate).catch(() => [] as HrTargetSnapshotRow[]),
        ]);
        if (cancelled) return;
        setSeasonHrs(hrs);
        setGames(gs);
        setSavedSnapshot(snap);

        // Default view: 'saved' when a snapshot exists, 'live' otherwise.
        // Respects the URL override (?view=...) so refreshes preserve user intent.
        if (initialView == null) {
          setViewModeState(snap.length > 0 ? 'saved' : 'live');
        }

        // Resolve real pitcher form from pitcher_starts. Probable pitcher ids
        // come from the games we just fetched.
        const probableIds = new Set<number>();
        for (const g of gs) {
          if (g.home_probable_pitcher_id != null) probableIds.add(g.home_probable_pitcher_id);
          if (g.away_probable_pitcher_id != null) probableIds.add(g.away_probable_pitcher_id);
        }
        if (probableIds.size > 0) {
          try {
            const form = await fetchPitcherFormIndex(Array.from(probableIds), asOf);
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
              });
            }
            setPitcherStartsForm(m);
          } catch (formErr) {
            // Soft fail — frontend falls back to home_runs approximation.
            // eslint-disable-next-line no-console
            console.warn('[HrTargets] fetchPitcherFormIndex failed:', formErr);
            setPitcherStartsForm(new Map());
          }
        } else {
          setPitcherStartsForm(new Map());
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [asOf, targetDate]);

  const canonHrs = useMemo(() => applyCanonicalTeams(seasonHrs, playerIndex), [seasonHrs, playerIndex]);

  // Derive elite-power player IDs by name-matching the canonical players
  // against the curated ELITE_POWER_NAMES list. Power Floor in the heat
  // score uses this set so slow-start sluggers (Judge in April) aren't
  // buried just because their current-season count is low.
  const elitePowerIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, p] of playerIndex) {
      const name = (p.full_name ?? '').trim().toLowerCase();
      if (name && ELITE_POWER_NAMES.has(name)) ids.add(id);
    }
    return ids;
  }, [playerIndex]);

  // Build pitcher + venue indexes once per fetch.
  // Pitcher index: prefer real pitcher_starts data. If a probable pitcher has
  // no rows yet, fall back to the home_runs-derived approximation so the page
  // still ranks gracefully.
  const pitcherIndex = useMemo(() => {
    const board = pitcherHrLeaderboard(canonHrs, asOf);
    const approx = new Map<number, PitcherFormLite>(
      board.map((p) => [p.pitcher_id, {
        pitcher_id: p.pitcher_id,
        pitcher_throws: p.pitcher_throws,
        allowed_last_14_days: p.allowed_last_14_days,
        allowed_last_3_starts: p.allowed_last_3_starts,
        starts_known: 0, // signals "approximated from home_runs"
      }] as const),
    );
    // Real form trumps approximation
    for (const [id, real] of pitcherStartsForm) {
      approx.set(id, real);
    }
    return approx;
  }, [canonHrs, asOf, pitcherStartsForm]);

  const venueIndex = useMemo(() => {
    const board = venueLeaderboard(canonHrs, asOf);
    const total = board.length;
    return new Map(board.map((v, i) => [v.venue_name, {
      venue_name: v.venue_name,
      l14d: v.l14d,
      rank_l14d: i + 1,
      total_ranked: total,
    }] as const));
  }, [canonHrs, asOf]);

  // Map GameRow → HrTargetGame
  const targetGames: HrTargetGame[] = useMemo(
    () => games.map((g) => ({
      game_pk: g.game_pk,
      game_date: g.game_date,
      home_team: g.home_team,
      away_team: g.away_team,
      venue_name: g.venue_name,
      home_probable_pitcher_id: g.home_probable_pitcher_id,
      home_probable_pitcher_name: g.home_probable_pitcher_name,
      home_probable_pitcher_hand: g.home_probable_pitcher_hand,
      away_probable_pitcher_id: g.away_probable_pitcher_id,
      away_probable_pitcher_name: g.away_probable_pitcher_name,
      away_probable_pitcher_hand: g.away_probable_pitcher_hand,
    })),
    [games],
  );

  const boards: HrTargetsBoard[] = useMemo(
    () => computeHrTargets(canonHrs, asOf, targetGames, { pitcherIndex, venueIndex, elitePowerIds }),
    [canonHrs, asOf, targetGames, pitcherIndex, venueIndex, elitePowerIds],
  );

  // Flatten across all games + sort by Heat Score desc.
  const allRanked: HrTarget[] = useMemo(() => {
    const all: HrTarget[] = [];
    for (const b of boards) {
      all.push(...b.away_targets, ...b.home_targets);
    }
    all.sort(
      (a, b) =>
        b.heat_score - a.heat_score ||
        b.season_hr - a.season_hr ||
        a.player_name.localeCompare(b.player_name),
    );
    return all;
  }, [boards]);
  const top10 = useMemo(() => allRanked.slice(0, 10), [allRanked]);

  // Model-disagreement warning: surface elite-power hitters who SHOULD be
  // near the top of betting interest but our model ranked low. Threshold:
  // any elite player whose final rank is worse than 30 across all boards.
  // This is the safety net for the "Aaron Judge buried at #45" scenario.
  const MODEL_DISAGREEMENT_RANK = 30;
  const modelDisagreements = useMemo(() => {
    const out: { target: HrTarget; rank: number }[] = [];
    for (let i = 0; i < allRanked.length; i++) {
      const t = allRanked[i];
      if (t.is_elite_power && i >= MODEL_DISAGREEMENT_RANK) {
        out.push({ target: t, rank: i + 1 });
      }
    }
    return out;
  }, [allRanked]);

  const today = todayISO();
  const tomorrow = addDays(today, 1);

  return (
    <>
      <div className="kpi-strip" style={{ marginBottom: 12 }}>
        <Kpi label="Target date" value={targetDate} />
        <Kpi label="Stats anchor" value={asOf} />
        <Kpi label="Games" value={games.length} />
        <Kpi label="Players ranked" value={boards.reduce((s, b) => s + b.away_targets.length + b.home_targets.length, 0)} />
      </div>

      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-presets" style={{ alignSelf: 'flex-start' }}>
          <button type="button" onClick={() => setTargetDate(today)} aria-pressed={targetDate === today}>Today</button>
          <button type="button" onClick={() => setTargetDate(tomorrow)} aria-pressed={targetDate === tomorrow}>Tomorrow</button>
        </div>
        <label>
          <span>Custom date</span>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
        <Link to="/" style={{ alignSelf: 'end', marginLeft: 'auto', fontSize: 13 }}>← Dashboard</Link>
      </div>

      <div
        className="panel"
        style={{
          marginBottom: 16,
          background: 'var(--panel-2)',
          borderColor: 'var(--accent)',
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--accent-2)' }}>HR target ranking — research only.</strong>{' '}
          The Heat Score is a transparent sum of recent form (L3/L5/L7d), season HR
          power, handedness edge vs the probable pitcher, the pitcher's recent
          HR-allowed rate, and the venue's recent HR friendliness. It is{' '}
          <strong>not a prediction guarantee</strong> and not a betting recommendation.
          Components degrade gracefully when probable pitcher or venue data is missing.
        </div>
        <div className="subtle" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>
          <strong style={{ color: 'var(--text)' }}>Live rankings may change</strong> as
          probable pitchers, venues, and yesterday's HR data update.
          {' '}<a href="/backtest" style={{ color: 'var(--accent-2)' }}>Backtest</a>{' '}
          uses saved pre-game snapshots for honest historical comparison.
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading targets for {targetDate}…</div>}

      {!loading && games.length === 0 && !error && (
        <div className="panel">
          <h2>No scheduled games for {targetDate}</h2>
          <p className="subtle">
            Run <code>npm run enrich:schedule -- --start {targetDate} --end {targetDate}</code> to
            pull MLB's schedule for that date.
          </p>
        </div>
      )}

      {modelDisagreements.length > 0 && (
        <div
          className="panel"
          style={{ marginBottom: 16, borderColor: 'var(--accent)', background: 'var(--panel-2)' }}
        >
          <h2 style={{ marginTop: 0 }}>⚠ Model disagreement: elite power hitter(s) ranked low</h2>
          <p className="subtle" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 6 }}>
            These hitters are on the curated elite-power list but the model
            ranked them below #{MODEL_DISAGREEMENT_RANK}. Usually means recent
            data is thin (early season, just returned from IL) — check the
            sportsbook line before discarding.
          </p>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Game</th>
                  <th className="num">Season</th>
                  <th className="num">Heat</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {modelDisagreements.slice(0, 5).map(({ target: t, rank }) => (
                  <tr key={`${t.player_id}-${rank}`}>
                    <td className="num">{rank}</td>
                    <td>
                      <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`}>
                        {t.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{t.team}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {t.opponent}</td>
                    <td className="num">{t.season_hr}</td>
                    <td className="num">{t.heat_score.toFixed(1)}</td>
                    <td className="subtle" style={{ fontSize: 12 }}>
                      {t.reasons.length > 0 ? t.reasons.join(' · ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Saved / live / compare banner — the key consistency signal */}
      <ViewModeBanner
        mode={viewMode}
        onSetMode={setViewMode}
        targetDate={targetDate}
        savedSnapshot={savedSnapshot}
      />

      {/* Top 10 panel — content depends on viewMode */}
      {(viewMode === 'saved' && savedSnapshot.length > 0) && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              Top 10 HR targets — {targetDate}
              <SnapshotTypeBadge type={savedSnapshot[0]?.snapshot_type} />
            </h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Saved Snapshot — same data Backtest uses
            </span>
          </div>
          <SavedTop10Table snapshot={savedSnapshot.slice(0, 10)} asOf={asOf} />
        </div>
      )}

      {(viewMode === 'live' && top10.length > 0) && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>Top 10 HR targets — {targetDate}</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Live Preview · click any row for matchup detail · may differ from Backtest
            </span>
          </div>
          <Top10Table targets={top10} asOf={asOf} />
        </div>
      )}

      {(viewMode === 'compare' && (savedSnapshot.length > 0 || top10.length > 0)) && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>Saved vs Live — {targetDate}</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              How much has the model shifted since the snapshot was taken?
            </span>
          </div>
          <CompareTable savedSnapshot={savedSnapshot} liveTop={allRanked.slice(0, 20)} asOf={asOf} />
        </div>
      )}

      <h3 className="section">All games — sorted within each card by Heat Score ↓</h3>
      <div style={{ display: 'grid', gap: 12 }}>
        {boards.map((b) => (
          <GameTargetsCard key={b.game_pk} board={b} asOf={asOf} />
        ))}
      </div>
    </>
  );
}

function Top10Table({ targets, asOf }: { targets: HrTarget[]; asOf: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (k: string) => setExpanded((cur) => (cur === k ? null : k));

  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>#</th>
            <th>Player</th>
            <th>Team</th>
            <th>Game</th>
            <th>Pitcher</th>
            <th className="num">L5</th>
            <th className="num">L7d</th>
            <th className="num">Season</th>
            <th className="num">Heat</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((t, i) => {
            const key = `${t.player_id}-${t.team}-${t.opponent}`;
            const isOpen = expanded === key;
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => toggle(key)}
                  style={{ cursor: 'pointer' }}
                  aria-expanded={isOpen}
                >
                  <td
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                    style={{ width: 24, color: 'var(--muted)' }}
                  >
                    {isOpen ? '▾' : '▸'}
                  </td>
                  <td className="num">{i + 1}</td>
                  <td>
                    <Link
                      className="player-link"
                      to={`/player/${t.player_id}?asOf=${asOf}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t.player_name}
                    </Link>
                    {t.is_elite_power && (
                      <span
                        title="Elite power profile — power floor applied"
                        style={{ marginLeft: 6, color: 'var(--accent-2)', fontSize: 12 }}
                      >
                        ★
                      </span>
                    )}
                  </td>
                  <td><span className="pill">{t.team}</span></td>
                  <td className="subtle" style={{ fontSize: 12 }}>vs {t.opponent}</td>
                  <td className="subtle" style={{ fontSize: 12 }}>
                    {t.pitcher_name}{t.pitcher_hand && <> ({t.pitcher_hand})</>}
                  </td>
                  <td className="num">{t.hrs_l5}</td>
                  <td className="num">{t.hrs_l7d}</td>
                  <td className="num">{t.season_hr}</td>
                  <td className="num"><strong>{t.heat_score.toFixed(1)}</strong></td>
                  <td className="subtle" style={{ fontSize: 12 }}>
                    {t.reasons.length > 0 ? t.reasons.join(' · ') : '—'}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={11} style={{ background: 'var(--panel-2)', padding: 12 }}>
                      <MatchupDetail t={t} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MatchupDetail({ t }: { t: HrTarget }) {
  const c = t.subscores.contributions;
  // Per-component bars use the configured weights so they stay accurate if
  // HEAT_SCORE_WEIGHTS changes.
  const bars: { label: string; value: number; max: number }[] = [
    { label: 'Season',  value: c.season,  max: 40 },
    { label: 'L3',      value: c.l3,      max: 14 },
    { label: 'L5',      value: c.l5,      max: 8  },
    { label: 'L7d',     value: c.l7d,     max: 3  },
    { label: 'Pitcher', value: c.pitcher, max: 15 },
    { label: 'Park',    value: c.park,    max: 10 },
    { label: 'Hand',    value: c.hand,    max: 10 },
  ];
  const b = t.breakdown;

  return (
    <>
      {/* Grouped breakdown — power / form / pitcher / hand / venue / final */}
      <div
        style={{
          display: 'grid',
          gap: 8,
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          marginBottom: 8,
          padding: 10,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <ScoreCell
          label="Season power (base)"
          value={b.season_power_score}
          max={40}
          accent
          subtle={t.is_elite_power ? '★ elite (power floor)' : undefined}
        />
        <ScoreCell
          label="Recent form"
          value={b.recent_form_score}
          max={25}
          subtle={b.stability_factor < 1 ? `× stability ${b.stability_factor}` : undefined}
        />
        <ScoreCell label="Pitcher" value={b.pitcher_score} max={15} />
        <ScoreCell label="Handedness" value={b.handedness_score} max={10} />
        <ScoreCell label="Venue" value={b.venue_score} max={10} />
        <ScoreCell label="Final heat" value={b.final_heat_score} max={100} highlight />
      </div>

      {/* Raw → adjusted explanation */}
      <div
        style={{
          marginBottom: 12,
          padding: '8px 10px',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--muted)',
        }}
      >
        <div>
          <strong style={{ color: 'var(--text)' }}>Raw score:</strong> {b.raw_score.toFixed(1)}
          {'  →  '}
          <strong style={{ color: 'var(--text)' }}>Final:</strong> {b.final_heat_score.toFixed(1)}
        </div>
        {b.adjustments.length > 0 ? (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {b.adjustments.map((adj, i) => (
              <li key={i}>
                {adj.label}{' '}
                <span style={{ color: adj.delta >= 0 ? 'var(--good)' : '#ff8d8d' }}>
                  ({adj.delta >= 0 ? '+' : ''}{adj.delta.toFixed(1)})
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ marginTop: 2 }}>No adjustments applied.</div>
        )}
      </div>

    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      <div>
        <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Probable pitcher</div>
        <div style={{ fontSize: 13 }}>
          <strong>{t.pitcher_name}</strong>
          {t.pitcher_hand && <span className="pill" style={{ marginLeft: 6 }}>{t.pitcher_hand}HP</span>}
        </div>
        <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
          {t.pitcher_starts_known >= 3 ? (
            <>
              {t.pitcher_l3_starts_allowed} HR L3 starts ·{' '}
              {t.pitcher_l5_starts_allowed} HR L5 starts ·{' '}
              {t.pitcher_l14d_allowed} HR L14d ·{' '}
              {t.pitcher_season_allowed} HR season
              <span style={{ marginLeft: 6, opacity: 0.6 }}>({t.pitcher_starts_known} starts on file)</span>
            </>
          ) : (
            <>
              {t.pitcher_l3_starts_allowed} HR last 3 starts* · {t.pitcher_l14d_allowed} HR L14d
              <div style={{ fontSize: 11, marginTop: 2 }}>
                * approximated from HR rows — run <code>npm run enrich:pitcher-starts</code> for accurate form.
              </div>
            </>
          )}
        </div>
      </div>

      <div>
        <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Venue</div>
        <div style={{ fontSize: 13 }}>
          <strong>{t.venue_name ?? 'TBD'}</strong>
        </div>
        <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
          {t.venue_l14d_rank != null
            ? `Rank ${t.venue_l14d_rank} of ${t.venue_total} · ${t.venue_l14d_hrs} HR L14d`
            : `${t.venue_l14d_hrs} HR L14d`}
        </div>
      </div>

      <div>
        <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Batter splits</div>
        <div style={{ fontSize: 13 }}>
          {t.batter_side ? <><strong>{t.batter_side}HB</strong> · </> : null}
          {t.vs_lhp_season} HR vs LHP · {t.vs_rhp_season} HR vs RHP
        </div>
        <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
          Last {t.hrs_l3 || 0} of {t.hrs_l5 || 0} HRs in L3/L5 games
          {t.hr_streak >= 2 ? ` · ${t.hr_streak}-game HR streak` : ''}
        </div>
      </div>

      <div>
        <div className="subtle" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
          Heat breakdown ({t.heat_score.toFixed(1)} / 100)
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          {bars.map((b) => (
            <div key={b.label} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 44px', gap: 6, alignItems: 'center' }}>
              <span className="subtle" style={{ fontSize: 11 }}>{b.label}</span>
              <div
                style={{
                  height: 6,
                  background: 'var(--border)',
                  borderRadius: 999,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${(b.value / b.max) * 100}%`,
                    height: '100%',
                    background: 'var(--accent)',
                  }}
                />
              </div>
              <span className="num" style={{ fontSize: 12 }}>{b.value.toFixed(1)}/{b.max}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
    </>
  );
}

function ScoreCell({
  label,
  value,
  max,
  highlight,
  accent,
  subtle,
}: {
  label: string;
  value: number;
  max: number;
  highlight?: boolean;
  accent?: boolean;
  subtle?: string;
}) {
  return (
    <div
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        background: highlight ? 'var(--accent)' : 'transparent',
        color: highlight ? '#1a1206' : undefined,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          color: highlight ? '#1a1206' : 'var(--muted)',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: highlight ? '#1a1206' : (accent ? 'var(--accent-2)' : 'var(--text)') }}>
        {value.toFixed(1)}
        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.6, marginLeft: 2 }}>/{max}</span>
      </div>
      {subtle && (
        <div style={{ fontSize: 10, color: highlight ? '#1a1206' : 'var(--muted)', marginTop: 2 }}>
          {subtle}
        </div>
      )}
    </div>
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

// =================== Saved-snapshot consistency UI ===================

function SnapshotTypeBadge({ type }: { type: 'live' | 'simulated' | undefined }) {
  if (!type) return null;
  const isLive = type === 'live';
  return (
    <span
      title={
        isLive
          ? 'Honest pre-game snapshot — taken before first pitch.'
          : 'Simulated historical backfill — approximates what the model would have said using data ≤ target_date - 1.'
      }
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        background: isLive ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 122, 24, 0.15)',
        color: isLive ? 'var(--good)' : 'var(--accent)',
        border: `1px solid ${isLive ? 'var(--good)' : 'var(--accent)'}`,
      }}
    >
      {isLive ? '● Live pre-game' : '○ Simulated historical'}
    </span>
  );
}

function ViewModeBanner({
  mode,
  onSetMode,
  targetDate,
  savedSnapshot,
}: {
  mode: 'saved' | 'live' | 'compare';
  onSetMode: (m: 'saved' | 'live' | 'compare') => void;
  targetDate: string;
  savedSnapshot: HrTargetSnapshotRow[];
}) {
  const hasSnapshot = savedSnapshot.length > 0;
  const snapshotTaken = hasSnapshot && savedSnapshot[0].snapshot_date
    ? new Date(savedSnapshot[0].snapshot_date).toLocaleString()
    : null;
  const snapshotType = hasSnapshot ? savedSnapshot[0].snapshot_type : undefined;

  // Status line
  let statusLabel = '';
  let statusColor: 'good' | 'accent' | 'muted' = 'muted';
  if (mode === 'saved' && hasSnapshot) {
    statusLabel = `Saved Snapshot — snapshot generated at ${snapshotTaken}`;
    statusColor = 'good';
  } else if (mode === 'live') {
    statusLabel = hasSnapshot
      ? 'Live Preview — does not match Backtest (use Saved Snapshot for consistency)'
      : 'Live Preview — not saved';
    statusColor = hasSnapshot ? 'accent' : 'muted';
  } else if (mode === 'compare') {
    statusLabel = `Comparing Saved Snapshot vs Live Preview — snapshot generated at ${snapshotTaken ?? 'n/a'}`;
    statusColor = 'accent';
  }
  const statusVar = statusColor === 'good' ? 'var(--good)' : statusColor === 'accent' ? 'var(--accent-2)' : 'var(--muted)';

  return (
    <div
      className="panel"
      style={{ marginBottom: 12, padding: 10, borderColor: hasSnapshot ? 'var(--accent)' : 'var(--border)' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <strong style={{ color: statusVar }}>{statusLabel}</strong>
        {hasSnapshot && <SnapshotTypeBadge type={snapshotType} />}

        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <ModeButton active={mode === 'saved'}  disabled={!hasSnapshot} onClick={() => onSetMode('saved')}>
            Saved Snapshot
          </ModeButton>
          <ModeButton active={mode === 'live'}    onClick={() => onSetMode('live')}>
            Live Preview
          </ModeButton>
          <ModeButton active={mode === 'compare'} disabled={!hasSnapshot} onClick={() => onSetMode('compare')}>
            Compare
          </ModeButton>
        </div>
      </div>

      {!hasSnapshot && mode === 'live' && (
        <div className="subtle" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
          No saved snapshot for <strong>{targetDate}</strong>. Backtest can only
          show this date once a snapshot exists. To save the current ranking:
          <pre style={{ background: 'var(--panel-2)', padding: '6px 8px', borderRadius: 6, fontSize: 12, marginTop: 6, overflowX: 'auto' }}>
            npm run snapshot:targets -- {targetDate}
          </pre>
        </div>
      )}
    </div>
  );
}

function ModeButton({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        padding: '6px 12px',
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? 'var(--accent)' : 'var(--panel-2)',
        color: active ? '#1a1206' : 'var(--text)',
        border: '1px solid var(--border)',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

function SavedTop10Table({ snapshot, asOf }: { snapshot: HrTargetSnapshotRow[]; asOf: string }) {
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Team</th>
            <th>Game</th>
            <th className="num">Heat (saved)</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.map((s) => (
            <tr key={`${s.player_id}-${s.game_pk}`}>
              <td className="num">{s.rank}</td>
              <td>
                <Link className="player-link" to={`/player/${s.player_id}?asOf=${asOf}`}>
                  {s.player_name}
                </Link>
              </td>
              <td><span className="pill">{s.team}</span></td>
              <td className="subtle" style={{ fontSize: 12 }}>vs {s.opponent}</td>
              <td className="num"><strong>{Number(s.heat_score).toFixed(1)}</strong></td>
              <td className="subtle" style={{ fontSize: 12 }}>{s.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="subtle" style={{ marginTop: 6, fontSize: 11 }}>
        Rows are from <code>hr_target_snapshots</code> — identical to what Backtest reads.
        Per-row matchup breakdown is unavailable in Saved Snapshot mode; switch to{' '}
        <strong>Live Preview</strong> to expand a row for the heat-score breakdown.
      </div>
    </div>
  );
}

function CompareTable({
  savedSnapshot,
  liveTop,
  asOf,
}: {
  savedSnapshot: HrTargetSnapshotRow[];
  liveTop: HrTarget[];
  asOf: string;
}) {
  interface CompareRow {
    player_id: number;
    player_name: string;
    team: string;
    opponent: string;
    saved_rank?: number;
    saved_heat?: number;
    live_rank?: number;
    live_heat?: number;
  }

  const map = new Map<number, CompareRow>();
  savedSnapshot.slice(0, 20).forEach((s) => {
    map.set(s.player_id, {
      player_id: s.player_id,
      player_name: s.player_name,
      team: s.team,
      opponent: s.opponent,
      saved_rank: s.rank,
      saved_heat: Number(s.heat_score),
    });
  });
  liveTop.forEach((t, i) => {
    const cur = map.get(t.player_id) ?? {
      player_id: t.player_id,
      player_name: t.player_name,
      team: t.team,
      opponent: t.opponent,
    };
    cur.live_rank = i + 1;
    cur.live_heat = t.heat_score;
    map.set(t.player_id, cur);
  });

  // Show players ranked in saved top-15 OR live top-15 — surfaces drift in both directions
  const rows = Array.from(map.values())
    .filter((r) => (r.saved_rank ?? 99) <= 15 || (r.live_rank ?? 99) <= 15)
    .sort((a, b) => (a.saved_rank ?? 99) - (b.saved_rank ?? 99));

  function delta(a?: number, b?: number) {
    if (a == null || b == null) return null;
    const d = a - b;
    if (d === 0) return <span className="subtle">±0</span>;
    const color = d < 0 ? 'var(--good)' : '#ff8d8d'; // negative = rank improved (lower)
    return <span style={{ color }}>{d > 0 ? `+${d}` : d}</span>;
  }

  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Team</th>
            <th>Game</th>
            <th className="num">Saved rank</th>
            <th className="num">Live rank</th>
            <th className="num">Δ rank</th>
            <th className="num">Saved heat</th>
            <th className="num">Live heat</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id}>
              <td>
                <Link className="player-link" to={`/player/${r.player_id}?asOf=${asOf}`}>
                  {r.player_name}
                </Link>
              </td>
              <td><span className="pill">{r.team}</span></td>
              <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent}</td>
              <td className="num">{r.saved_rank ?? '—'}</td>
              <td className="num">{r.live_rank ?? '—'}</td>
              <td className="num">{delta(r.live_rank, r.saved_rank)}</td>
              <td className="num">{r.saved_heat?.toFixed(1) ?? '—'}</td>
              <td className="num">{r.live_heat?.toFixed(1) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="subtle" style={{ marginTop: 6, fontSize: 11 }}>
        Δ rank = (live rank) - (saved rank). Negative = player moved UP since snapshot. Positive = moved DOWN.
        Players only in one list show — in the other column.
      </div>
    </div>
  );
}

function GameTargetsCard({ board, asOf }: { board: HrTargetsBoard; asOf: string }) {
  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, color: 'var(--text)', textTransform: 'none', letterSpacing: 0, fontSize: 18 }}>
          {board.away_team} @ {board.home_team}
        </h2>
        <div className="subtle" style={{ fontSize: 13 }}>
          {board.venue_name ?? 'Venue TBD'} · {board.game_date}
        </div>
      </div>

      <div className="grid" style={{ marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <SidePanel label={`${board.away_team} batters`} facing={board.away_facing} targets={board.away_targets} asOf={asOf} />
        <SidePanel label={`${board.home_team} batters`} facing={board.home_facing} targets={board.home_targets} asOf={asOf} />
      </div>
    </div>
  );
}

function SidePanel({
  label,
  facing,
  targets,
  asOf,
}: {
  label: string;
  facing: { id: number | null; name: string; hand: string | null };
  targets: HrTarget[];
  asOf: string;
}) {
  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <h2 style={{ marginBottom: 4 }}>{label}</h2>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 10 }}>
        vs {facing.name === 'TBD' ? 'TBD' : facing.name}
        {facing.hand && <span className="pill" style={{ marginLeft: 6 }}>{facing.hand}HP</span>}
      </div>

      {targets.length === 0 ? (
        <div className="empty">No qualifying hitters with stored HRs.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Bats</th>
                <th className="num">L3</th>
                <th className="num">L5</th>
                <th className="num">L7d</th>
                <th className="num">Season</th>
                <th className="num">Heat</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.player_id}>
                  <td>
                    <Link className="player-link" to={`/player/${t.player_id}?asOf=${asOf}`}>
                      {t.player_name}
                    </Link>
                  </td>
                  <td>{t.batter_side ?? '—'}</td>
                  <td className="num">{t.hrs_l3}</td>
                  <td className="num">{t.hrs_l5}</td>
                  <td className="num">{t.hrs_l7d}</td>
                  <td className="num">{t.season_hr}</td>
                  <td className="num"><strong>{t.heat_score.toFixed(1)}</strong></td>
                  <td className="subtle" style={{ fontSize: 12 }}>
                    {t.reasons.length > 0 ? t.reasons.join(' · ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
