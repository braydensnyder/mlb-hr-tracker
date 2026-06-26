/**
 * /learning/day/:date — Historical replay of a single past slate.
 *
 * Shows what each model predicted BEFORE games started + how it played
 * out. For each model version:
 *   - Top 10 (from learning_predictions)
 *   - Safe / Value / Chaos parlay legs with ✓/✗ per leg
 *   - Result: 0/3, 1/3, 2/3, 3/3 per parlay
 * Plus the actual HR-hitter list and which models missed them.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchAllVersionsForDate,
  fetchCapturedDates,
  fetchModelVersions,
  type LearningPredictionRow,
  type ModelVersionRow,
} from '../../lib/supabase';

export default function HistoricalDayPage() {
  const params = useParams<{ date: string }>();
  const date = params.date ?? '';
  const [predictions, setPredictions] = useState<LearningPredictionRow[]>([]);
  const [versions, setVersions] = useState<ModelVersionRow[]>([]);
  const [allDates, setAllDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const [preds, vs, dates] = await Promise.all([
          fetchAllVersionsForDate(date),
          fetchModelVersions(),
          fetchCapturedDates({ limit: 60 }),
        ]);
        if (cancelled) return;
        setPredictions(preds);
        setVersions(vs);
        setAllDates(dates);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  // Group by model_version
  const byVersion = useMemo(() => {
    const m = new Map<number, LearningPredictionRow[]>();
    for (const p of predictions) {
      const arr = m.get(p.model_version) ?? [];
      arr.push(p);
      m.set(p.model_version, arr);
    }
    return m;
  }, [predictions]);

  // Actual HR hitters that day (any version's homered=true rows)
  const actualHrs = useMemo(() => {
    const m = new Map<number, { player_name: string; team: string; hr_count: number }>();
    for (const p of predictions) {
      if (p.homered === true && !m.has(p.player_id)) {
        m.set(p.player_id, { player_name: p.player_name, team: p.team, hr_count: p.hr_count ?? 1 });
      }
    }
    return Array.from(m.entries()).map(([id, info]) => ({ player_id: id, ...info }));
  }, [predictions]);

  // For each HR hitter, which versions had them in Top 10?
  const hrCoverageByVersion = useMemo(() => {
    const m = new Map<number, Set<number>>(); // player_id → Set<version>
    for (const p of predictions) {
      if (p.homered === true && p.rank != null && p.rank <= 10) {
        let s = m.get(p.player_id);
        if (!s) { s = new Set(); m.set(p.player_id, s); }
        s.add(p.model_version);
      }
    }
    return m;
  }, [predictions]);

  // Adjacent date navigation
  const dateIndex = allDates.indexOf(date);
  const prevDate = dateIndex !== -1 && dateIndex < allDates.length - 1 ? allDates[dateIndex + 1] : null;
  const nextDate = dateIndex > 0 ? allDates[dateIndex - 1] : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <Link to="/learning" style={{ fontSize: 13 }}>← Learning Dashboard</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>📅 {date}</h1>
        {prevDate && <Link to={`/learning/day/${prevDate}`} style={{ fontSize: 12 }}>← {prevDate}</Link>}
        {nextDate && <Link to={`/learning/day/${nextDate}`} style={{ fontSize: 12 }}>{nextDate} →</Link>}
        <Link to={`/learning/compare/${date}`} style={{ fontSize: 12, marginLeft: 'auto' }}>Compare side-by-side →</Link>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle">Loading…</div>}

      {!loading && predictions.length === 0 && (
        <div className="hd-panel">
          <p>No captures for {date}. Run:</p>
          <pre className="hd-code">npm run learning:capture -- {date}{'\n'}npm run learning:replay-models -- --date {date}</pre>
        </div>
      )}

      {!loading && predictions.length > 0 && (
        <>
          {/* Actual HR-hitter list with model coverage */}
          <div className="hd-panel">
            <h2 style={{ margin: 0, fontSize: 15 }}>⚾ Actual HR hitters ({actualHrs.length})</h2>
            {actualHrs.length === 0 ? (
              <p className="subtle" style={{ fontSize: 12 }}>No HRs on this date.</p>
            ) : (
              <div className="hd-table-wrap" style={{ marginTop: 6 }}>
                <table className="hd-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Team</th>
                      <th className="num">HRs</th>
                      {versions.map((v) => (
                        <th key={v.version} className="num" title={v.name}>v{v.version}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {actualHrs.map((h) => {
                      const coverage = hrCoverageByVersion.get(h.player_id) ?? new Set();
                      return (
                        <tr key={h.player_id}>
                          <td><strong>{h.player_name}</strong></td>
                          <td>{h.team}</td>
                          <td className="num">{h.hr_count}</td>
                          {versions.map((v) => (
                            <td key={v.version} className="num">
                              {coverage.has(v.version)
                                ? <span style={{ color: '#6bd482', fontWeight: 700 }}>✓</span>
                                : <span style={{ opacity: 0.5 }}>·</span>}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="subtle" style={{ fontSize: 10.5, marginTop: 6 }}>
                  ✓ = model's Top 10 included this HR hitter pre-game.
                </p>
              </div>
            )}
          </div>

          {/* Per-version drill-down */}
          {versions
            .filter((v) => byVersion.has(v.version))
            .map((v) => <VersionDayCard key={v.version} version={v} preds={byVersion.get(v.version) ?? []} />)
          }
        </>
      )}

      <HistoricalDayStyles />
    </>
  );
}

function VersionDayCard({ version, preds }: { version: ModelVersionRow; preds: LearningPredictionRow[] }) {
  const top10 = preds.filter((p) => p.rank != null && p.rank <= 10).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const safeLegs = preds.filter((p) => p.in_safe);
  const valueLegs = preds.filter((p) => p.in_value);
  const chaosLegs = preds.filter((p) => p.in_chaos);
  const top10Hits = top10.filter((p) => p.homered === true).length;
  const safeHits = safeLegs.filter((p) => p.homered === true).length;
  const valueHits = valueLegs.filter((p) => p.homered === true).length;
  const chaosHits = chaosLegs.filter((p) => p.homered === true).length;

  return (
    <div className="hd-panel" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>
          <Link to={`/learning/model/${version.version}`} style={{ color: '#cfe', textDecoration: 'none' }}>
            v{version.version} {version.name}
          </Link>
          {version.active && <span className="hd-active">ACTIVE</span>}
        </h2>
        <span className="subtle" style={{ fontSize: 11 }}>
          Top 10 hits: {top10Hits} · Safe {safeHits}/{safeLegs.length} · Value {valueHits}/{valueLegs.length} · Chaos {chaosHits}/{chaosLegs.length}
        </span>
      </div>

      {/* Top 10 mini-table */}
      <h3 style={{ margin: '8px 0 4px', fontSize: 12, opacity: 0.85 }}>Top 10</h3>
      <div className="hd-table-wrap">
        <table className="hd-table">
          <thead>
            <tr><th className="num">#</th><th>Player</th><th>Team</th><th className="num">Heat</th><th>HR?</th></tr>
          </thead>
          <tbody>
            {top10.map((p) => (
              <tr key={p.player_id} className={p.homered === true ? 'hd-hit' : ''}>
                <td className="num">{p.rank}</td>
                <td>{p.player_name}</td>
                <td>{p.team}</td>
                <td className="num">{p.heat_score?.toFixed(1) ?? '—'}</td>
                <td>{p.homered === true ? <span style={{ color: '#6bd482', fontWeight: 700 }}>✓</span> : <span style={{ opacity: 0.5 }}>·</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Parlays */}
      <h3 style={{ margin: '10px 0 4px', fontSize: 12, opacity: 0.85 }}>Parlays</h3>
      <div className="hd-parlay-grid">
        <ParlaySummary title="SAFE" accent="#4cd97a" legs={safeLegs} hits={safeHits} />
        <ParlaySummary title="VALUE" accent="#ffb86c" legs={valueLegs} hits={valueHits} />
        <ParlaySummary title="CHAOS" accent="#c084fc" legs={chaosLegs} hits={chaosHits} />
      </div>
    </div>
  );
}

function ParlaySummary({ title, accent, legs, hits }: { title: string; accent: string; legs: LearningPredictionRow[]; hits: number }) {
  const status = legs.length === 0 ? 'skipped' : hits === 3 ? '3/3 ✅' : hits === 2 ? '2/3' : hits === 1 ? '1/3' : '0/3';
  return (
    <div className="hd-parlay" style={{ borderTop: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color: accent, fontSize: 12 }}>{title}</strong>
        <span className={`hd-result ${hits === 3 ? 'hd-result--full' : hits === 2 ? 'hd-result--partial' : 'hd-result--bust'}`}>{status}</span>
      </div>
      {legs.length === 0 ? (
        <p className="subtle" style={{ fontSize: 11, marginTop: 4 }}>Rules couldn't fill 3 legs.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', fontSize: 11.5 }}>
          {legs.map((leg) => (
            <li key={leg.player_id} style={{ padding: '3px 0', borderBottom: '1px solid var(--border, #1f2330)' }}>
              <span style={{ color: leg.homered === true ? '#6bd482' : '#aab1c0', fontWeight: 700 }}>
                {leg.homered === true ? '✓' : '·'}
              </span>{' '}
              {leg.player_name} <span className="subtle" style={{ fontSize: 10 }}>({leg.team})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoricalDayStyles() {
  return (
    <style>{`
      .hd-panel {
        background: var(--panel, #11141c); border: 1px solid var(--border, #232732);
        border-radius: 10px; padding: 12px 14px;
      }
      .hd-active {
        margin-left: 6px; padding: 2px 8px; border-radius: 999px;
        background: rgba(192,132,252,0.18); color: #c084fc;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }
      .hd-table-wrap { overflow-x: auto; }
      .hd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .hd-table th, .hd-table td { text-align: left; padding: 4px 7px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .hd-table th.num, .hd-table td.num { text-align: right; }
      .hd-table tbody tr.hd-hit td { background: rgba(64,200,120,0.05); }

      .hd-parlay-grid {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 6px;
      }
      .hd-parlay {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        border-radius: 6px; padding: 6px 9px;
      }
      .hd-result {
        font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px;
      }
      .hd-result--full { background: rgba(64,200,120,0.20); color: #6bd482; }
      .hd-result--partial { background: rgba(255,210,140,0.20); color: #ffd28c; }
      .hd-result--bust { background: rgba(170,177,192,0.15); color: #aab1c0; }
      .hd-code {
        background: #0c0e14; border: 1px solid #1f2330; border-radius: 6px;
        padding: 8px 12px; font-size: 11.5px; line-height: 1.5;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
    `}</style>
  );
}
