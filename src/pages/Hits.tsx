/**
 * /hits — Hits ranker page (dark, compact).
 *
 * Two independent rankers (1+ Hit / 2+ Hits). Board defaults to Top 10
 * with expand controls (25 / 50 / full universe).
 *
 * Visual pass: matches the dark navy palette from index.css. Compact
 * experimental strip with details expand. No changes to scoring or
 * ranking logic.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchHitTargetsForDate, fetchPlayerIndex, type HitBoardBundle } from '../lib/supabase';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate';
import HitsBoard from '../components/HitsBoard';

type Ranker = '1plus' | '2plus';
type BoardLimit = 10 | 25 | 50 | 999;

const LIMIT_LABELS: Record<BoardLimit, string> = {
  10: 'Top 10', 25: 'Top 25', 50: 'Top 50', 999: 'Full',
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
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [pitcherNames, setPitcherNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchHitTargetsForDate(date, { preferSnapshots: date !== today })
      .then((b) => { if (!cancelled) { setBundle(b); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [date, today]);

  // Load the players catalog once — used to resolve opposing-pitcher names.
  useEffect(() => {
    let cancelled = false;
    fetchPlayerIndex()
      .then((idx) => {
        if (cancelled) return;
        const map = new Map<number, string>();
        for (const [id, info] of idx) {
          if (info.full_name) map.set(id, info.full_name);
        }
        setPitcherNames(map);
      })
      .catch(() => { /* non-fatal — board will fall back to #<id> */ });
    return () => { cancelled = true; };
  }, []);

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
    <div className="panel" style={{ padding: 14 }}>
      {/* ---- Header row ---- */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 10, marginBottom: 10,
      }}>
        <h2 style={{
          margin: 0, fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.8,
          color: 'var(--muted)',
        }}>
          Hits · {date}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button onClick={() => updateParam('date', mlbAddDays(date, -1))} style={btn(false)}>◀</button>
          <input
            type="date" value={date}
            onChange={(e) => updateParam('date', e.target.value)}
            style={{
              padding: '4px 8px', background: 'var(--panel-2)',
              border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)',
              fontSize: 12, colorScheme: 'dark',
            }}
          />
          <button onClick={() => updateParam('date', mlbAddDays(date, 1))} style={btn(false)}>▶</button>
          <button
            onClick={() => updateParam('date', today)}
            style={btn(date === today)} disabled={date === today}
          >Today</button>
        </div>
      </div>

      {/* ---- Compact experimental strip ---- */}
      {experimental && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '6px 10px', marginBottom: 10,
          background: 'rgba(255,209,102,0.06)',
          border: '1px solid rgba(255,209,102,0.30)',
          borderRadius: 6, fontSize: 12,
        }}>
          <span style={{
            background: 'var(--accent-2)', color: 'var(--bg)',
            padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
            letterSpacing: 0.6,
          }}>EXPERIMENTAL</span>
          <span style={{ color: 'var(--muted)' }}>
            Ranker has not cleared validation guardrails yet.
          </span>
          <button
            onClick={() => setShowModelDetails((v) => !v)}
            style={{
              marginLeft: 'auto', background: 'transparent',
              border: 'none', color: 'var(--muted)', cursor: 'pointer',
              fontSize: 11, textDecoration: 'underline',
            }}
          >
            {showModelDetails ? 'hide details' : 'details'}
          </button>
          {showModelDetails && bundle && (
            <div style={{
              width: '100%', marginTop: 4, padding: '6px 10px',
              background: 'var(--panel-2)', borderRadius: 4,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              fontSize: 11, color: 'var(--muted)',
            }}>
              1+: {bundle.model_1plus_id ?? '?'} · hash {bundle.model_1plus_hash ?? '?'}<br />
              2+: {bundle.model_2plus_id ?? '?'} · hash {bundle.model_2plus_hash ?? '?'}
            </div>
          )}
        </div>
      )}

      {/* ---- Segmented controls: ranker + limit ---- */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center',
        marginBottom: 10, flexWrap: 'wrap',
      }}>
        <div style={segGroup()}>
          {(['1plus', '2plus'] as const).map((r) => (
            <button key={r} onClick={() => updateParam('r', r)} style={segBtn(ranker === r)}>
              {r === '1plus' ? '1+ Hit' : '2+ Hits'}
            </button>
          ))}
        </div>
        <div style={{ ...segGroup(), marginLeft: 'auto' }}>
          {([10, 25, 50, 999] as BoardLimit[]).map((n) => (
            <button key={n} onClick={() => updateParam('n', String(n))} style={segBtn(validLimit === n)}>
              {LIMIT_LABELS[n]}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Source strip (thin) ---- */}
      {bundle && bundle.rows.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--muted)', marginBottom: 6,
        }}>
          <span>
            <code style={{ background: 'var(--panel-2)', padding: '1px 5px', borderRadius: 3, color: 'var(--muted)' }}>
              {bundle.source === 'snapshots' ? 'snapshots (frozen)' : 'universe (live)'}
            </code>
          </span>
          <span>·</span>
          <span>{bundle.rows.length} starters</span>
          {isPastDate && (
            <>
              <span>·</span>
              <span>{outcomesAvailable ? 'outcomes enriched' : 'outcomes pending'}</span>
            </>
          )}
          <span>·</span>
          <span title="The Hit Score column is the ranker's raw sigmoid output ×100. It is NOT an empirically calibrated probability. Ranking within the day is meaningful; the absolute value is not a P(hit).">
            Hit Score = ranker output, not a calibrated probability
          </span>
        </div>
      )}

      {/* ---- Board ---- */}
      {loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {err && (
        <div style={{
          padding: 10, background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.30)', borderRadius: 6,
          color: '#fca5a5', fontSize: 13,
        }}>
          <strong>Failed to load:</strong> {err}
        </div>
      )}
      {!loading && !err && bundle && bundle.rows.length === 0 && (
        <div style={{
          padding: 12, background: 'var(--panel-2)',
          border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
        }}>
          <p style={{ margin: 0 }}>
            No Hits data for {date}. Pregame snapshot may not have run yet, or the
            date has no scheduled games.
          </p>
          {date === today && (
            <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 12 }}>
              Try <code style={{ background: 'var(--panel)', padding: '1px 4px', borderRadius: 3 }}>npm run snapshot:hits:today</code>, or
              wait for the nightly cron (Phase 4.7).
            </p>
          )}
        </div>
      )}
      {!loading && !err && bundle && bundle.rows.length > 0 && (
        <HitsBoard
          rows={bundle.rows}
          ranker={ranker}
          limit={validLimit}
          showOutcomeBadges={showOutcomeBadges}
          pitcherNames={pitcherNames}
        />
      )}
    </div>
  );
}

// ---- Style helpers (dark palette, small) ----

function segGroup(): React.CSSProperties {
  return {
    display: 'inline-flex',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: 2,
  };
}
function segBtn(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? 'var(--bg)' : 'var(--muted)',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    letterSpacing: active ? 0.3 : 0,
    cursor: active ? 'default' : 'pointer',
    transition: 'background 120ms',
  };
}
function btn(active: boolean): React.CSSProperties {
  return {
    padding: '4px 9px',
    background: active ? 'var(--accent)' : 'var(--panel-2)',
    color: active ? 'var(--bg)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 12,
    cursor: active ? 'default' : 'pointer',
  };
}
