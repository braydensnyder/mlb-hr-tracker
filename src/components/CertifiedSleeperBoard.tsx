/**
 * CertifiedSleeperBoard — the curated "Smart Money" subsection + a
 * self-contained bankroll goal tracker.
 *
 * Two pieces:
 *   1. The certified pick cards (strict-filtered sleepers with chips,
 *      market-vs-model badge, explanation, and a standardized +200 sim).
 *   2. A Goal Tracker panel scoped ONLY to this board. Every pick is
 *      simulated at a flat +200 ($1 risk → $2 profit → $3 return) — this
 *      is NOT real sportsbook pricing, just a clean consistent unit for
 *      progress tracking.
 *
 * Tracker rules (deliberate guardrails):
 *   - Flat unit per pick. NO Martingale, NO chase, NO auto-resizing on a
 *     loss. A loss just subtracts one unit from session P/L.
 *   - Losses never change rankings or bet sizing.
 *   - State persists in localStorage per target date so the card survives
 *     refreshes, but it's purely a simulator — not financial advice.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { certifiedMarketLabel, type CertifiedSleeper } from '../lib/stats';

// Standardized simulation constants (per the spec).
const SIM_PROFIT_MULT = 2; // +200 → $2 profit per $1 risked
const SIM_RETURN_MULT = 3; // $3 total return including stake

type PickResult = 'pending' | 'win' | 'loss';

interface TrackerState {
  goalAmount: number;
  unitSize: number;
  /** player_id → selected for the card */
  selected: Record<number, boolean>;
  /** player_id → win/loss/pending */
  results: Record<number, PickResult>;
}

const DEFAULT_STATE: TrackerState = {
  goalAmount: 100,
  unitSize: 1,
  selected: {},
  results: {},
};

function storageKey(date: string) {
  return `hrtracker:certified:${date}`;
}

