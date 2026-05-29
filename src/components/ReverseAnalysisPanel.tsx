/**
 * ReverseAnalysisPanel — task #179
 *
 * A collapsible "Reverse Engineering" panel on the HR Targets page. Looks
 * back at the last 14 days of saved snapshots + actual HR results and
 * shows:
 *
 *   1. Per-signal hit rate (present vs absent), lift, sample size.
 *   2. Most predictive positive and negative signals.
 *   3. Pair + selected triple combinations that outperform individuals.
 *   4. "Top 10 Optimizer" — directional + grid-searched weight nudges.
 *
 * Recommendations are SURFACED ONLY. The panel never mutates
 * HEAT_SCORE_WEIGHTS or any other scoring knob. The user reviews the
 * recommendation and applies changes manually in src/lib/stats.ts.
 */
import { useMemo, useState } from 'react';
import type {
  ReverseAnalysisResult,
  RevSignalRow,
  RevComboRow,
  RevDirectional,
} from '../lib/stats';

interface Props {
  /** When null, panel renders empty state. */
  analysis: ReverseAnalysisResult | null;
  /** Loading indicator from the page. */
  loading: boolean;
  /** Render the toggle as expanded? Owned by parent so close-state survives. */
  open: boolean;
  onToggle: () => void;
  /** Window end (the "as of" date) and computed window length. */
  asOf: string;
  windowDays: number;
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}
function liftClass(lift: number): string {
  if (lift >= 1.5) return 'rev-cell--strong-good';
  if (lift >= 1.15) return 'rev-cell--good';
  if (lift <= 0.66) return 'rev-cell--strong-bad';
  if (lift <= 0.85) return 'rev-cell--bad';
  return '';
}
function confChipClass(c: 'high' | 'medium' | 'low'): string {
  return `rev-confchip rev-confchip--${c}`;
}

export default function ReverseAnalysisPanel(p: Props) {
  return (
    <section
      style={{
        marginTop: 24,
        background: '#0f1117',
        border: '1px solid #2a2d36',
        borderRadius: 10,
        padding: 14,
      }}
    >
      <Header
        open={p.open}
        onToggle={p.onToggle}
        loading={p.loading}
        analysis={p.analysis}
        asOf={p.asOf}
        windowDays={p.windowDays}
      />
      {p.open && (
        <>
          {p.loading && (
            <p style={{ opacity: 0.7, fontSize: 14 }}>
              Crunching {p.windowDays} days of snapshots + HR results…
            </p>
          )}
          {!p.loading && !p.analysis && (
            <p style={{ opacity: 0.7, fontSize: 14 }}>
              No data yet — open this once a snapshot + HR window exists.
            </p>
          )}
          {!p.loading && p.analysis && <Body analysis={p.analysis} />}
        </>
      )}
      <Styles />
    </section>
  );
}

function Header({ open, onToggle, loading, analysis, asOf, windowDays }: {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  analysis: ReverseAnalysisResult | null;
  asOf: string;
  windowDays: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 17 }}>
          🔬 Reverse-Engineering Analysis
          <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
            ({windowDays}d window through {asOf})
          </span>
        </h3>
        {open && analysis && (
          <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.7 }}>
            {analysis.total_player_days.toLocaleString()} player-days · {analysis.total_hr_player_days.toLocaleString()} HRs · baseline {pct(analysis.baseline_rate, 2)}.
            Recommendations are surfaced — nothing is auto-applied.
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: open ? '#243' : '#1a1d24',
          color: '#cfe',
          border: '1px solid #2a4',
          padding: '6px 12px',
          borderRadius: 6,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        {open ? 'Hide' : loading ? 'Loading…' : 'Run analysis'}
      </button>
    </div>
  );
}

