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
  ActionableRule,
  SimulatedTop10Result,
  SimulatedTop10Day,
  ReconstructionResult,
  ReconstructedDay,
  RecurringRule,
} from '../lib/stats';

interface Props {
  /** When null, panel renders empty state. */
  analysis: ReverseAnalysisResult | null;
  /** Actionable rules + simulation. Null while loading or empty window. */
  actionable: ActionableRule[] | null;
  simulation: SimulatedTop10Result | null;
  /** Hindsight reconstruction across the window. */
  reconstruction: ReconstructionResult | null;
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
          {!p.loading && p.analysis && (
            <Body
              analysis={p.analysis}
              actionable={p.actionable ?? []}
              simulation={p.simulation}
              reconstruction={p.reconstruction}
            />
          )}
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

function Body({ analysis, actionable, simulation, reconstruction }: {
  analysis: ReverseAnalysisResult;
  actionable: ActionableRule[];
  simulation: SimulatedTop10Result | null;
  reconstruction: ReconstructionResult | null;
}) {
  return (
    <div style={{ display: 'grid', gap: 18, marginTop: 12 }}>
      {/* Lead with the actionable findings — that's what the user came for. */}
      <ActionableChangesSection rules={actionable} />
      {simulation && <SimulatedTop10Section sim={simulation} />}
      {reconstruction && <BestReconstructedTop10Section recon={reconstruction} />}

      {/* Supporting evidence below — same as the original analysis layer. */}
      <details style={{ borderTop: '1px solid #232732', paddingTop: 12 }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, opacity: 0.8 }}>
          Show full supporting evidence (signal table, predictors, combos, optimizer)
        </summary>
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
        </div>
      </details>
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

// =============================================================================
//  Actionable Model Changes section
// =============================================================================

const STATUS_LABEL: Record<ActionableRule['status'], string> = {
  apply_now: 'Apply now',
  test_candidate: 'Test candidate',
  monitor: 'Monitor',
};
const STATUS_CLASS: Record<ActionableRule['status'], string> = {
  apply_now: 'rev-status--apply',
  test_candidate: 'rev-status--test',
  monitor: 'rev-status--monitor',
};
const RISK_CLASS: Record<ActionableRule['overfitting_risk'], string> = {
  low: 'rev-risk--low',
  medium: 'rev-risk--med',
  high: 'rev-risk--high',
};

function ActionableChangesSection({ rules }: { rules: ActionableRule[] }) {
  // Surface combos first (already sorted by priority in stats.ts), capped at
  // a reasonable number so the page stays scannable. The full set lives in
  // the supporting-evidence drawer below.
  const display = rules.slice(0, 8);

  return (
    <div>
      <h4 className="rev-h4">⚡ Actionable Model Changes</h4>
      <p className="rev-sub">
        Concrete rule + weight test candidates ranked by evidence. Combo rules surface above raw weight tweaks.
        Nothing here is auto-applied — apply by hand in <code>src/lib/stats.ts</code>.
      </p>
      {display.length === 0 ? (
        <p className="rev-sub" style={{ marginTop: 8 }}>
          No qualifying rules in this window. Open the supporting evidence below to inspect signal lifts.
        </p>
      ) : (
        <div className="rev-rule-grid">
          {display.map((r) => <RuleCard key={r.id} rule={r} />)}
        </div>
      )}
    </div>
  );
}

function RuleCard({ rule }: { rule: ActionableRule }) {
  return (
    <div className="rev-rule">
      <div className="rev-rule-head">
        <div className="rev-rule-title">{rule.rule_text}</div>
        <span className={`rev-status ${STATUS_CLASS[rule.status]}`}>{STATUS_LABEL[rule.status]}</span>
      </div>
      <dl className="rev-rule-list">
        <div>
          <dt>Finding</dt>
          <dd>{rule.finding}</dd>
        </div>
        <div>
          <dt>Suggested test</dt>
          <dd>
            <code>{rule.kind === 'combo_bonus'
              ? `Add ${rule.delta >= 0 ? '+' : ''}${rule.delta} combo bonus when ${rule.signals.length === 1 ? '' : 'all '}${rule.signals.join(' + ')} fire`
              : rule.kind === 'penalty_change'
                ? `Adjust ${rule.id.replace('knob:', '')} by ${rule.delta >= 0 ? '+' : ''}${rule.delta.toFixed(1)}`
                : `Adjust ${rule.id.replace('knob:', '')} by ${rule.delta >= 0 ? '+' : ''}${rule.delta.toFixed(1)}`}</code>
          </dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{rule.why}</dd>
        </div>
        <div>
          <dt>Expected impact</dt>
          <dd>{rule.expected_impact || '—'}</dd>
        </div>
        <div>
          <dt>Overfitting risk</dt>
          <dd>
            <span className={`rev-risk ${RISK_CLASS[rule.overfitting_risk]}`}>
              {rule.overfitting_risk}
            </span>
            <span style={{ marginLeft: 8, opacity: 0.6, fontSize: 11 }}>
              {rule.overfitting_risk === 'high' ? '(small sample — easy to fool yourself)'
                : rule.overfitting_risk === 'medium' ? '(moderate sample — directional only)'
                : '(large sample — safer to act on)'}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

// =============================================================================
//  Simulated Top-10 section
// =============================================================================

function SimulatedTop10Section({ sim }: { sim: SimulatedTop10Result }) {
  // Day picker — defaults to the most recent day in the window.
  const [selectedIdx, setSelectedIdx] = useState<number>(sim.days.length - 1);
  const day = sim.days[Math.min(selectedIdx, sim.days.length - 1)];

  return (
    <div>
      <h4 className="rev-h4">🔄 Simulated Top 10 — Actual vs Rules Applied</h4>
      <p className="rev-sub">
        What the Top 10 would have looked like if the candidate rules above had been applied across the {sim.days_counted}-day window.
        Rules with status <strong>Apply now</strong> or <strong>Test candidate</strong> contribute.
        <strong> Monitor</strong> rules are surfaced but excluded from the sim.
      </p>

      <div className="rev-kpis" style={{ marginTop: 6 }}>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Actual hit rate</div>
          <div className="rev-kpi-value">{pct(sim.actual_top10_rate)}</div>
          <div className="rev-kpi-sub">{sim.actual_total_hits} hits / {sim.days_counted}d × 10</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Simulated hit rate</div>
          <div className="rev-kpi-value">{pct(sim.simulated_top10_rate)}</div>
          <div className="rev-kpi-sub">{sim.simulated_total_hits} hits / {sim.days_counted}d × 10</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Delta</div>
          <div className={`rev-kpi-value ${sim.delta > 0 ? 'rev-pos' : sim.delta < 0 ? 'rev-neg' : ''}`}>
            {sim.delta > 0 ? '+' : ''}{pct(sim.delta)}
          </div>
          <div className="rev-kpi-sub">{sim.rules_applied.length} rules applied</div>
        </div>
      </div>

      {day && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, opacity: 0.8 }}>Compare day:</span>
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              style={{
                background: '#0c0e14', color: '#cfe', border: '1px solid #2a2d36',
                borderRadius: 6, padding: '4px 8px', fontSize: 13,
              }}
            >
              {sim.days.map((d, i) => (
                <option key={d.date} value={i}>
                  {d.date} (actual {d.actual_hits} · sim {d.simulated_hits} · {d.delta_hits >= 0 ? '+' : ''}{d.delta_hits})
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              Highlight color: <span className="rev-row--new">new entry</span> ·
              <span className="rev-row--dropped" style={{ marginLeft: 6 }}>dropped from sim</span>
            </span>
          </div>

          <div className="rev-grid2" style={{ marginTop: 10 }}>
            <SimTop10Card title={`Actual Top 10 — ${day.date}`} rows={day.actual} highlightKey="dropped" />
            <SimTop10Card title={`Simulated Top 10 — ${day.date}`} rows={day.simulated} highlightKey="new" />
          </div>
        </>
      )}
      <p className="rev-sub" style={{ marginTop: 8, fontSize: 11 }}>{sim.note}</p>
    </div>
  );
}

function SimTop10Card({ title, rows, highlightKey }: {
  title: string;
  rows: { rank: number; player_id: number; player_name: string; team: string; heat_score: number; modified_score: number; rules_applied: string[]; hit: boolean; in_both: boolean }[];
  highlightKey: 'new' | 'dropped';
}) {
  return (
    <div className="rev-card">
      <h5 className="rev-h5">{title}</h5>
      <div className="rev-table-wrap">
        <table className="rev-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th className="num">Heat</th>
              <th className="num">Mod</th>
              <th>HR?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cls = r.in_both ? '' : highlightKey === 'new' ? 'rev-row--new' : 'rev-row--dropped';
              return (
                <tr key={`${r.rank}-${r.player_id}`} className={cls}>
                  <td>{r.rank}</td>
                  <td>{r.player_name}</td>
                  <td>{r.team}</td>
                  <td className="num">{r.heat_score.toFixed(1)}</td>
                  <td className={`num ${r.modified_score !== r.heat_score ? (r.modified_score > r.heat_score ? 'rev-pos' : 'rev-neg') : ''}`}>
                    {r.modified_score.toFixed(1)}
                    {r.modified_score !== r.heat_score && (
                      <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 4 }}>
                        ({r.modified_score - r.heat_score > 0 ? '+' : ''}{(r.modified_score - r.heat_score).toFixed(1)})
                      </span>
                    )}
                  </td>
                  <td>{r.hit ? '✓' : '·'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
//  Best Reconstructed Top 10 — hindsight optimization section
// =============================================================================

function BestReconstructedTop10Section({ recon }: { recon: ReconstructionResult }) {
  const [selectedIdx, setSelectedIdx] = useState<number>(recon.days.length - 1);
  const day = recon.days[Math.min(selectedIdx, recon.days.length - 1)];

  return (
    <div>
      <h4 className="rev-h4">🎯 Best Reconstructed Top 10 — Hindsight Search</h4>
      <p className="rev-sub">
        Working <em>backwards</em> from actual HR results: for each day, search a small
        rule space (single-signal Δs and combo bonuses) and pick the combination that
        would have placed the most actual HR hitters into the Top 10.
        <strong style={{ color: '#ffb86c' }}> Hindsight only — never a live prediction.</strong>
        {' '}Trust the <strong>Recurring Rules</strong> summary below, not any single day.
      </p>

      <div className="rev-kpis" style={{ marginTop: 6 }}>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Current Top-10 rate</div>
          <div className="rev-kpi-value">{pct(recon.current_top10_rate)}</div>
          <div className="rev-kpi-sub">{recon.total_current_hits} hits / {recon.days_counted}d × 10</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Reconstructed rate</div>
          <div className="rev-kpi-value rev-pos">{pct(recon.reconstructed_top10_rate)}</div>
          <div className="rev-kpi-sub">{recon.total_reconstructed_hits} hits / {recon.days_counted}d × 10</div>
        </div>
        <div className="rev-kpi">
          <div className="rev-kpi-label">Hindsight ceiling</div>
          <div className="rev-kpi-value rev-pos">+{pct(recon.estimated_improvement)}</div>
          <div className="rev-kpi-sub">upper bound, not actionable</div>
        </div>
      </div>

      <RecurringRulesPanel recurring={recon.recurring} totalDays={recon.days_counted} />

      {day && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <h5 className="rev-h5" style={{ margin: 0 }}>Per-day reconstruction</h5>
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              style={{
                background: '#0c0e14', color: '#cfe', border: '1px solid #2a2d36',
                borderRadius: 6, padding: '4px 8px', fontSize: 13,
              }}
            >
              {recon.days.map((d, i) => (
                <option key={d.date} value={i}>
                  {d.date} (current {d.current_hits}/10 → reconstructed {d.reconstructed_hits}/10
                  {d.reconstructed_hits > d.current_hits ? `, +${d.reconstructed_hits - d.current_hits}` : ''})
                </option>
              ))}
            </select>
          </div>

          <ReconstructionDayCard day={day} />
        </>
      )}
      <p className="rev-sub" style={{ marginTop: 8, fontSize: 11 }}>{recon.note}</p>
    </div>
  );
}

function RecurringRulesPanel({ recurring, totalDays }: { recurring: RecurringRule[]; totalDays: number }) {
  // Surface rules selected on at least 2 days — single-day picks are likely overfits.
  const recurringOnly = recurring.filter((r) => r.days_selected >= 2);
  return (
    <div className="rev-card" style={{ marginTop: 12, borderLeft: '3px solid #ffb86c' }}>
      <h5 className="rev-h5">📊 Recurring Rules ({totalDays}-day summary)</h5>
      <p className="rev-sub" style={{ marginBottom: 8 }}>
        Rules selected by the search on multiple days — these are the patterns
        less likely to be one-day overfits and worth investigating manually.
      </p>
      {recurringOnly.length === 0 ? (
        <p className="rev-sub">
          No rule was selected on more than one day. Either the window is too
          small to find recurring patterns, or each day's HR distribution is
          unique enough that no single rule helps across days. Wait for more
          data before drawing conclusions.
        </p>
      ) : (
        <div className="rev-table-wrap">
          <table className="rev-table">
            <thead>
              <tr>
                <th>Rule pattern</th>
                <th className="num">Days</th>
                <th className="num">Avg Δ</th>
                <th className="num">Avg lift</th>
                <th>Signature</th>
              </tr>
            </thead>
            <tbody>
              {recurringOnly.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.text_template}</strong></td>
                  <td className="num">
                    <span className={
                      r.days_selected >= Math.ceil(totalDays * 0.6) ? 'rev-confchip rev-confchip--high'
                      : r.days_selected >= Math.ceil(totalDays * 0.3) ? 'rev-confchip rev-confchip--medium'
                      : 'rev-confchip rev-confchip--low'
                    }>
                      {r.days_selected}/{r.total_days}
                    </span>
                  </td>
                  <td className={`num ${r.avg_delta > 0 ? 'rev-pos' : r.avg_delta < 0 ? 'rev-neg' : ''}`}>
                    {r.avg_delta > 0 ? '+' : ''}{r.avg_delta.toFixed(1)}
                  </td>
                  <td className={`num ${r.avg_lift_pct_pts > 0 ? 'rev-pos' : ''}`}>
                    +{r.avg_lift_pct_pts.toFixed(1)} pp
                  </td>
                  <td>
                    <code style={{ fontSize: 10 }}>{r.kind}</code>
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

function ReconstructionDayCard({ day }: { day: ReconstructedDay }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="rev-grid2">
        {/* Current Top 10 */}
        <ReconTop10Card
          title={`Current Top 10 — ${day.date}`}
          subtitle={`${day.current_hits}/10 hits`}
          rows={day.current_top10}
          highlightKey="dropped"
        />
        {/* Reconstructed Top 10 */}
        <ReconTop10Card
          title={`Reconstructed Top 10 — ${day.date}`}
          subtitle={`${day.reconstructed_hits}/10 hits`}
          rows={day.reconstructed_top10}
          highlightKey="new"
        />
      </div>

      <div className="rev-grid2" style={{ marginTop: 10 }}>
        {/* Rules that produced this reconstruction */}
        <div className="rev-card">
          <h5 className="rev-h5">Rules that produced it</h5>
          {day.rules.length === 0 ? (
            <p className="rev-sub">No rule combination improved Top-10 hits on this day.</p>
          ) : (
            <div className="rev-recon-rules">
              {day.rules.map((r) => (
                <div key={r.id} className="rev-recon-rule">
                  <code>{r.text}</code>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Added / removed lists */}
        <div className="rev-card">
          <h5 className="rev-h5">Diff</h5>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div className="rev-sub" style={{ marginBottom: 4 }}>
                <span className="rev-pos">Added</span> ({day.added.length})
              </div>
              {day.added.length === 0 ? (
                <div className="rev-sub" style={{ fontSize: 11 }}>—</div>
              ) : (
                <ul className="rev-diff-list">
                  {day.added.map((a) => (
                    <li key={a.player_id}>
                      <span style={{ color: a.hit ? '#6bd482' : '#aab1c0' }}>
                        {a.hit ? '✓ ' : '· '}{a.player_name}
                      </span>
                      <span className="rev-sub" style={{ fontSize: 10 }}> #{a.new_rank} · {a.team}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="rev-sub" style={{ marginBottom: 4 }}>
                <span className="rev-neg">Removed</span> ({day.removed.length})
              </div>
              {day.removed.length === 0 ? (
                <div className="rev-sub" style={{ fontSize: 11 }}>—</div>
              ) : (
                <ul className="rev-diff-list">
                  {day.removed.map((r) => (
                    <li key={r.player_id}>
                      <span style={{ color: r.hit ? '#6bd482' : '#aab1c0' }}>
                        {r.hit ? '✓ ' : '· '}{r.player_name}
                      </span>
                      <span className="rev-sub" style={{ fontSize: 10 }}> #{r.old_rank} · {r.team}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReconTop10Card({ title, subtitle, rows, highlightKey }: {
  title: string;
  subtitle: string;
  rows: { rank: number; player_id: number; player_name: string; team: string; heat_score: number; modified_score: number; rules_applied: string[]; hit: boolean; in_both: boolean }[];
  highlightKey: 'new' | 'dropped';
}) {
  return (
    <div className="rev-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h5 className="rev-h5" style={{ margin: 0 }}>{title}</h5>
        <span className="rev-sub" style={{ fontSize: 11 }}>{subtitle}</span>
      </div>
      <div className="rev-table-wrap" style={{ marginTop: 6 }}>
        <table className="rev-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Team</th>
              <th className="num">Heat</th>
              <th className="num">Mod</th>
              <th>HR?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cls = r.in_both ? '' : highlightKey === 'new' ? 'rev-row--new' : 'rev-row--dropped';
              return (
                <tr key={`${r.rank}-${r.player_id}`} className={cls}>
                  <td>{r.rank}</td>
                  <td>{r.player_name}</td>
                  <td>{r.team}</td>
                  <td className="num">{r.heat_score.toFixed(1)}</td>
                  <td className={`num ${r.modified_score !== r.heat_score ? (r.modified_score > r.heat_score ? 'rev-pos' : 'rev-neg') : ''}`}>
                    {r.modified_score.toFixed(1)}
                  </td>
                  <td>{r.hit ? '✓' : '·'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
      .rev-kpi-sub { font-size: 10px; opacity: 0.6; margin-top: 2px; }

      /* Actionable rule cards */
      .rev-rule-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 10px;
        margin-top: 8px;
      }
      .rev-rule {
        background: #14171f;
        border: 1px solid #232732;
        border-radius: 8px;
        padding: 10px 12px;
      }
      .rev-rule-head {
        display: flex; justify-content: space-between; align-items: flex-start;
        gap: 8px; margin-bottom: 8px;
      }
      .rev-rule-title {
        font-weight: 600; font-size: 14px; color: #e2e6ee;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .rev-rule-list {
        margin: 0; display: grid; gap: 6px;
      }
      .rev-rule-list > div {
        display: grid; grid-template-columns: 90px 1fr; gap: 6px; align-items: start;
      }
      .rev-rule-list dt {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
        opacity: 0.55; padding-top: 2px;
      }
      .rev-rule-list dd {
        margin: 0; font-size: 12.5px; color: #d9e0eb; line-height: 1.4;
      }
      .rev-rule-list code { font-size: 11.5px; background: #0c0e14; padding: 1px 5px; border-radius: 3px; }
      .rev-status {
        display: inline-block; padding: 2px 8px; border-radius: 999px;
        font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
        font-weight: 600; white-space: nowrap;
      }
      .rev-status--apply { background: #1f3e29; color: #b6f0c1; }
      .rev-status--test { background: #2d3a52; color: #b8d2ff; }
      .rev-status--monitor { background: #2a2d36; color: #aab1c0; }
      .rev-risk {
        display: inline-block; padding: 1px 7px; border-radius: 999px;
        font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
      }
      .rev-risk--low { background: #1f3e29; color: #b6f0c1; }
      .rev-risk--med { background: #3a3623; color: #f0e3a2; }
      .rev-risk--high { background: #4a2730; color: #f3b6b6; }

      /* Simulated Top-10 row highlights */
      .rev-row--new td { background: rgba(50, 130, 70, 0.15); }
      .rev-row--dropped td { background: rgba(150, 60, 60, 0.12); opacity: 0.85; }

      /* Reconstruction rules + diff */
      .rev-recon-rules { display: grid; gap: 4px; margin-top: 6px; }
      .rev-recon-rule {
        background: #0c0e14;
        border: 1px solid #1f2330;
        border-radius: 6px;
        padding: 5px 8px;
        font-size: 12.5px;
      }
      .rev-recon-rule code {
        background: transparent;
        color: #ffd28c;
        font-weight: 600;
      }
      .rev-diff-list {
        list-style: none; padding: 0; margin: 0;
        font-size: 12px; display: grid; gap: 3px;
      }
      .rev-diff-list li { line-height: 1.35; }
    `}</style>
  );
}
