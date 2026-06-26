/**
 * /learning/model/:version — Individual Model Card
 *
 * One page per model version. Shows:
 *   - Philosophy + current weights config
 *   - Today's live Top 10 (computed live by applying the model's signal
 *     bonuses to today's snapshot — no need for capture to have run)
 *   - Today's Safe / Value / Chaos parlays under this model
 *   - Why each pick was selected (chips + signal bonuses applied)
 *   - Historical performance (recent classifications + per-day links)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  supabase,
  fetchModelVersions,
  fetchPitcherFormIndex,
  fetchPlayerIndex,
  fetchOddsSnapshots,
  fetchLearningForDateVersion,
  type GameRow,
  type HomeRunRow,
  type LearningPredictionRow,
  type ModelVersionRow,
} from '../../lib/supabase';
import { mlbToday } from '../../lib/mlbDate';
import {
  addDays,
  applyCanonicalTeams,
  computeHrTargets,
  pitcherHrLeaderboard,
  replayDateUnderModel,
  venueLeaderboard,
  ELITE_POWER_NAMES,
  type HrTargetGame,
  type ModelConfig,
  type PitcherFormLite,
  type PlayerTeamIndex,
  type RevAnalysisSnapshotRow,
} from '../../lib/stats';

const todayISO = mlbToday;
const PAGE = 1000;

// ---- minimal data fetchers (mirrors other learning pages) ----
async function fetchSeasonHrs(asOf: string): Promise<HomeRunRow[]> {
  const start = `${asOf.slice(0, 4)}-01-01`;
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase.from('home_runs').select('*')
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
  const { data, error } = await supabase.from('games').select('*')
    .eq('game_date', date).order('game_pk', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as GameRow[];
}

export default function ModelCardPage() {
  const params = useParams<{ version: string }>();
  const versionNum = Number(params.version);
  const [versions, setVersions] = useState<ModelVersionRow[]>([]);
  const [seasonHrs, setSeasonHrs] = useState<HomeRunRow[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [playerIndex, setPlayerIndex] = useState<PlayerTeamIndex>(new Map());
  const [pitcherStartsForm, setPitcherStartsForm] = useState<Map<number, PitcherFormLite>>(new Map());
  const [oddsByPlayer, setOddsByPlayer] = useState<Map<number, number>>(new Map());
  const [historicalPreds, setHistoricalPreds] = useState<LearningPredictionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const targetDate = todayISO();
  const asOf = useMemo(() => addDays(targetDate, -1), [targetDate]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        // 1. Load all versions for header + sibling links
        const vs = await fetchModelVersions();
        if (cancelled) return;
        setVersions(vs);
        const me = vs.find((v) => v.version === versionNum);
        if (!me) {
          setError(`Model version v${versionNum} not found. Apply migration 014 to seed v2-v6.`);
          return;
        }

        // 2. Today's data for live picks
        const [pi, hrs, gs, odds] = await Promise.all([
          fetchPlayerIndex().catch(() => new Map()),
          fetchSeasonHrs(asOf),
          fetchGamesOn(targetDate),
          fetchOddsSnapshots(targetDate).catch(() => []),
        ]);
        if (cancelled) return;
        setPlayerIndex(pi);
        setSeasonHrs(hrs);
        setGames(gs);
        const oddsMap = new Map<number, number>();
        const sorted = odds.slice().sort((a, b) => a.snapshot_time < b.snapshot_time ? -1 : 1);
        for (const r of sorted) if (r.player_id != null) oddsMap.set(r.player_id, r.american_odds);
        setOddsByPlayer(oddsMap);

        // 3. Probable pitcher form for live scoring
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
                k_per_9: f.k_per_9 ?? undefined, bb_per_9: f.bb_per_9 ?? undefined,
              });
            }
            setPitcherStartsForm(m);
          } catch { setPitcherStartsForm(new Map()); }
        }

        // 4. Recent historical predictions for this version
        const histAnchor = addDays(targetDate, -1);
        const from30 = addDays(histAnchor, -29);
        const PAGE_SIZE = 1000;
        const hist: LearningPredictionRow[] = [];
        for (let page = 0; page < 30; page++) {
          const { data, error: err } = await supabase
            .from('learning_predictions').select('*')
            .eq('model_version', versionNum)
            .gte('target_date', from30).lte('target_date', histAnchor)
            .order('target_date', { ascending: false }).order('rank', { ascending: true, nullsFirst: false })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
          if (err) break;
          const rows = (data ?? []) as LearningPredictionRow[];
          hist.push(...rows);
          if (rows.length < PAGE_SIZE) break;
        }
        setHistoricalPreds(hist);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [versionNum, asOf, targetDate]);

  const me = versions.find((v) => v.version === versionNum);
  const config: ModelConfig | null = useMemo(() => {
    if (!me) return null;
    const wj = me.weights_json as { signal_weights?: Record<string, number>; parlay_rules?: Record<string, number>; description?: string };
    return {
      version: me.version,
      name: me.name,
      signal_weights: (wj?.signal_weights ?? {}) as ModelConfig['signal_weights'],
      parlay_rules: (wj?.parlay_rules ?? {}) as ModelConfig['parlay_rules'],
      description: wj?.description,
    };
  }, [me]);

  // ---- Build live snapshots from today's data so we can apply the model
  //      signal weights and show what this version would bet TONIGHT ----
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
        allowed_last_3_starts: p.allowed_last_3_starts, starts_known: 0,
      }] as const),
    );
    for (const [id, real] of pitcherStartsForm) approx.set(id, real);
    return approx;
  }, [canonHrs, asOf, pitcherStartsForm]);
  const venueIndex = useMemo(() => {
    const board = venueLeaderboard(canonHrs, asOf);
    return new Map(board.map((v, i) => [v.venue_name, {
      venue_name: v.venue_name, l14d: v.l14d, rank_l14d: i + 1, total_ranked: board.length,
    }] as const));
  }, [canonHrs, asOf]);
  const targetGames: HrTargetGame[] = useMemo(() => games.map((g) => ({
    game_pk: g.game_pk, game_date: g.game_date, home_team: g.home_team, away_team: g.away_team,
    venue_name: g.venue_name,
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
  })), [games]);
  const boards = useMemo(
    () => computeHrTargets(canonHrs, asOf, targetGames, { pitcherIndex, venueIndex, elitePowerIds }),
    [canonHrs, asOf, targetGames, pitcherIndex, venueIndex, elitePowerIds],
  );

  // Synthesize live snapshot rows from boards (top 100 by heat) and apply
  // the model config to compute today's predictions under THIS version.
  const liveSnapshots: RevAnalysisSnapshotRow[] = useMemo(() => {
    const all = boards.flatMap((b) => [...b.away_targets, ...b.home_targets])
      .filter((t) => t.lineup_status === 'confirmed' || t.lineup_status === 'pending')
      .sort((a, b) => b.heat_score - a.heat_score);
    return all.slice(0, 100).map((t, i) => ({
      target_date: targetDate,
      player_id: t.player_id,
      player_name: t.player_name,
      team: t.team,
      rank: i + 1,
      heat_score: t.heat_score,
      reason: t.reasons.join(' · ') || null,
    }));
  }, [boards, targetDate]);

  const liveReplay = useMemo(() => {
    if (!config || liveSnapshots.length === 0) return null;
    return replayDateUnderModel({
      date: targetDate,
      snapshots: liveSnapshots,
      odds: oddsByPlayer,
      hr_player_ids: new Set(),
      hr_count_by_player: new Map(),
      opponent_by_player: new Map(),
      game_pk_by_player: new Map(),
      config,
    });
  }, [config, liveSnapshots, oddsByPlayer, targetDate]);

  // Historical performance roll-up
  const histPerf = useMemo(() => {
    const dateSet = new Set(historicalPreds.map((r) => r.target_date));
    const tp = historicalPreds.filter((r) => r.classification === 'TP').length;
    const fp = historicalPreds.filter((r) => r.classification === 'FP').length;
    const fn = historicalPreds.filter((r) => r.classification === 'FN').length;
    const tn = historicalPreds.filter((r) => r.classification === 'TN').length;
    return {
      days: dateSet.size,
      dates: Array.from(dateSet).sort().reverse(),
      tp, fp, fn, tn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    };
  }, [historicalPreds]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Link to="/learning" style={{ fontSize: 13 }}>← Learning Dashboard</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>{me ? `v${me.version} ${me.name}` : `v${versionNum}`}</h1>
        {me?.active && <span className="mc-active">ACTIVE</span>}
        {me?.retired && <span className="mc-retired">RETIRED</span>}
      </div>

      {/* Sibling version chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {versions.map((v) => (
          <Link key={v.version} to={`/learning/model/${v.version}`} style={{ textDecoration: 'none' }}>
            <span className={`mc-version-chip ${v.version === versionNum ? 'mc-version-chip--active' : ''}`}>
              v{v.version}
            </span>
          </Link>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle">Loading…</div>}

      {!loading && me && config && (
        <>
          {/* Philosophy + weights */}
          <div className="mc-panel">
            <h2 style={{ margin: 0, fontSize: 16 }}>📖 Philosophy</h2>
            <p style={{ fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>
              {config.description ?? (me.notes ?? 'No description provided.')}
            </p>

            <h3 style={{ margin: '12px 0 6px', fontSize: 13 }}>Signal weight bonuses</h3>
            {Object.keys(config.signal_weights).length === 0 ? (
              <p className="subtle" style={{ fontSize: 12 }}>None — baseline.</p>
            ) : (
              <div className="mc-weight-grid">
                {Object.entries(config.signal_weights).map(([k, w]) => (
                  <div key={k} className="mc-weight-tile">
                    <div className="mc-weight-signal">{k.replace(/_/g, ' ')}</div>
                    <div className={`mc-weight-value ${(w ?? 0) > 0 ? 'mc-pos' : (w ?? 0) < 0 ? 'mc-neg' : ''}`}>
                      {(w ?? 0) >= 0 ? '+' : ''}{w}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {Object.keys(config.parlay_rules).length > 0 && (
              <>
                <h3 style={{ margin: '12px 0 6px', fontSize: 13 }}>Parlay rule overrides</h3>
                <div className="mc-weight-grid">
                  {Object.entries(config.parlay_rules).map(([k, v]) => (
                    <div key={k} className="mc-weight-tile">
                      <div className="mc-weight-signal">{k.replace(/_/g, ' ')}</div>
                      <div className="mc-weight-value">{v}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Today's live picks */}
          <div className="mc-panel" style={{ marginTop: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>🎯 Tonight's Top 10 under {me.name}</h2>
            <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
              Live computed: v1's heat scores + this model's signal-weight bonuses, re-ranked.
            </p>
            {!liveReplay ? (
              <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                Waiting for today's snapshot data…
              </p>
            ) : (
              <>
                <div className="mc-table-wrap" style={{ marginTop: 6 }}>
                  <table className="mc-table">
                    <thead>
                      <tr>
                        <th className="num">Rank</th>
                        <th>Player</th>
                        <th>Team</th>
                        <th className="num">Heat</th>
                        <th className="num">Δ vs v1</th>
                        <th className="num">Model prob</th>
                        <th className="num">Odds</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveReplay.candidates.slice(0, 10).map((c) => {
                        const delta = c.heat_score - c.original_heat;
                        return (
                          <tr key={c.player_id}>
                            <td className="num"><strong>{c.rank}</strong></td>
                            <td>{c.player_name}</td>
                            <td>{c.team}</td>
                            <td className="num">{c.heat_score.toFixed(1)}</td>
                            <td className={`num ${delta > 0 ? 'mc-pos' : delta < 0 ? 'mc-neg' : ''}`}>
                              {delta === 0 ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
                            </td>
                            <td className="num">{(c.model_prob * 100).toFixed(1)}%</td>
                            <td className="num">{c.american_odds != null ? `${c.american_odds > 0 ? '+' : ''}${c.american_odds}` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <h3 style={{ margin: '16px 0 6px', fontSize: 13 }}>Today's Parlays</h3>
                <div className="mc-parlay-grid">
                  <ParlayCard parlay={liveReplay.safe} accent="#4cd97a" />
                  <ParlayCard parlay={liveReplay.value} accent="#ffb86c" />
                  <ParlayCard parlay={liveReplay.chaos} accent="#c084fc" />
                </div>
              </>
            )}
          </div>

          {/* Historical performance */}
          <div className="mc-panel" style={{ marginTop: 12 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>📊 Historical Performance ({histPerf.days} days)</h2>
            {histPerf.days === 0 ? (
              <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                No captured predictions yet for v{versionNum}.
                {versionNum > 1 && <> Run <code>npm run learning:replay-models</code> to populate.</>}
              </p>
            ) : (
              <>
                <div className="mc-stats-grid" style={{ marginTop: 6 }}>
                  <Stat label="TP" value={histPerf.tp} color="#6bd482" />
                  <Stat label="FP" value={histPerf.fp} color="#ffb86c" />
                  <Stat label="FN" value={histPerf.fn} color="#e07a7a" />
                  <Stat label="TN" value={histPerf.tn} color="#aab1c0" />
                  <Stat label="Precision" value={`${(histPerf.precision * 100).toFixed(1)}%`} color="#cfe" />
                  <Stat label="Recall" value={`${(histPerf.recall * 100).toFixed(1)}%`} color="#cfe" />
                </div>
                <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>Dates captured (click to inspect)</h3>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {histPerf.dates.slice(0, 30).map((d) => (
                    <Link key={d} to={`/learning/day/${d}`} className="mc-date-chip">{d}</Link>
                  ))}
                  {histPerf.dates.length > 30 && (
                    <span className="subtle" style={{ fontSize: 11 }}>+{histPerf.dates.length - 30} more</span>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}

      <ModelCardStyles />
    </>
  );
}

function ParlayCard({ parlay, accent }: { parlay: import('../../lib/stats').Parlay; accent: string }) {
  if (parlay.incomplete) {
    return (
      <div className="mc-parlay" style={{ borderTop: `3px solid ${accent}` }}>
        <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{parlay.style.toUpperCase()}</h4>
        <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
          Rules couldn't fill 3 legs today.
        </p>
      </div>
    );
  }
  return (
    <div className="mc-parlay" style={{ borderTop: `3px solid ${accent}` }}>
      <h4 style={{ margin: 0, fontSize: 13, color: accent }}>{parlay.style.toUpperCase()}</h4>
      <div style={{ marginTop: 4 }}>
        {parlay.legs.map((leg, i) => (
          <div key={leg.player_id} className="mc-leg">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <strong>{i + 1}. {leg.player_name}</strong>
              <span className="subtle">{leg.team}</span>
            </div>
            <div className="subtle" style={{ fontSize: 10.5, marginTop: 1 }}>
              heat {leg.heat_score.toFixed(0)} · prob {(leg.model_prob * 100).toFixed(1)}%
              {leg.american_odds != null && ` · ${leg.american_odds > 0 ? '+' : ''}${leg.american_odds}`}
            </div>
          </div>
        ))}
      </div>
      {parlay.parlay_american != null && (
        <div className="subtle" style={{ fontSize: 11, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border, #232732)' }}>
          Parlay {parlay.parlay_american > 0 ? '+' : ''}{parlay.parlay_american} · joint model prob {(parlay.parlay_model_prob * 100).toFixed(2)}%
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="mc-stat" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="mc-stat-label">{label}</div>
      <div className="mc-stat-value" style={{ color }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

function ModelCardStyles() {
  return (
    <style>{`
      .mc-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 12px 14px;
      }
      .mc-active {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        background: rgba(192,132,252,0.18); color: #c084fc;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .mc-retired {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        background: rgba(224,122,122,0.18); color: #e07a7a;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .mc-version-chip {
        display: inline-block; padding: 3px 9px; border-radius: 999px;
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        color: #cfe; font-size: 12px;
      }
      .mc-version-chip--active {
        background: #2d3a52; border-color: #4a6fa5; color: #fff; font-weight: 700;
      }

      .mc-weight-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 6px;
      }
      .mc-weight-tile {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        border-radius: 6px; padding: 6px 9px;
      }
      .mc-weight-signal { font-size: 11px; opacity: 0.75; text-transform: capitalize; }
      .mc-weight-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
      .mc-pos { color: #6bd482; }
      .mc-neg { color: #e07a7a; }

      .mc-table-wrap { overflow-x: auto; }
      .mc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .mc-table th, .mc-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .mc-table th.num, .mc-table td.num { text-align: right; }

      .mc-parlay-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 8px;
      }
      .mc-parlay {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        border-radius: 8px; padding: 8px 10px;
      }
      .mc-leg {
        padding: 5px 8px; background: var(--panel, #11141c); border-radius: 6px;
        margin-top: 4px;
      }

      .mc-stats-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 6px;
      }
      .mc-stat {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        border-radius: 6px; padding: 6px 9px;
      }
      .mc-stat-label { font-size: 10.5px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .mc-stat-value { font-size: 18px; font-weight: 700; margin-top: 2px; }

      .mc-date-chip {
        display: inline-block; padding: 3px 9px; border-radius: 6px;
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        font-size: 11px; text-decoration: none; color: #cfe;
      }
      .mc-date-chip:hover { background: #2d3a52; }
    `}</style>
  );
}
