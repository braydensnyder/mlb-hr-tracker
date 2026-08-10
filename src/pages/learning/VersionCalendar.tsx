/**
 * /learning/calendar — Version Performance Calendar (Priority 1)
 *
 * The "look at the data" tool. Two views:
 *   1. Daily comparison — pick a date, see every version's Top 3/5/10/25
 *      hit counts side-by-side. Rows expand to show the actual picks.
 *   2. Rolling summary — 7d / 14d / 30d averages, best/worst day, and
 *      days beating the core (v1) version.
 *
 * Goal: make it instantly obvious whether a version is actually better
 * or whether recent performance is just variance.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchCapturedDates,
  fetchVersionCalendar,
  fetchVersionRolling,
  type CalendarDayResult,
  type CalendarRollingRow,
  type LearningPredictionRow,
} from '../../lib/supabase';
import { mlbToday } from '../../lib/mlbDate';
import { addDays } from '../../lib/stats';

type Window = 7 | 14 | 30;

export default function VersionCalendarPage() {
  // Default to yesterday (most recent completed day).
  const yesterday = addDays(mlbToday(), -1);
  const [selectedDate, setSelectedDate] = useState<string>(yesterday);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [daily, setDaily] = useState<CalendarDayResult | null>(null);
  const [rolling, setRolling] = useState<CalendarRollingRow[]>([]);
  const [window, setWindow] = useState<Window>(14);
  const [loadingDaily, setLoadingDaily] = useState(true);
  const [loadingRolling, setLoadingRolling] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  // Load list of captured dates for the dropdown.
  useEffect(() => {
    let cancelled = false;
    fetchCapturedDates({ limit: 90 })
      .then((dates) => { if (!cancelled) setAvailableDates(dates); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Load daily view when date changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingDaily(true); setError(null);
    fetchVersionCalendar(selectedDate)
      .then((r) => { if (!cancelled) setDaily(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoadingDaily(false); });
    return () => { cancelled = true; };
  }, [selectedDate]);

  // Load rolling summary when window changes.
  useEffect(() => {
    let cancelled = false;
    setLoadingRolling(true);
    const anchor = addDays(mlbToday(), -1);
    const from = addDays(anchor, -(window - 1));
    fetchVersionRolling({ from, to: anchor })
      .then((r) => { if (!cancelled) setRolling(r); })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoadingRolling(false); });
    return () => { cancelled = true; };
  }, [window]);

  // Sort daily rows: by top10 hits desc, tiebreak on top5 then top3.
  const sortedVersions = useMemo(() => {
    if (!daily) return [];
    return daily.versions.slice().sort((a, b) => {
      if (b.top10_hits !== a.top10_hits) return b.top10_hits - a.top10_hits;
      if (b.top5_hits !== a.top5_hits) return b.top5_hits - a.top5_hits;
      if (b.top3_hits !== a.top3_hits) return b.top3_hits - a.top3_hits;
      return a.version - b.version;
    });
  }, [daily]);

  // Rolling rows sorted by avg_top10 desc (best model at top).
  const sortedRolling = useMemo(() => {
    return rolling.slice().sort((a, b) => {
      if (a.days_tested === 0 && b.days_tested === 0) return a.version - b.version;
      if (a.days_tested === 0) return 1;
      if (b.days_tested === 0) return -1;
      return b.avg_top10 - a.avg_top10;
    });
  }, [rolling]);

  const dateIdx = availableDates.indexOf(selectedDate);
  const prevDate = dateIdx !== -1 && dateIdx < availableDates.length - 1 ? availableDates[dateIdx + 1] : null;
  const nextDate = dateIdx > 0 ? availableDates[dateIdx - 1] : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Link to="/learning" style={{ fontSize: 13 }}>← Learning Dashboard</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>📆 Version Performance Calendar</h1>
      </div>

      {/* Date picker */}
      <div className="vc-panel">
        <div className="vc-picker">
          <label>
            <span style={{ fontSize: 11, opacity: 0.7 }}>Pick a date:</span>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </label>
          <span style={{ fontSize: 11, opacity: 0.6 }}>or:</span>
          <select
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12 }}
          >
            {availableDates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {prevDate && <button className="vc-btn" onClick={() => setSelectedDate(prevDate)}>← {prevDate}</button>}
            {nextDate && <button className="vc-btn" onClick={() => setSelectedDate(nextDate)}>{nextDate} →</button>}
          </span>
        </div>
      </div>

      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

      {/* Daily comparison */}
      <div className="vc-panel" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>📅 {selectedDate}</h2>
          {daily && (
            <span style={{ fontSize: 13 }}>
              <strong>{daily.total_hr_hitters}</strong> HR hitters this day
            </span>
          )}
        </div>

        {loadingDaily ? (
          <div className="subtle" style={{ marginTop: 8 }}>Loading…</div>
        ) : !daily || daily.versions.length === 0 ? (
          <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>
            No captures for this date yet. Try{' '}
            <code>npm run learning:capture -- {selectedDate}</code> then{' '}
            <code>npm run learning:replay-models -- --date {selectedDate}</code>.
          </div>
        ) : (
          <div className="vc-table-wrap" style={{ marginTop: 8 }}>
            <table className="vc-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Version</th>
                  <th className="num">Top 3</th>
                  <th className="num">Top 5</th>
                  <th className="num">Top 10</th>
                  <th className="num">Top 25</th>
                </tr>
              </thead>
              <tbody>
                {sortedVersions.map((v, i) => {
                  const isExpanded = expandedVersion === v.version;
                  const picks = daily.picks_by_version.get(v.version) ?? [];
                  return (
                    <FragmentRow
                      key={v.version}
                      rank={i}
                      version={v}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedVersion(isExpanded ? null : v.version)}
                      picks={picks}
                      totalHr={daily.total_hr_hitters}
                      selectedDate={selectedDate}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rolling summary */}
      <div className="vc-panel" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>📊 Rolling summary</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {([7, 14, 30] as Window[]).map((w) => (
              <button
                key={w}
                className={`vc-btn ${window === w ? 'vc-btn--active' : ''}`}
                onClick={() => setWindow(w)}
              >
                Last {w} days
              </button>
            ))}
          </div>
        </div>

        {loadingRolling ? (
          <div className="subtle" style={{ marginTop: 8 }}>Loading…</div>
        ) : sortedRolling.length === 0 ? (
          <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>No rolling data available.</div>
        ) : (
          <div className="vc-table-wrap" style={{ marginTop: 8 }}>
            <table className="vc-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Version</th>
                  <th className="num">Days</th>
                  <th className="num">Avg Top 3</th>
                  <th className="num">Avg Top 5</th>
                  <th className="num">Avg Top 10</th>
                  <th className="num">Best day</th>
                  <th className="num">Worst day</th>
                  <th className="num">Beats v1</th>
                </tr>
              </thead>
              <tbody>
                {sortedRolling.map((r, i) => (
                  <tr key={r.version}>
                    <td>
                      {r.days_tested > 0 && i === 0 && <span style={{ color: '#c084fc' }}>🥇</span>}
                      {r.days_tested > 0 && i === 1 && <span>🥈</span>}
                      {r.days_tested > 0 && i === 2 && <span>🥉</span>}
                    </td>
                    <td>
                      <Link to={`/learning/model/${r.version}`} style={{ color: '#cfe', textDecoration: 'none' }}>
                        <strong>v{r.version}</strong> {r.name}
                      </Link>
                      {r.is_active && <span className="vc-active" style={{ marginLeft: 6 }}>active</span>}
                      {r.is_retired && <span className="vc-retired" style={{ marginLeft: 4 }}>retired</span>}
                    </td>
                    <td className="num">{r.days_tested}</td>
                    <td className="num">{r.days_tested > 0 ? r.avg_top3.toFixed(2) : '—'}</td>
                    <td className="num">{r.days_tested > 0 ? r.avg_top5.toFixed(2) : '—'}</td>
                    <td className={`num ${r.avg_top10 >= 3 ? 'vc-pos' : r.avg_top10 >= 1.5 ? '' : 'vc-neg'}`}>
                      {r.days_tested > 0 ? r.avg_top10.toFixed(2) : '—'}
                    </td>
                    <td className="num subtle" style={{ fontSize: 11 }}>
                      {r.best_day ? `${r.best_day.date} (${r.best_day.top10_hits}/10)` : '—'}
                    </td>
                    <td className="num subtle" style={{ fontSize: 11 }}>
                      {r.worst_day ? `${r.worst_day.date} (${r.worst_day.top10_hits}/10 of ${r.worst_day.hr_hitters} HR)` : '—'}
                    </td>
                    <td className="num">
                      {r.version === 1 ? (
                        <span className="subtle">core</span>
                      ) : r.days_compared === 0 ? (
                        '—'
                      ) : (
                        <span className={r.days_beating_core > r.days_compared / 2 ? 'vc-pos' : 'vc-neg'}>
                          {r.days_beating_core}/{r.days_compared}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="subtle" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>
              <strong>How to read:</strong> "Avg Top 10" = mean HR hitters caught in Top 10 per day (higher = better).
              "Beats v1" = # of days this version had strictly more Top-10 hits than v1 / # of days both were tested.
              A ratio ≤ 50% with a small sample is variance, not signal — hold weights until it clears 60%+ across 20+ days.
            </p>
          </div>
        )}
      </div>

      <VersionCalendarStyles />
    </>
  );
}

function FragmentRow({ rank, version, isExpanded, onToggle, picks, totalHr, selectedDate }: {
  rank: number;
  version: import('../../lib/supabase').CalendarVersionRow;
  isExpanded: boolean;
  onToggle: () => void;
  picks: LearningPredictionRow[];
  totalHr: number;
  selectedDate: string;
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }} className={isExpanded ? 'vc-row-open' : ''}>
        <td style={{ width: 20 }}>
          {rank === 0 && <span style={{ color: '#c084fc' }}>🥇</span>}
          {rank === 1 && <span>🥈</span>}
          {rank === 2 && <span>🥉</span>}
        </td>
        <td>
          <span style={{ marginRight: 6, opacity: 0.5 }}>{isExpanded ? '▾' : '▸'}</span>
          <Link to={`/learning/model/${version.version}`} style={{ color: '#cfe', textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
            <strong>v{version.version}</strong> {version.name}
          </Link>
          {version.is_active && <span className="vc-active" style={{ marginLeft: 6 }}>active</span>}
          {version.is_retired && <span className="vc-retired" style={{ marginLeft: 4 }}>retired</span>}
        </td>
        <td className="num"><span className={version.top3_hits > 0 ? 'vc-pos' : ''}>{version.top3_hits}/3</span></td>
        <td className="num"><span className={version.top5_hits > 0 ? 'vc-pos' : ''}>{version.top5_hits}/5</span></td>
        <td className="num">
          <span className={version.top10_hits >= 3 ? 'vc-pos' : version.top10_hits >= 1 ? '' : 'vc-neg'}>
            {version.top10_hits}/10
          </span>
        </td>
        <td className="num"><span className={version.top25_hits >= 5 ? 'vc-pos' : ''}>{version.top25_hits}/25</span></td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={6} style={{ background: 'var(--panel-2, #14171f)', padding: 10 }}>
            <PicksList picks={picks} totalHr={totalHr} selectedDate={selectedDate} />
          </td>
        </tr>
      )}
    </>
  );
}

function PicksList({ picks, totalHr, selectedDate }: { picks: LearningPredictionRow[]; totalHr: number; selectedDate: string }) {
  // Split into Top 10 (rank ≤ 10) and remaining ranked (rank 11-50), then unranked HR hitters.
  const top10 = picks.filter((p) => p.rank != null && p.rank <= 10).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const rank11to50 = picks.filter((p) => p.rank != null && p.rank > 10 && p.rank <= 50 && p.homered === true).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const unrankedHrs = picks.filter((p) => p.rank == null && p.homered === true);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Top 10 picks</div>
        <div className="vc-table-wrap">
          <table className="vc-picks-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th>Team</th>
                <th className="num">Heat</th>
                <th className="num">Model prob</th>
                <th className="num">Signals</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {top10.map((p) => (
                <tr key={p.player_id} className={p.homered === true ? 'vc-hit' : ''}>
                  <td className="num">{p.rank}</td>
                  <td>
                    <Link to={`/player/${p.player_id}?asOf=${selectedDate}`} style={{ color: '#cfe' }}>
                      {p.player_name}
                    </Link>
                  </td>
                  <td>{p.team}</td>
                  <td className="num">{p.heat_score?.toFixed(1) ?? '—'}</td>
                  <td className="num">{p.model_prob != null ? `${(p.model_prob * 100).toFixed(1)}%` : '—'}</td>
                  <td className="num subtle" style={{ fontSize: 10.5 }}>
                    {activeSignalCount(p)}
                  </td>
                  <td>
                    {p.homered === true
                      ? <span style={{ color: '#6bd482', fontWeight: 700 }}>✓ HR</span>
                      : <span style={{ opacity: 0.5 }}>· miss</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rank11to50.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, opacity: 0.85 }}>
            Near-miss HR hitters (ranked 11–50)
          </div>
          <div className="vc-table-wrap">
            <table className="vc-picks-table">
              <thead>
                <tr><th className="num">#</th><th>Player</th><th>Team</th><th className="num">Heat</th></tr>
              </thead>
              <tbody>
                {rank11to50.map((p) => (
                  <tr key={p.player_id}>
                    <td className="num">{p.rank}</td>
                    <td>{p.player_name}</td>
                    <td>{p.team}</td>
                    <td className="num">{p.heat_score?.toFixed(1) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unrankedHrs.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, opacity: 0.85 }}>
            Missed entirely (HR hitters not in pool)
          </div>
          <div className="vc-table-wrap">
            <table className="vc-picks-table">
              <thead>
                <tr><th>Player</th><th>Team</th></tr>
              </thead>
              <tbody>
                {unrankedHrs.map((p) => (
                  <tr key={p.player_id}>
                    <td>{p.player_name}</td>
                    <td>{p.team}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="subtle" style={{ fontSize: 10.5, marginTop: 2 }}>
        Total HR hitters this date: <strong>{totalHr}</strong>. This version caught{' '}
        <strong>{top10.filter((p) => p.homered === true).length}</strong> in Top 10.
      </p>
    </div>
  );
}

function activeSignalCount(p: LearningPredictionRow): string {
  const s = p.signals_json ?? {};
  const active = Object.entries(s).filter(([, v]) => v === true).map(([k]) => k);
  if (active.length === 0) return '—';
  return active.slice(0, 3).map((k) => k.replace(/_/g, ' ')).join(', ')
    + (active.length > 3 ? ` +${active.length - 3}` : '');
}

function VersionCalendarStyles() {
  return (
    <style>{`
      .vc-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 12px 14px;
      }
      .vc-picker { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .vc-picker label { display: flex; flex-direction: column; gap: 3px; }
      .vc-picker input, .vc-picker select {
        background: var(--panel-2, #14171f); color: #cfe;
        border: 1px solid var(--border, #232732); border-radius: 6px;
        padding: 4px 8px; font-size: 12px;
      }
      .vc-btn {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        color: #cfe; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
      }
      .vc-btn--active { background: #2d3a52; border-color: #4a6fa5; color: #fff; font-weight: 700; }
      .vc-table-wrap { overflow-x: auto; }
      .vc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .vc-table th, .vc-table td {
        text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--border, #1f2330);
        white-space: nowrap;
      }
      .vc-table th.num, .vc-table td.num { text-align: right; }
      .vc-table tbody tr:hover { background: rgba(255,255,255,0.02); }
      .vc-row-open { background: rgba(192,132,252,0.05); }
      .vc-pos { color: #6bd482; font-weight: 600; }
      .vc-neg { color: #e07a7a; }
      .vc-active {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        background: rgba(192,132,252,0.18); color: #c084fc;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .vc-retired {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        background: rgba(224,122,122,0.18); color: #e07a7a;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .vc-picks-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .vc-picks-table th, .vc-picks-table td {
        text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #1f2330);
        white-space: nowrap;
      }
      .vc-picks-table th.num, .vc-picks-table td.num { text-align: right; }
      .vc-picks-table tbody tr.vc-hit td { background: rgba(64,200,120,0.06); }
    `}</style>
  );
}
