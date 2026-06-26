/**
 * /learning/research — Research Questions page.
 *
 * Answers the "which model is best at X" questions by joining
 * learning_predictions with games and segmenting per-version performance:
 *   - vs RHP / LHP
 *   - on small / medium / large slates
 *   - in hot / warm / cool weather
 *   - in wind-out / wind-in conditions
 *   - in hitter-friendly / neutral / pitcher-friendly parks
 *
 * Each segment shows per-version recall, precision, F1, and Top-10
 * coverage within the bucket.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchResearchSegmentation,
  type ResearchSegment,
  type ResearchSegmentResult,
} from '../../lib/supabase';
import { mlbToday } from '../../lib/mlbDate';
import { addDays } from '../../lib/stats';

const SEGMENTS: { id: ResearchSegment; label: string; question: string }[] = [
  { id: 'pitcher_hand', label: 'Pitcher handedness', question: 'Which model performs best vs RHP vs LHP?' },
  { id: 'slate_size',   label: 'Slate size',         question: 'Which model performs best on small / large slates?' },
  { id: 'temperature',  label: 'Temperature',         question: 'Which model performs best in hot weather?' },
  { id: 'wind',         label: 'Wind direction',      question: 'Which model performs best with wind blowing out?' },
  { id: 'park_factor',  label: 'Park context',        question: 'Which model performs best in hitter-friendly parks?' },
];

export default function ResearchPage() {
  const [windowDays, setWindowDays] = useState<14 | 30 | 60>(30);
  const [selectedSegment, setSelectedSegment] = useState<ResearchSegment>('pitcher_hand');
  const [result, setResult] = useState<ResearchSegmentResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const anchor = addDays(mlbToday(), -1);
        const from = addDays(anchor, -(windowDays - 1));
        const r = await fetchResearchSegmentation({ from, to: anchor, segment: selectedSegment });
        if (cancelled) return;
        setResult(r);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [windowDays, selectedSegment]);

  const selected = SEGMENTS.find((s) => s.id === selectedSegment)!;

  // Winner per bucket
  const winners = useMemo(() => {
    if (!result) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const b of result.buckets) {
      let best: { v: number; f1: number; cov: number } | null = null;
      for (const pv of b.per_version) {
        if (pv.total_player_days < 20) continue; // need minimum sample
        if (!best || pv.f1 > best.f1 || (pv.f1 === best.f1 && pv.top10_coverage > best.cov)) {
          best = { v: pv.version, f1: pv.f1, cov: pv.top10_coverage };
        }
      }
      if (best) m.set(b.label, best.v);
    }
    return m;
  }, [result]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <Link to="/learning" style={{ fontSize: 13 }}>← Learning Dashboard</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>🔬 Research Questions</h1>
      </div>

      <p className="subtle" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        Segments captured predictions by game context and computes per-version performance inside each bucket.
        Joined client-side from learning_predictions + games on game_pk.
      </p>

      <div className="rq-panel">
        {/* Segment + window controls */}
        <div className="rq-controls">
          <div className="rq-btn-row">
            <span style={{ fontSize: 11, opacity: 0.7 }}>Question:</span>
            {SEGMENTS.map((s) => (
              <button
                key={s.id}
                className={`rq-btn ${selectedSegment === s.id ? 'rq-btn--active' : ''}`}
                onClick={() => setSelectedSegment(s.id)}
                title={s.question}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="rq-btn-row">
            <span style={{ fontSize: 11, opacity: 0.7 }}>Window:</span>
            {([14, 30, 60] as const).map((w) => (
              <button key={w} className={`rq-btn ${windowDays === w ? 'rq-btn--active' : ''}`} onClick={() => setWindowDays(w)}>
                {w}d
              </button>
            ))}
          </div>
        </div>

        <p style={{ fontSize: 14, marginTop: 12, lineHeight: 1.5 }}>
          ❓ <strong>{selected.question}</strong>
        </p>

        {error && <div className="error">{error}</div>}
        {loading && <div className="subtle" style={{ fontSize: 12 }}>Computing…</div>}

        {!loading && result && (
          <>
            <p className="subtle" style={{ fontSize: 11, marginTop: 4 }}>
              {result.total_player_days_classified.toLocaleString()} player-days classified · {result.unclassified.toLocaleString()} skipped (missing game data)
            </p>

            {result.buckets.length === 0 ? (
              <p className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
                No data in this segment yet. {result.unclassified === 0 ? 'Capture more days first.' : `${result.unclassified} player-days couldn't be classified.`}
              </p>
            ) : (
              <div className="rq-bucket-stack" style={{ marginTop: 10 }}>
                {result.buckets.map((b) => {
                  const winnerVer = winners.get(b.label);
                  return (
                    <div key={b.label} className="rq-bucket">
                      <div className="rq-bucket-head">
                        <strong>{b.label}</strong>
                        {winnerVer != null && (
                          <span className="rq-winner">
                            🥇 <Link to={`/learning/model/${winnerVer}`} style={{ color: '#c084fc', textDecoration: 'none' }}>
                              v{winnerVer}
                            </Link> in this bucket
                          </span>
                        )}
                      </div>
                      <div className="rq-table-wrap">
                        <table className="rq-table">
                          <thead>
                            <tr>
                              <th>Version</th>
                              <th className="num">Player-days</th>
                              <th className="num">HRs</th>
                              <th className="num">Top 10</th>
                              <th className="num">Coverage</th>
                              <th className="num">Recall</th>
                              <th className="num">Precision</th>
                              <th className="num">F1</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.per_version.map((v) => {
                              const isWinner = winnerVer === v.version;
                              const sampleTooSmall = v.total_player_days < 20;
                              return (
                                <tr key={v.version} className={isWinner ? 'rq-row-winner' : ''}>
                                  <td>
                                    {isWinner && '🥇 '}
                                    <Link to={`/learning/model/${v.version}`} style={{ color: '#cfe', textDecoration: 'none' }}>
                                      v{v.version} {v.name}
                                    </Link>
                                  </td>
                                  <td className="num">{v.total_player_days}</td>
                                  <td className="num">{v.total_hrs_in_bucket}</td>
                                  <td className="num">{v.hrs_in_top10}</td>
                                  <td className={`num ${v.top10_coverage >= 0.2 ? 'rq-pos' : v.top10_coverage >= 0.1 ? '' : 'rq-neg'}`}>
                                    {v.total_hrs_in_bucket > 0 ? `${(v.top10_coverage * 100).toFixed(0)}%` : '—'}
                                  </td>
                                  <td className="num">
                                    {sampleTooSmall ? <span className="rq-small">low n</span> : `${(v.recall * 100).toFixed(1)}%`}
                                  </td>
                                  <td className="num">
                                    {sampleTooSmall ? '—' : `${(v.precision * 100).toFixed(1)}%`}
                                  </td>
                                  <td className="num">
                                    {sampleTooSmall ? '—' : `${(v.f1 * 100).toFixed(1)}%`}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="subtle" style={{ fontSize: 10.5, marginTop: 12, lineHeight: 1.5 }}>
              <strong>Note:</strong> {result.note} Versions with fewer than 20 player-days in a bucket are flagged "low n"
              and excluded from winner ranking — that sample size is too thin to make a confident call.
            </p>
          </>
        )}
      </div>

      <ResearchStyles />
    </>
  );
}

function ResearchStyles() {
  return (
    <style>{`
      .rq-panel {
        background: var(--panel, #11141c); border: 1px solid var(--border, #232732);
        border-radius: 10px; padding: 12px 14px;
      }
      .rq-controls { display: grid; gap: 6px; }
      .rq-btn-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .rq-btn {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        color: #cfe; padding: 4px 10px; border-radius: 6px; font-size: 11.5px; cursor: pointer;
      }
      .rq-btn--active { background: #2d3a52; border-color: #4a6fa5; color: #fff; font-weight: 700; }

      .rq-bucket-stack { display: grid; gap: 10px; }
      .rq-bucket {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        border-radius: 8px; padding: 8px 12px;
      }
      .rq-bucket-head {
        display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
        margin-bottom: 4px; font-size: 13px;
      }
      .rq-winner { font-size: 11px; opacity: 0.85; }
      .rq-table-wrap { overflow-x: auto; }
      .rq-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .rq-table th, .rq-table td { text-align: left; padding: 4px 7px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .rq-table th.num, .rq-table td.num { text-align: right; }
      .rq-row-winner td { background: rgba(192,132,252,0.07); }
      .rq-pos { color: #6bd482; }
      .rq-neg { color: #e07a7a; }
      .rq-small {
        display: inline-block; padding: 0 5px; border-radius: 999px;
        background: rgba(170,177,192,0.15); color: #aab1c0; font-size: 9.5px;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
    `}</style>
  );
}