function Body({ analysis }: { analysis: ReverseAnalysisResult }) {
  return (
    <div style={{ display: 'grid', gap: 18, marginTop: 12 }}>
      <SignalTable rows={analysis.signals} baselineRate={analysis.baseline_rate} />
      <TopPredictors result={analysis} />
      <ComboTable
        title="Pair Combinations"
        rows={analysis.pair_combos}
        sub="Hand-picked + auto-generated from top positive signals. Requires ≥10 player-days of co-occurrence."
      />
      <ComboTable
        title="Triple Combinations"
        rows={analysis.triple_combos}
        sub="A few hand-picked 3-signal stacks. Sample size shrinks fast — treat as directional."
      />
      <Top10Optimizer result={analysis} />
      <FinePrint />
    </div>
  );
}

function SignalTable({ rows, baselineRate }: { rows: RevSignalRow[]; baselineRate: number }) {
  // Sort by lift descending so the most predictive surface at the top.
  const sorted = useMemo(() => rows.slice().sort((a, b) => b.lift - a.lift), [rows]);
  return (
    <div>
      <h4 className="rev-h4">Per-Signal Hit Rate</h4>
      <p className="rev-sub">
        Baseline HR rate over the window: <strong>{pct(baselineRate, 2)}</strong>.
        Lift &gt; 1 = signal predicts HRs better than baseline. Lift &lt; 1 = signal predicts misses.
      </p>
      <div className="rev-table-wrap">
        <table className="rev-table">
          <thead>
            <tr>
              <th>Signal</th>
              <th className="num">N w/ signal</th>
              <th className="num">Hit % w/ signal</th>
              <th className="num">Hit % w/o</th>
              <th className="num">Δ</th>
              <th className="num">Lift</th>
              <th>Sample</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.key}>
                <td>
                  <span className={`rev-pol rev-pol--${s.polarity}`}>{s.label}</span>
                </td>
                <td className="num">{s.present_n.toLocaleString()}</td>
                <td className={`num ${liftClass(s.lift)}`}>{pct(s.present_rate)}</td>
                <td className="num">{pct(s.absent_rate)}</td>
                <td className={`num ${s.delta > 0 ? 'rev-pos' : s.delta < 0 ? 'rev-neg' : ''}`}>
                  {s.delta >= 0 ? '+' : ''}{pct(s.delta)}
                </td>
                <td className={`num ${liftClass(s.lift)}`}>
                  {s.lift.toFixed(2)}×
                </td>
                <td>
                  <span className={confChipClass(s.sample_quality)}>{s.sample_quality}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TopPredictors({ result }: { result: ReverseAnalysisResult }) {
  return (
    <div className="rev-grid2">
      <PredictorCard
        title="Most Predictive POSITIVE"
        rows={result.top_positive}
        empty="No positive signals reached the 20-sample threshold."
      />
      <PredictorCard
        title="Most Predictive NEGATIVE"
        rows={result.top_negative}
        empty="No negative signals reached the 20-sample threshold."
      />
    </div>
  );
}

function PredictorCard({ title, rows, empty }: { title: string; rows: RevSignalRow[]; empty: string }) {
  return (
    <div className="rev-card">
      <h4 className="rev-h4">{title}</h4>
      {rows.length === 0 && <p className="rev-sub" style={{ marginTop: 6 }}>{empty}</p>}
      {rows.length > 0 && (
        <ol className="rev-rank">
          {rows.map((s) => (
            <li key={s.key}>
              <strong>{s.label}</strong>
              <span className={`rev-lift ${liftClass(s.lift)}`}>{s.lift.toFixed(2)}×</span>
              <span className="rev-sub-line">
                {pct(s.present_rate)} hit · n={s.present_n}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ComboTable({ title, rows, sub }: { title: string; rows: RevComboRow[]; sub: string }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="rev-h4">{title}</h4>
      <p className="rev-sub">{sub}</p>
      <div className="rev-table-wrap">
        <table className="rev-table">
          <thead>
            <tr>
              <th>Signals</th>
              <th className="num">N</th>
              <th className="num">Hits</th>
              <th className="num">Hit %</th>
              <th className="num">Lift</th>
              <th className="num">Best individual</th>
              <th>Stacks?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const best = c.individual_lifts.length > 0 ? Math.max(...c.individual_lifts) : 0;
              return (
                <tr key={i}>
                  <td>{c.labels.join(' + ')}</td>
                  <td className="num">{c.present_n}</td>
                  <td className="num">{c.present_hits}</td>
                  <td className={`num ${liftClass(c.lift)}`}>{pct(c.present_rate)}</td>
                  <td className={`num ${liftClass(c.lift)}`}>{c.lift.toFixed(2)}×</td>
                  <td className="num">{best.toFixed(2)}×</td>
                  <td>
                    {c.outperforms_individual ? (
                      <span className="rev-confchip rev-confchip--high">Outperforms</span>
                    ) : (
                      <span className="rev-confchip rev-confchip--low">No stack</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Top10Optimizer({ result }: { result: ReverseAnalysisResult }) {
  return (
    <div>
      <h4 className="rev-h4">Top 10 Optimizer — Weight Recommendations</h4>
      <p className="rev-sub">
        If the Top 10 had been built using only the last {result.window_days} days of results,
        these are the directional weight nudges the data suggests. <strong>Surfaced only — apply manually if desired.</strong>
      </p>

      <div className="rev-grid2">
        <DirectionalCard rows={result.directional} />
        <GridCard result={result} />
      </div>
    </div>
  );
}

function DirectionalCard({ rows }: { rows: RevDirectional[] }) {
  return (
    <div className="rev-card">
      <h5 className="rev-h5">Directional (per-knob)</h5>
      <p className="rev-sub" style={{ marginBottom: 8 }}>
        Drives each knob by the lift of its associated signal. Honest about
        small-sample uncertainty via confidence.
      </p>
      <div className="rev-table-wrap">
        <table className="rev-table">
          <thead>
            <tr>
              <th>Knob</th>
              <th>Driver</th>
              <th className="num">Current</th>
              <th className="num">Suggested</th>
              <th>Change</th>
              <th>Conf</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.knob}>
                <td><code>{r.knob}</code></td>
                <td>{r.driver_signal}</td>
                <td className="num">{r.current_value}</td>
                <td className="num"><strong>{r.suggested_value}</strong></td>
                <td>
                  {r.direction === 'hold' ? (
                    <span className="rev-confchip rev-confchip--low">hold</span>
                  ) : (
                    <span className={`rev-confchip rev-confchip--${r.direction === 'increase' ? 'high' : 'medium'}`}>
                      {r.direction} {r.magnitude_pct}%
                    </span>
                  )}
                </td>
                <td><span className={confChipClass(r.confidence)}>{r.confidence}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GridCard({ result }: { result: ReverseAnalysisResult }) {
  const g = result.grid;
  const lift = g.estimated_lift;
  return (
    <div className="rev-card">
      <h5 className="rev-h5">Grid-Searched (Top-10 hit rate)</h5>
      <p className="rev-sub" style={{ marginBottom: 8 }}>
        Tries Δ ∈ &#123;0, 2, 4&#125; on each of four major knobs (3⁴=81 combinations)
        and picks the perturbation that maximizes Top-10 hit rate over the window.
      </p>
      <div className="rev-kpis">
        <div className="rev-kpi">
          <div className="rev-kpi-label">Baseline Top-10</div>
          <div className="rev-kpi-value">{pct(g.baseline_top10_hit_rate)}</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Best Top-10</div>
          <div className="rev-kpi-value">{pct(g.best_top10_hit_rate)}</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Estimated lift</div>
          <div className={`rev-kpi-value ${lift > 0 ? 'rev-pos' : ''}`}>
            {lift > 0 ? '+' : ''}{pct(lift)}
          </div>
        </div>
      </div>
      {g.changes.length === 0 ? (
        <p className="rev-sub" style={{ marginTop: 10 }}>{g.note}</p>
      ) : (
        <>
          <div className="rev-table-wrap" style={{ marginTop: 10 }}>
            <table className="rev-table">
              <thead>
                <tr>
                  <th>Knob</th>
                  <th>Driver</th>
                  <th className="num">Δ</th>
                </tr>
              </thead>
              <tbody>
                {g.changes.map((c, i) => (
                  <tr key={i}>
                    <td><code>{c.knob}</code></td>
                    <td>{c.signal}</td>
                    <td className={`num ${c.delta >= 0 ? 'rev-pos' : 'rev-neg'}`}>
                      {c.delta >= 0 ? '+' : ''}{c.delta}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rev-sub" style={{ marginTop: 8, fontSize: 11 }}>{g.note}</p>
        </>
      )}
    </div>
  );
}

function FinePrint() {
  return (
    <p className="rev-sub" style={{ fontSize: 11, marginTop: 8 }}>
      <strong>Read carefully.</strong> Signals are detected from the saved
      snapshot.reason text — the same chip labels you saw at game time. The grid
      optimizer adds Δ_signal directly to each player's saved Heat Score and
      re-ranks; it's a sensitivity approximation, not a replay of the full
      scoring pipeline (saturation, ceiling compression, completeness
      multiplier are NOT re-applied). Use this for direction + magnitude;
      apply weight changes by hand in <code>src/lib/stats.ts</code>.
    </p>
  );
}

function Styles() {
  return (
    <style>{`
      .rev-h4 { margin: 0 0 6px 0; font-size: 15px; color: #d9e0eb; }
      .rev-h5 { margin: 0 0 6px 0; font-size: 13px; color: #cfe; }
      .rev-sub { margin: 0; font-size: 12px; opacity: 0.65; line-height: 1.45; }
      .rev-sub-line { display: block; font-size: 11px; opacity: 0.65; }
      .rev-pos { color: #6bd482; }
      .rev-neg { color: #e07a7a; }
      .rev-grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 720px) {
        .rev-grid2 { grid-template-columns: 1fr; }
      }
      .rev-card {
        background: #14171f;
        border: 1px solid #232732;
        border-radius: 8px;
        padding: 10px 12px;
      }
      .rev-table-wrap { overflow-x: auto; margin-top: 6px; }
      .rev-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .rev-table th, .rev-table td {
        text-align: left; padding: 6px 8px; border-bottom: 1px solid #1f2330;
        white-space: nowrap;
      }
      .rev-table th.num, .rev-table td.num { text-align: right; }
      .rev-table tbody tr:hover { background: #181b24; }
      .rev-table code { font-size: 11px; background: #0c0e14; padding: 1px 4px; border-radius: 3px; }
      .rev-pol--positive { color: #aee8b8; }
      .rev-pol--negative { color: #f3b6b6; }
      .rev-cell--strong-good { color: #6bd482; font-weight: 600; }
      .rev-cell--good { color: #a9d6a3; }
      .rev-cell--bad { color: #e0a87a; }
      .rev-cell--strong-bad { color: #e07a7a; font-weight: 600; }
      .rev-confchip {
        display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10.5px;
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      .rev-confchip--high { background: #1f3e29; color: #b6f0c1; }
      .rev-confchip--medium { background: #3a3623; color: #f0e3a2; }
      .rev-confchip--low { background: #2a2d36; color: #aab1c0; }
      .rev-rank {
        list-style: decimal inside; padding: 0; margin: 6px 0 0;
        font-size: 13px;
      }
      .rev-rank li {
        padding: 4px 0;
        border-bottom: 1px solid #1f2330;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 4px;
      }
      .rev-rank li strong { color: #e2e6ee; }
      .rev-lift { font-weight: 600; font-size: 13px; }
      .rev-kpis {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 6px;
      }
      .rev-kpi {
        background: #0c0e14; border: 1px solid #1f2330; border-radius: 6px;
        padding: 6px 8px; text-align: center;
      }
      .rev-kpi-label { font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.06em; }
      .rev-kpi-value { font-size: 16px; font-weight: 600; color: #cfe; margin-top: 2px; }
    `}</style>
  );
}
