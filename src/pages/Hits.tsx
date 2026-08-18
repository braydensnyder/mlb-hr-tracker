/**
 * /hits — Hits ranker page.
 *
 * Two independent rankers (1+ Hit and 2+ Hits) shown as tabs. Board
 * defaults to Top 10 with expand controls (25 / 50 / full universe).
 *
 * Data source rules:
 *   - date == today: read hit_target_universe (live view)
 *   - date != today: read hit_target_snapshots (frozen pregame archive)
 *   - When date == today AND the writer has already run, both tables
 *     have data; universe is the tie-breaker (freshest scoring).
 *
 * EXPERIMENTAL badge:
 *   Every row carries model_config_id_{1plus,2plus}. When either id
 *   starts with 'experimental_' the badge is shown persistently at
 *   the top of the page — the rankings are NOT production-validated.
 *
 * This page does not compute anything itself — all scoring already
 * happened in snapshotHitTargets. UI is purely presentation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchHitTargetsForDate, type HitBoardBundle } from '../lib/supabase';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate';
import HitsBoard from '../components/HitsBoard';

type Ranker = '1plus' | '2plus';
type BoardLimit = 10 | 25 | 50 | 999;

const LIMIT_LABELS: Record<BoardLimit, string> = {
  10: 'Top 10',
  25: 'Top 25',
  50: 'Top 50',
  999: 'Full universe',
};

export default function Hits() {
  const [params, setParams] = useSearchParams();
  const today = mlbToday();
  const rawDate = params.get('date');
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today;
  const ranker = (params.get('r') === '2plus' ? '2plus' : '1plus') as Ranker;
  const limit = (Number(params.get('n')) as BoardLimit) || 10;
  const validLimit: BoardLimit = ([10, 25, 50, 999] as BoardLimit[]).includes(limit) ? limit : 10;

  const [bundle, setBundle] = useState<HitBoardBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchHitTargetsForDate(date, { preferSnapshots: date !== today })
      .then((b) => { if (!cancelled) { setBundle(b); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [date, today]);

  const isPastDate = date < today;
  const outcomesAvailable = useMemo(
    () => !!bundle?.rows.some((r) => r.outcome_enriched_at != null),
    [bundle],
  );
  const showOutcomeBadges = bundle?.source === 'snapshots' && outcomesAvailable;
  const experimental = !!bundle && (!bundle.model_1plus_is_validated || !bundle.model_2plus_is_validated);

  function updateParam(k: string, v: string) {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  }

  return (
    <div className="panel" style={{ padding: '18px 20px' }}>
      {/* ---- Header ---- */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Hits — {date}</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Who is most likely to record ≥1 hit or ≥2 hits today.
          </p>
        </div>
        {/* Date navigator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => updateParam('date', mlbAddDays(date, -1))}
            style={buttonStyle(false)}
          >← prev day</button>
          <input
            type="date"
            value={date}
            onChange={(e) => updateParam('date', e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
          />
          <button
            onClick={() => updateParam('date', mlbAddDays(date, 1))}
            style={buttonStyle(false)}
          >next day →</button>
          <button
            onClick={() => updateParam('date', today)}
            style={buttonStyle(date === today)}
            disabled={date === today}
          >Today</button>
        </div>
      </div>

      {/* ---- Experimental badge ---- */}
      {experimental && (
        <div style={{
          marginTop: 12, padding: '10px 14px',
          background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 6,
          fontSize: 13, color: '#92400e',
        }}>
          <strong>EXPERIMENTAL — unvalidated rankers.</strong>{' '}
          These rankings come from placeholder configs that have not yet
          cleared the walk-forward promotion guardrails
          (≥30 eval dates, positive Top-N lift, CI lower bound above 0,
          ≥55% dates beating baseline, ≥25% #1-stability finishes).
          {bundle && (
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
              1+ config: {bundle.model_1plus_id ?? '?'} · hash {bundle.model_1plus_hash ?? '?'}<br />
              2+ config: {bundle.model_2plus_id ?? '?'} · hash {bundle.model_2plus_hash ?? '?'}
            </div>
          )}
        </div>
      )}

      {/* ---- Ranker toggle + limit expand ---- */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => updateParam('r', '1plus')}
            style={tabStyle(ranker === '1plus')}
          >1+ Hit</button>
          <button
            onClick={() => updateParam('r', '2plus')}
            style={tabStyle(ranker === '2plus')}
          >2+ Hits</button>
        </div>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {([10, 25, 50, 999] as BoardLimit[]).map((n) => (
            <button
              key={n}
              onClick={() => updateParam('n', String(n))}
              style={pillStyle(validLimit === n)}
            >{LIMIT_LABELS[n]}</button>
          ))}
        </div>
      </div>

      {/* ---- Board ---- */}
      <div style={{ marginTop: 16 }}>
        {loading && <p style={{ color: '#6b7280' }}>Loading…</p>}
        {err && (
          <div style={{ padding: 12, background: '#fee2e2', border: '1px solid #dc2626', borderRadius: 4, color: '#991b1b' }}>
            <strong>Failed to load:</strong> {err}
          </div>
        )}
        {!loading && !err && bundle && bundle.rows.length === 0 && (
          <div style={{ padding: 14, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 4 }}>
            <p style={{ margin: 0 }}>
              No Hits data for {date}. The pregame snapshot may not have run yet, or the
              date has no scheduled games. Data source attempted:{' '}
              <code style={{ background: '#e5e7eb', padding: '1px 4px', borderRadius: 3 }}>{bundle.source}</code>.
            </p>
            {date === today && (
              <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: 13 }}>
                Try running <code>npm run snapshot:hits:today</code> from the CLI, or wait
                for the nightly cron (Phase 4.7).
              </p>
            )}
          </div>
        )}
        {!loading && !err && bundle && bundle.rows.length > 0 && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
              fontSize: 12, color: '#6b7280',
            }}>
              <span>
                Source: <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: 3 }}>
                  {bundle.source === 'snapshots' ? 'hit_target_snapshots (frozen pregame)' : 'hit_target_universe (live view)'}
                </code>
              </span>
              <span>·</span>
              <span>{bundle.rows.length} eligible starters</span>
              {isPastDate && (
                <>
                  <span>·</span>
                  <span>{outcomesAvailable ? 'outcomes enriched' : 'outcomes pending'}</span>
                </>
              )}
            </div>
            <HitsBoard
              rows={bundle.rows}
              ranker={ranker}
              limit={validLimit}
              showOutcomeBadges={showOutcomeBadges}
            />
          </>
        )}
      </div>

      {/* ---- Footer / help ---- */}
      <div style={{ marginTop: 24, fontSize: 12, color: '#9ca3af' }}>
        <p style={{ margin: 0 }}>
          Confidence: high (≥10 prior games, ≥12 AB in L7d, pitcher form known,
          ≤2 features missing) · medium · low (thin data or ≥4 features missing).
          Chip triggers are evidence-only — a chip never fires without underlying
          data. Click a player to drill in.
        </p>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------
// Small style helpers — keep the palette consistent with existing pages
// without pulling in a new CSS file.
// -------------------------------------------------------------------

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: active ? '#111827' : '#f9fafb',
    color: active ? '#f9fafb' : '#111827',
    border: '1px solid ' + (active ? '#111827' : '#d1d5db'),
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: active ? 600 : 500,
  };
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    background: active ? '#374151' : 'transparent',
    color: active ? '#f9fafb' : '#374151',
    border: '1px solid ' + (active ? '#374151' : '#d1d5db'),
    borderRadius: 999,
    cursor: 'pointer',
    fontSize: 13,
  };
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    background: active ? '#111827' : '#ffffff',
    color: active ? '#f9fafb' : '#111827',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 13,
    cursor: active ? 'default' : 'pointer',
  };
}