function loadState(date: string): TrackerState {
  try {
    const raw = localStorage.getItem(storageKey(date));
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<TrackerState>;
    return {
      goalAmount: typeof parsed.goalAmount === 'number' ? parsed.goalAmount : DEFAULT_STATE.goalAmount,
      unitSize: typeof parsed.unitSize === 'number' && parsed.unitSize > 0 ? parsed.unitSize : DEFAULT_STATE.unitSize,
      selected: parsed.selected ?? {},
      results: parsed.results ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export default function CertifiedSleeperBoard({
  picks,
  asOf,
}: {
  picks: CertifiedSleeper[];
  asOf: string;
}) {
  const [state, setState] = useState<TrackerState>(() => loadState(asOf));

  // Reload state when the date changes.
  useEffect(() => { setState(loadState(asOf)); }, [asOf]);

  // Persist on every change.
  useEffect(() => {
    try { localStorage.setItem(storageKey(asOf), JSON.stringify(state)); } catch { /* ignore */ }
  }, [state, asOf]);

  function toggleSelected(id: number) {
    setState((s) => ({ ...s, selected: { ...s.selected, [id]: !s.selected[id] } }));
  }
  function setResult(id: number, r: PickResult) {
    setState((s) => ({ ...s, results: { ...s.results, [id]: s.results[id] === r ? 'pending' : r } }));
  }
  function setGoal(v: number) { setState((s) => ({ ...s, goalAmount: v })); }
  function setUnit(v: number) { setState((s) => ({ ...s, unitSize: v > 0 ? v : 1 })); }
  function resetSession() {
    setState((s) => ({ ...s, selected: {}, results: {} }));
  }

  // ---- Derived tracker math (flat +200, no chase) ----
  const tracker = useMemo(() => {
    const unit = state.unitSize;
    const selectedIds = picks.filter((p) => state.selected[p.player_id]).map((p) => p.player_id);
    const picksSelected = selectedIds.length;
    const totalRisk = picksSelected * unit;
    const potentialProfit = totalRisk * SIM_PROFIT_MULT;
    const potentialReturn = totalRisk * SIM_RETURN_MULT;

    let wins = 0, losses = 0;
    for (const id of selectedIds) {
      const r = state.results[id];
      if (r === 'win') wins++;
      else if (r === 'loss') losses++;
    }
    const settled = wins + losses;
    // Win → +2 units; Loss → -1 unit. Flat. No Martingale.
    const netPL = wins * unit * SIM_PROFIT_MULT - losses * unit;
    const settledRisk = settled * unit;
    const roi = settledRisk > 0 ? netPL / settledRisk : 0;
    const progress = netPL; // progress toward goal = realized session P/L
    const progressPct = state.goalAmount > 0 ? Math.max(0, Math.min(100, (progress / state.goalAmount) * 100)) : 0;

    return { unit, picksSelected, totalRisk, potentialProfit, potentialReturn, wins, losses, settled, netPL, roi, progress, progressPct };
  }, [picks, state]);

  if (picks.length === 0) {
    return (
      <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--accent-2, #ffd166)' }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Certified Sleepers ⭐ — Smart Money</h2>
        <div className="subtle" style={{ fontSize: 12 }}>
          No certified picks for {asOf} yet. This board only surfaces confirmed starters with
          stacked signals (≥2, one strong) and a clean matchup — it stays empty until lineups
          post and the conditions line up. That selectivity is the point.
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--accent-2, #ffd166)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Certified Sleepers ⭐ — Smart Money</h2>
        <span className="subtle" style={{ fontSize: 12 }}>
          curated value — confirmed starters, stacked signals, clean matchups
        </span>
      </div>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        Stricter than the chaos lists: every pick is a <strong>confirmed starter</strong> with
        <strong> medium+ confidence</strong>, at least two favorable signals (one of them strong),
        and no disqualifying matchup (no ace shutting down HRs, no wind howling in). These are the
        sleepers that survived the filters — not lottery tickets.
      </div>

      {/* ---- Goal Tracker ---- */}
      <GoalTracker
        goalAmount={state.goalAmount}
        unitSize={state.unitSize}
        tracker={tracker}
        onGoal={setGoal}
        onUnit={setUnit}
        onReset={resetSession}
      />

      {/* ---- Pick cards ---- */}
      <div
        style={{
          display: 'grid',
          gap: 10,
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          marginTop: 12,
        }}
      >
        {picks.map((p) => (
          <CertifiedCard
            key={p.player_id}
            p={p}
            asOf={asOf}
            unit={state.unitSize}
            selected={!!state.selected[p.player_id]}
            result={state.results[p.player_id] ?? 'pending'}
            onToggle={() => toggleSelected(p.player_id)}
            onResult={(r) => setResult(p.player_id, r)}
          />
        ))}
      </div>

      <div className="subtle" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
        Bankroll simulator — research/tracking only, <strong>not financial advice</strong>. Every
        pick is standardized at <strong>+200</strong> ($1 risk → $2 profit → $3 return) purely for
        a clean, consistent progress metric; it does NOT reflect real sportsbook pricing. Flat unit
        per pick — no chase, no Martingale, no auto-resizing. Losses don't change rankings.
      </div>
    </div>
  );
}

function GoalTracker({
  goalAmount,
  unitSize,
  tracker,
  onGoal,
  onUnit,
  onReset,
}: {
  goalAmount: number;
  unitSize: number;
  tracker: {
    picksSelected: number; totalRisk: number; potentialProfit: number; potentialReturn: number;
    wins: number; losses: number; settled: number; netPL: number; roi: number; progress: number; progressPct: number;
  };
  onGoal: (v: number) => void;
  onUnit: (v: number) => void;
  onReset: () => void;
}) {
  const plColor = tracker.netPL > 0 ? 'var(--good, #4cd97a)' : tracker.netPL < 0 ? '#ff8d8d' : 'var(--muted)';
  return (
    <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Goal Tracker <span className="subtle" style={{ fontWeight: 400 }}>(simulated +200, this board only)</span></strong>
        <button type="button" onClick={onReset} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)', cursor: 'pointer' }}>
          Reset session
        </button>
      </div>

      {/* Config inputs */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12 }}>
          <span className="subtle" style={{ display: 'block', marginBottom: 2 }}>Goal amount ($)</span>
          <input type="number" min={0} step={5} value={goalAmount} onChange={(e) => onGoal(Number(e.target.value))}
            style={{ width: 90, padding: '4px 6px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </label>
        <label style={{ fontSize: 12 }}>
          <span className="subtle" style={{ display: 'block', marginBottom: 2 }}>Unit size ($)</span>
          <input type="number" min={0.5} step={0.5} value={unitSize} onChange={(e) => onUnit(Number(e.target.value))}
            style={{ width: 90, padding: '4px 6px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </label>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
          <span className="subtle">Progress toward ${goalAmount} goal</span>
          <span style={{ color: plColor, fontWeight: 700 }}>
            {tracker.progress >= 0 ? '+' : ''}${tracker.progress.toFixed(2)}
          </span>
        </div>
        <div style={{ height: 10, background: 'var(--panel)', borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{ width: `${tracker.progressPct}%`, height: '100%', background: 'var(--good, #4cd97a)' }} />
        </div>
      </div>

      {/* Metric tiles */}
      <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', fontSize: 12 }}>
        <Tile label="Picks" value={`${tracker.picksSelected}`} />
        <Tile label="Total risk" value={`$${tracker.totalRisk.toFixed(2)}`} />
        <Tile label="Profit if all hit" value={`+$${tracker.potentialProfit.toFixed(2)}`} accent />
        <Tile label="Return if all hit" value={`$${tracker.potentialReturn.toFixed(2)}`} />
        <Tile label="Wins" value={`${tracker.wins}`} />
        <Tile label="Losses" value={`${tracker.losses}`} />
        <Tile label="Net P/L" value={`${tracker.netPL >= 0 ? '+' : ''}$${tracker.netPL.toFixed(2)}`} colorOverride={plColor} />
        <Tile label="ROI" value={tracker.settled > 0 ? `${(tracker.roi * 100).toFixed(0)}%` : '—'} colorOverride={tracker.settled > 0 ? plColor : undefined} />
      </div>
    </div>
  );
}

function Tile({ label, value, accent, colorOverride }: { label: string; value: string; accent?: boolean; colorOverride?: string }) {
  return (
    <div style={{ padding: '5px 7px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--border)' }}>
      <div className="subtle" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: colorOverride ?? (accent ? 'var(--good, #4cd97a)' : undefined) }}>{value}</div>
    </div>
  );
}

function CertifiedCard({
  p,
  asOf,
  unit,
  selected,
  result,
  onToggle,
  onResult,
}: {
  p: CertifiedSleeper;
  asOf: string;
  unit: number;
  selected: boolean;
  result: PickResult;
  onToggle: () => void;
  onResult: (r: PickResult) => void;
}) {
  const market = certifiedMarketLabel(p.market_signal);
  const marketColor = market.tone === 'good' ? 'var(--good, #4cd97a)' : market.tone === 'bad' ? '#ff8d8d' : 'var(--muted)';
  const marketBg = market.tone === 'good' ? 'rgba(64,200,120,0.14)' : market.tone === 'bad' ? 'rgba(255,110,110,0.14)' : 'rgba(160,160,160,0.14)';

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: `1px solid ${selected ? 'var(--accent-2, #ffd166)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div>
          <Link className="player-link" to={`/player/${p.player_id}?asOf=${asOf}`} style={{ fontSize: 14, fontWeight: 700 }}>
            {p.player_name}
          </Link>
          <div className="subtle" style={{ fontSize: 11, marginTop: 1 }}>
            {p.team} vs {p.opponent} · #{p.heat_rank} · {p.heat_score.toFixed(0)} heat · {p.confidence} conf
          </div>
        </div>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', cursor: 'pointer' }}>
          <input type="checkbox" checked={selected} onChange={onToggle} />
          card
        </label>
      </div>

      {/* Market vs model badge */}
      <div style={{ marginTop: 6 }}>
        <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: marketBg, border: `1px solid ${marketColor}`, color: marketColor, letterSpacing: 0.3 }}>
          {market.label}
        </span>
      </div>

      {/* Chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {p.tags.map((t) => (
          <span key={t.kind} title={t.detail ?? t.label}
            style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600, background: 'rgba(64,200,120,0.12)', border: '1px solid rgba(64,200,120,0.4)', color: 'var(--good, #4cd97a)', whiteSpace: 'nowrap' }}>
            {t.label}
          </span>
        ))}
      </div>

      {/* Explanation */}
      <div className="subtle" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.4 }}>
        {p.explanation}
      </div>

      {/* Standardized +200 sim */}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11 }}>
        <span className="subtle">Sim odds <strong style={{ color: 'var(--text)' }}>+200</strong></span>
        <span className="subtle">Risk <strong style={{ color: 'var(--text)' }}>${unit.toFixed(2)}</strong></span>
        <span className="subtle">Profit if hit <strong style={{ color: 'var(--good, #4cd97a)' }}>+${(unit * SIM_PROFIT_MULT).toFixed(2)}</strong></span>
        <span className="subtle">Return <strong style={{ color: 'var(--text)' }}>${(unit * SIM_RETURN_MULT).toFixed(2)}</strong></span>
      </div>

      {/* Win/Loss marking (only meaningful when selected) */}
      {selected && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <ResultButton active={result === 'win'} tone="good" onClick={() => onResult('win')}>Hit ✓</ResultButton>
          <ResultButton active={result === 'loss'} tone="bad" onClick={() => onResult('loss')}>Miss ✗</ResultButton>
          {result !== 'pending' && (
            <span className="subtle" style={{ fontSize: 11, alignSelf: 'center' }}>
              {result === 'win' ? `+$${(unit * SIM_PROFIT_MULT).toFixed(2)}` : `−$${unit.toFixed(2)}`} to session
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ResultButton({ active, tone, onClick, children }: { active: boolean; tone: 'good' | 'bad'; onClick: () => void; children: React.ReactNode }) {
  const color = tone === 'good' ? 'var(--good, #4cd97a)' : '#ff8d8d';
  const bg = active ? (tone === 'good' ? 'rgba(64,200,120,0.2)' : 'rgba(255,110,110,0.2)') : 'var(--panel-2)';
  return (
    <button type="button" onClick={onClick}
      style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, background: bg, border: `1px solid ${active ? color : 'var(--border)'}`, color: active ? color : 'var(--text)', cursor: 'pointer', fontWeight: 600 }}>
      {children}
    </button>
  );
}
