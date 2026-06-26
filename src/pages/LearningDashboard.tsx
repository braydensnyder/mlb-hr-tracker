/**
 * /learning — Learning Dashboard
 *
 * Shows what days have been captured by the learning engine
 * (npm run learning:capture -- <date>). Useful for verifying captures
 * actually wrote to Supabase + spotting gaps in the timeline.
 *
 * Sections:
 *   1. Header KPIs: captures total, days covered, latest capture, active model
 *   2. Model Versions registry
 *   3. Captures table: date | model | players | HR hitters | TP/FP/FN/TN | last captured
 *   4. Backfill helper: lists missing dates in the recent window with the
 *      exact npm command to capture them
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchModelVersions,
  fetchLearningCaptureSummary,
  fetchModelComparison,
  type ModelVersionRow,
  type LearningCaptureDay,
  type ModelComparisonRow,
} from '../lib/supabase';
import { mlbToday } from '../lib/mlbDate';
import { addDays } from '../lib/stats';

const todayISO = mlbToday;

export default function LearningDashboard() {
  const [versions, setVersions] = useState<ModelVersionRow[]>([]);
  const [captures, setCaptures] = useState<LearningCaptureDay[]>([]);
  const [comparison, setComparison] = useState<ModelComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<7 | 14 | 30 | 60>(30);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const anchor = addDays(todayISO(), -1);
        const from = addDays(anchor, -(windowDays - 1));
        const [vs, caps, comp] = await Promise.all([
          fetchModelVersions(),
          fetchLearningCaptureSummary({ from, to: anchor }),
          fetchModelComparison({ from, to: anchor }),
        ]);
        if (cancelled) return;
        setVersions(vs);
        setCaptures(caps);
        setComparison(comp);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [windowDays]);

  const migrationApplied = versions.length > 0;
  const activeVersion = versions.find((v) => v.active) ?? versions[0] ?? null;
  const latestCapture = captures[0] ?? null;
  const earliestCapture = captures[captures.length - 1] ?? null;
  const totalPlayerDays = useMemo(() => captures.reduce((s, c) => s + c.player_count, 0), [captures]);
  const totalHrs = useMemo(() => captures.reduce((s, c) => s + c.hr_hitter_count, 0), [captures]);
  const totalTp = useMemo(() => captures.reduce((s, c) => s + c.tp, 0), [captures]);
  const totalFp = useMemo(() => captures.reduce((s, c) => s + c.fp, 0), [captures]);
  const totalFn = useMemo(() => captures.reduce((s, c) => s + c.fn, 0), [captures]);
  const totalTn = useMemo(() => captures.reduce((s, c) => s + c.tn, 0), [captures]);

  // Missing dates in the recent window — useful as a backfill checklist.
  const missingDates = useMemo(() => {
    if (captures.length === 0) return [];
    const anchor = addDays(todayISO(), -1);
    const from = addDays(anchor, -(windowDays - 1));
    const capturedSet = new Set(captures.map((c) => c.date));
    const out: string[] = [];
    let d = anchor;
    while (d >= from) {
      if (!capturedSet.has(d)) out.push(d);
      d = addDays(d, -1);
    }
    return out;
  }, [captures, windowDays]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>🧠 Learning Dashboard</h1>
        <span className="subtle" style={{ fontSize: 13 }}>
          captured days, model versions, and timeline coverage
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Window:</span>
        {([7, 14, 30, 60] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindowDays(w)}
            aria-pressed={windowDays === w}
            style={{
              background: windowDays === w ? '#2d3a52' : 'var(--panel-2)',
              border: `1px solid ${windowDays === w ? '#4a6fa5' : 'var(--border)'}`,
              color: windowDays === w ? '#fff' : '#cfe',
              padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            }}
          >{w}d</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          <Link to="/lab" style={{ fontSize: 13 }}>Open Parlay Lab →</Link>
        </div>
      </div>

      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading…</div>}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!loading && !migrationApplied && <MigrationNotApplied />}

      {!loading && migrationApplied && (
        <>
          {/* Top KPI strip */}
          <div className="ld-kpis">
            <KpiTile label="Captures" value={captures.length.toString()} sub={`${windowDays}d window`} color="#c084fc" />
            <KpiTile
              label="Latest capture"
              value={latestCapture ? latestCapture.date : '—'}
              sub={latestCapture?.last_captured_at ? `at ${formatTs(latestCapture.last_captured_at)}` : 'no captures yet'}
              color="#4cd97a"
            />
            <KpiTile
              label="Earliest in window"
              value={earliestCapture ? earliestCapture.date : '—'}
              sub={earliestCapture ? `${captures.length} day${captures.length === 1 ? '' : 's'} covered` : 'no captures yet'}
              color="#ffd28c"
            />
            <KpiTile
              label="Active model"
              value={activeVersion ? `v${activeVersion.version}` : '—'}
              sub={activeVersion?.name ?? '—'}
              color="#4cc7ff"
            />
            <KpiTile label="Player-days captured" value={totalPlayerDays.toLocaleString()} sub="across all dates" color="#aab1c0" />
            <KpiTile label="HR hitters captured" value={totalHrs.toLocaleString()} sub="distinct per-day" color="#aab1c0" />
          </div>

          {/* Classification summary */}
          {captures.length > 0 && (
            <div className="ld-panel" style={{ marginTop: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Classification (window total)</h3>
              <div className="ld-class-strip">
                <ClassPill label="TP" value={totalTp} color="#6bd482" />
                <ClassPill label="FP" value={totalFp} color="#ffb86c" />
                <ClassPill label="FN" value={totalFn} color="#e07a7a" />
                <ClassPill label="TN" value={totalTn} color="#aab1c0" />
                <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.65 }}>
                  Predicted-positive cutoff = rank ≤ 50
                </span>
              </div>
            </div>
          )}

          {/* Model versions */}
          <div className="ld-panel" style={{ marginTop: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>🧬 Model Versions</h3>
            <div className="ld-table-wrap" style={{ marginTop: 6 }}>
              <table className="ld-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Name</th>
                    <th>Created</th>
                    <th>Last eval</th>
                    <th className="num">Per-leg</th>
                    <th className="num">Pool cov</th>
                    <th className="num">Top 10 cov</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version}>
                      <td><strong>v{v.version}</strong></td>
                      <td>{v.name}</td>
                      <td>{v.created_at.slice(0, 10)}</td>
                      <td>{v.last_evaluated_for ?? '—'}</td>
                      <td className="num">{v.per_leg_hit_rate != null ? pct(v.per_leg_hit_rate) : '—'}</td>
                      <td className="num">{v.pool_coverage_rate != null ? pct(v.pool_coverage_rate) : '—'}</td>
                      <td className="num">{v.top10_coverage_rate != null ? pct(v.top10_coverage_rate) : '—'}</td>
                      <td>{v.active && <span className="ld-active">active</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Multi-model comparison */}
          <ModelComparisonPanel comparison={comparison} windowDays={windowDays} />

          {/* Captures table */}
          <div className="ld-panel" style={{ marginTop: 12 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>📅 Captures ({captures.length})</h3>
            {captures.length === 0 ? (
              <NoCapturesYet />
            ) : (
              <div className="ld-table-wrap" style={{ marginTop: 6 }}>
                <table className="ld-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Model</th>
                      <th className="num">Players</th>
                      <th className="num">HR hitters</th>
                      <th className="num">TP</th>
                      <th className="num">FP</th>
                      <th className="num">FN</th>
                      <th className="num">TN</th>
                      <th>Last captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {captures.map((c) => (
                      <tr key={`${c.date}-${c.model_version}`}>
                        <td><strong>{c.date}</strong></td>
                        <td>v{c.model_version}</td>
                        <td className="num">{c.player_count}</td>
                        <td className="num">{c.hr_hitter_count}</td>
                        <td className="num ld-pos">{c.tp}</td>
                        <td className="num ld-warn">{c.fp}</td>
                        <td className="num ld-neg">{c.fn}</td>
                        <td className="num" style={{ opacity: 0.7 }}>{c.tn}</td>
                        <td className="subtle" style={{ fontSize: 11 }}>{c.last_captured_at ? formatTs(c.last_captured_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Backfill helper */}
          {missingDates.length > 0 && (
            <div className="ld-panel" style={{ marginTop: 12, borderLeft: '3px solid #ffd28c' }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>🗓 Missing in window ({missingDates.length})</h3>
              <p className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
                Days inside the {windowDays}-day window with no captures. Backfill the whole range in
                one command (continues past errors, skips already-captured dates):
              </p>
              <pre className="ld-code">
{`npm run learning:capture-range -- --from ${missingDates[missingDates.length - 1]} --to ${missingDates[0]} --skip-existing`}
              </pre>
              <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
                Or, one date at a time:
              </p>
              <pre className="ld-code">
                {missingDates
                  .slice(0, 10)
                  .map((d) => `npm run learning:capture -- ${d}`)
                  .join('\n')}
                {missingDates.length > 10 ? `\n# … and ${missingDates.length - 10} more` : ''}
              </pre>
              <p className="subtle" style={{ fontSize: 10.5, marginTop: 6 }}>
                Each capture takes ~2-5s. Watch the script output — if you see "✅ SUCCESS" the row count
                is verified post-write. The range script prints a final aggregate summary so you can spot any
                failed dates without scrolling.
              </p>
            </div>
          )}
        </>
      )}

      <p className="subtle" style={{ fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
        This dashboard is read-only — captures happen via{' '}
        <code>npm run learning:capture -- &lt;date&gt;</code>. The data this page shows comes from{' '}
        <code>learning_predictions</code> and <code>model_versions</code>. If something looks wrong, the
        script's output is the source of truth.
      </p>

      <DashStyles />
    </>
  );
}

// =============================================================================
//  Model Comparison Panel — performance per model_version over the window
// =============================================================================
function ModelComparisonPanel({ comparison, windowDays }: { comparison: ModelComparisonRow[]; windowDays: number }) {
  // Rank by full hit rate, tiebreaker 2/3, then per-leg.
  const ranked = useMemo(() => {
    return comparison
      .slice()
      .sort((a, b) => {
        if (b.parlay_full_hit_rate !== a.parlay_full_hit_rate) return b.parlay_full_hit_rate - a.parlay_full_hit_rate;
        if (b.parlay_2of3_hit_rate !== a.parlay_2of3_hit_rate) return b.parlay_2of3_hit_rate - a.parlay_2of3_hit_rate;
        if (b.avg_legs_hit_per_parlay !== a.avg_legs_hit_per_parlay) return b.avg_legs_hit_per_parlay - a.avg_legs_hit_per_parlay;
        return b.top10_coverage - a.top10_coverage;
      });
  }, [comparison]);

  const winner = ranked.find((r) => r.days_tested > 0) ?? null;
  if (comparison.length === 0) return null;

  return (
    <div className="ld-panel" style={{ marginTop: 12, borderLeft: '3px solid #c084fc' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>🥇 Model Comparison — {windowDays}d</h3>
        {winner && (
          <span style={{ fontSize: 11, opacity: 0.85 }}>
            Best: <strong style={{ color: '#c084fc' }}>v{winner.version} {winner.name}</strong>
            {' '}({(winner.parlay_full_hit_rate * 100).toFixed(1)}% 3/3, {(winner.parlay_2of3_hit_rate * 100).toFixed(1)}% 2/3)
          </span>
        )}
      </div>
      <p className="subtle" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
        Each version replayed against the same saved snapshots over the {windowDays}-day window. Ranked by Full 3/3
        hit rate (tiebreaker: 2/3, then avg legs hit, then Top-10 coverage). Run{' '}
        <code>npm run learning:replay-models</code> to populate v2-v6.
      </p>

      <div className="ld-table-wrap" style={{ marginTop: 6 }}>
        <table className="ld-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Version</th>
              <th className="num">Days</th>
              <th className="num">HRs</th>
              <th className="num">Top 3</th>
              <th className="num">Top 10</th>
              <th className="num">3/3</th>
              <th className="num">2/3</th>
              <th className="num">Avg legs</th>
              <th className="num">Missed HR</th>
              <th>Best day</th>
              <th>Worst day</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.version}>
                <td>
                  {i === 0 && r.days_tested > 0 && <span style={{ color: '#c084fc', fontWeight: 700 }}>🥇</span>}
                  {i === 1 && r.days_tested > 0 && <span>🥈</span>}
                  {i === 2 && r.days_tested > 0 && <span>🥉</span>}
                </td>
                <td>
                  <strong>v{r.version}</strong> {r.name}
                  {r.is_active && <span className="ld-active" style={{ marginLeft: 6 }}>active</span>}
                </td>
                <td className="num">{r.days_tested}</td>
                <td className="num">{r.total_hr_hitters}</td>
                <td className="num">
                  {r.total_hr_hitters > 0 ? `${r.hr_in_top3}/${r.total_hr_hitters} (${(r.top3_coverage * 100).toFixed(0)}%)` : '—'}
                </td>
                <td className="num">
                  {r.total_hr_hitters > 0 ? `${r.hr_in_top10}/${r.total_hr_hitters} (${(r.top10_coverage * 100).toFixed(0)}%)` : '—'}
                </td>
                <td className={`num ${r.parlay_full_hit_rate >= 0.10 ? 'ld-pos' : r.parlay_full_hit_rate >= 0.05 ? 'ld-warn' : 'ld-neg'}`}>
                  {r.days_tested > 0 ? `${(r.parlay_full_hit_rate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="num">
                  {r.days_tested > 0 ? `${(r.parlay_2of3_hit_rate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="num">
                  {r.days_tested > 0 ? r.avg_legs_hit_per_parlay.toFixed(2) : '—'}
                </td>
                <td className={`num ${r.missed_hr_count > 0 ? 'ld-neg' : ''}`}>{r.missed_hr_count}</td>
                <td className="subtle" style={{ fontSize: 11 }}>
                  {r.best_day ? `${r.best_day.date} (${r.best_day.full_parlays_hit}× 3/3, ${r.best_day.legs_hit} legs)` : '—'}
                </td>
                <td className="subtle" style={{ fontSize: 11 }}>
                  {r.worst_day ? `${r.worst_day.date} (${r.worst_day.legs_hit} legs hit, ${r.worst_day.hr_hitters} HRs)` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="subtle" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>
        <strong>Honest scope:</strong> v2–v6 use signal-based replay — they apply per-chip additive bonuses
        to v1's saved heat scores, then re-rank. They do <em>not</em> re-run the full scoring pipeline from
        raw inputs (that would need a schema change to save subscores per snapshot). v6 in particular is
        a degraded proxy — we don't have team-implied-runs in snapshots yet. Treat these as sensitivity tests, not pure backtests.
      </p>
    </div>
  );
}

function MigrationNotApplied() {
  return (
    <div className="ld-panel" style={{ marginBottom: 12, borderLeft: '3px solid #ffb86c' }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>⚠ Migration 013 not applied</h3>
      <p className="subtle" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
        The learning engine tables don't exist yet. Apply the migration in your Supabase SQL editor:
      </p>
      <pre className="ld-code">supabase/migrations/013_learning_engine.sql</pre>
      <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
        That creates <code>model_versions</code>, <code>learning_predictions</code>, and{' '}
        <code>feature_importance</code>, plus seeds v1 with the current live weights.
      </p>
    </div>
  );
}

function NoCapturesYet() {
  return (
    <div style={{ padding: '12px 0' }}>
      <p className="subtle" style={{ fontSize: 12, lineHeight: 1.5 }}>
        Migration 013 is applied but no captures exist yet. Run:
      </p>
      <pre className="ld-code">npm run learning:capture -- yesterday</pre>
      <p className="subtle" style={{ fontSize: 11, marginTop: 6 }}>
        Then refresh this page. The capture script logs every step end-to-end — if it exits with no
        output, you're on the old script and need to pull the latest.
      </p>
    </div>
  );
}

// --- small components ---

function KpiTile({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="ld-kpi" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="ld-kpi-label">{label}</div>
      <div className="ld-kpi-value" style={{ color }}>{value}</div>
      <div className="ld-kpi-sub">{sub}</div>
    </div>
  );
}

function ClassPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="ld-class-pill" style={{ borderColor: color }}>
      <span style={{ color, fontWeight: 700, fontSize: 11, letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: 16, fontWeight: 700, marginLeft: 8 }}>{value.toLocaleString()}</span>
    </div>
  );
}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function DashStyles() {
  return (
    <style>{`
      .ld-kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 8px;
      }
      .ld-kpi {
        background: var(--panel-2, #14171f);
        border: 1px solid var(--border, #232732);
        border-radius: 8px;
        padding: 8px 12px;
      }
      .ld-kpi-label { font-size: 10.5px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
      .ld-kpi-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
      .ld-kpi-sub   { font-size: 10.5px; opacity: 0.65; margin-top: 1px; }

      .ld-panel {
        background: var(--panel, #11141c);
        border: 1px solid var(--border, #232732);
        border-radius: 10px;
        padding: 10px 14px;
      }
      .ld-table-wrap { overflow-x: auto; }
      .ld-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .ld-table th, .ld-table td {
        text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330);
        white-space: nowrap;
      }
      .ld-table th.num, .ld-table td.num { text-align: right; }
      .ld-table tbody tr:hover { background: rgba(255,255,255,0.02); }
      .ld-pos  { color: #6bd482; font-weight: 600; }
      .ld-warn { color: #ffd28c; font-weight: 600; }
      .ld-neg  { color: #e07a7a; font-weight: 600; }
      .ld-active {
        display: inline-block; padding: 1px 8px; border-radius: 999px;
        background: rgba(192,132,252,0.18); color: #c084fc;
        font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      }

      .ld-class-strip {
        display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap;
      }
      .ld-class-pill {
        display: inline-flex; align-items: baseline;
        padding: 4px 10px; border-radius: 999px;
        background: rgba(255,255,255,0.04); border: 1px solid;
      }

      .ld-code {
        background: #0c0e14; border: 1px solid #1f2330; border-radius: 6px;
        padding: 8px 12px; font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        margin: 6px 0 0; overflow-x: auto; line-height: 1.5;
      }
    `}</style>
  );
}
