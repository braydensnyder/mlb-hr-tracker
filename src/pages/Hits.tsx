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
import { Link, useSearchParams } from 'react-router-dom';
import { fetchHitTargetsForDate, fetchPlayerIndex, type HitBoardBundle } from '../lib/supabase';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate';
import { HIT_MODEL_VERSIONS } from '../lib/hitModels';
import HitsBoard from '../components/HitsBoard';

type Ranker = '1plus' | '2plus';
type BoardLimit = 10 | 25 | 50 | 999;
type ViewMode = 'auto' | 'frozen' | 'live';

const LIMIT_LABELS: Record<BoardLimit, string> = {
  10: 'Top 10', 25: 'Top 25', 50: 'Top 50', 999: 'Full',
};

/** Compact HH:MM AM/PM localized to the viewer's browser. Falls back to
 *  the raw ISO string if the input can't be parsed. */
function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const DEFAULT_MODEL_VERSION = HIT_MODEL_VERSIONS.find((v) => v.is_default)?.version ?? 1;

export default function Hits() {
  const [params, setParams] = useSearchParams();
  const today = mlbToday();
  const rawDate = params.get('date');
  const date = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : today;
  const ranker = (params.get('r') === '2plus' ? '2plus' : '1plus') as Ranker;
  const limit = (Number(params.get('n')) as BoardLimit) || 10;
  const validLimit: BoardLimit = ([10, 25, 50, 999] as BoardLimit[]).includes(limit) ? limit : 10;
  // ?model=v1|v2 — falls back to the HIT_MODEL_VERSIONS is_default entry.
  const rawModel = params.get('model');
  const modelVersion: number = (() => {
    if (rawModel && /^v?(\d+)$/.test(rawModel)) {
      const n = Number(rawModel.replace(/^v/, ''));
      if (HIT_MODEL_VERSIONS.some((v) => v.version === n)) return n;
    }
    return DEFAULT_MODEL_VERSION;
  })();
  // ?view=frozen|live|auto — chooses source table.
  //   auto (default) — snapshot when it exists, else universe. The
  //     official "grade what we froze" behavior once Phase 4.7 has run.
  //   frozen         — force snapshot table (Frozen Picks toggle).
  //   live           — force universe table (Live Board toggle).
  const rawView = params.get('view');
  const view: ViewMode = rawView === 'frozen' || rawView === 'live' ? rawView : 'auto';

  const [bundle, setBundle] = useState<HitBoardBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showModelDetails, setShowModelDetails] = useState(false);
  const [pitcherNames, setPitcherNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // Mode maps directly from the URL param — 'auto' lets the fetcher
    // pick snapshot when one exists for today (so we default to Frozen
    // Picks the moment Phase 4.7 lands), universe when it doesn't yet.
    const fetchMode: 'auto' | 'snapshot' | 'live' =
      view === 'frozen' ? 'snapshot' : view === 'live' ? 'live' : 'auto';
    fetchHitTargetsForDate(date, { modelVersion, mode: fetchMode })
      .then((b) => { if (!cancelled) { setBundle(b); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [date, today, modelVersion, view]);

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
  const outcomesAvailable = !!bundle?.outcomes_enriched;
  const showOutcomeBadges = bundle?.source === 'snapshots' && outcomesAvailable;
  const experimental = !!bundle && (!bundle.model_1plus_is_validated || !bundle.model_2plus_is_validated);

  // Snapshot status label with timestamp. Priority: FINAL beats PREGAME;
  // SIMULATED always distinct so a backfilled row is never confused
  // with a real pregame audit record. Universe rows carry the freshest
  // captured_at ("LIVE — updated 10:42 AM"); snapshot rows carry
  // pregame_run_at ("PREGAME — FROZEN 11:15 AM"). FINAL takes precedence
  // over PREGAME once outcomes are enriched.
  const snapshotStatus: { label: string; tone: 'good' | 'neutral' | 'warn' } | null = (() => {
    if (!bundle) return null;
    if (bundle.source === 'universe') {
      const ts = fmtClock(bundle.updated_at);
      return { label: `LIVE — updated ${ts}`, tone: 'neutral' };
    }
    if (bundle.snapshot_type === 'simulated') {
      return { label: 'SIMULATED HISTORICAL', tone: 'warn' };
    }
    if (bundle.outcomes_enriched) {
      return { label: 'FINAL — RESULTS ENRICHED', tone: 'good' };
    }
    const ts = fmtClock(bundle.updated_at);
    return { label: `PREGAME — FROZEN ${ts}`, tone: 'neutral' };
  })();

  // Companion "PREGAME — FROZEN HH:MM" badge shown alongside LIVE when
  // we're viewing the universe but a snapshot ALREADY exists for the
  // day. Tells the user "the graded picks stopped moving at 11:15 AM,
  // this view is what's changed since then."
  const companionFrozenBadge: string | null =
    bundle && bundle.source === 'universe' && bundle.snapshot_available && bundle.snapshot_frozen_at
      ? `PREGAME — FROZEN ${fmtClock(bundle.snapshot_frozen_at)}`
      : null;

  // Top-N daily summary for the currently-selected ranker.
  // Uses the outcome field aligned with the ranker (1+ board sums
  // hit_1plus, 2+ board sums hit_2plus). Only rendered when outcomes
  // are enriched.
  const topNSummary = useMemo(() => {
    if (!bundle || !outcomesAvailable) return null;
    const rankKey = ranker === '1plus' ? 'rank_1plus' : 'rank_2plus';
    const outcomeKey = ranker === '1plus' ? 'hit_1plus' : 'hit_2plus';
    const sorted = bundle.rows
      .filter((r) => r[rankKey] != null)
      .sort((a, b) => (a[rankKey] as number) - (b[rankKey] as number));
    function countHits(n: number) {
      let hits = 0, total = 0;
      for (const r of sorted.slice(0, n)) {
        if (r[outcomeKey] != null) { total += 1; if (r[outcomeKey]) hits += 1; }
      }
      return { hits, total };
    }
    return {
      top3: countHits(3), top5: countHits(5), top10: countHits(10), top25: countHits(25),
    };
  }, [bundle, ranker, outcomesAvailable]);

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
        <div>
          <h2 style={{
            margin: 0, fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.8,
            color: 'var(--muted)',
          }}>
            Hits · {date}
          </h2>
          <div style={{ marginTop: 2, fontSize: 11 }}>
            <Link to="/hits/backtest" style={{ color: 'var(--accent-2)' }}>Backtest · v1 vs v2 →</Link>
          </div>
        </div>
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

      {/* ---- Segmented controls: model + ranker + limit ---- */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        marginBottom: 10, flexWrap: 'wrap',
      }}>
        <div style={segGroup()}>
          {HIT_MODEL_VERSIONS.map((v) => (
            <button key={v.version} onClick={() => updateParam('model', 'v' + v.version)}
              style={segBtn(modelVersion === v.version)}
              title={`${v.label}${v.config_1plus.is_validated ? '' : ' — experimental'}`}>
              {v.label}
            </button>
          ))}
        </div>
        <div style={segGroup()}>
          {(['1plus', '2plus'] as const).map((r) => (
            <button key={r} onClick={() => updateParam('r', r)} style={segBtn(ranker === r)}>
              {r === '1plus' ? '1+ Hit' : '2+ Hits'}
            </button>
          ))}
        </div>
        {/* Frozen / Live toggle — only meaningful when a snapshot
            exists for the day. Grade-what-we-froze default is 'auto'
            which resolves to snapshot the moment Phase 4.7 writes it. */}
        {bundle && bundle.snapshot_available && (
          <div style={segGroup()} title="Frozen Picks = the graded pregame snapshot (immutable). Live Board = the working hit_target_universe (moves as inputs update).">
            {(['frozen', 'live'] as const).map((v) => {
              const active = view === v || (view === 'auto' && v === 'frozen');
              return (
                <button key={v} onClick={() => updateParam('view', v)} style={segBtn(active)}>
                  {v === 'frozen' ? 'Frozen Picks' : 'Live Board'}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ ...segGroup(), marginLeft: 'auto' }}>
          {([10, 25, 50, 999] as BoardLimit[]).map((n) => (
            <button key={n} onClick={() => updateParam('n', String(n))} style={segBtn(validLimit === n)}>
              {LIMIT_LABELS[n]}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Source strip (thin) + snapshot status badge ---- */}
      {bundle && bundle.rows.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--muted)', marginBottom: 6,
        }}>
          {snapshotStatus && (
            <span style={statusBadgeStyle(snapshotStatus.tone)}
                  title="LIVE — updated HH:MM: hit_target_universe was last refreshed at this time. PREGAME — FROZEN HH:MM: hit_target_snapshots was written at this time and cannot move. FINAL — RESULTS ENRICHED: pregame ranks with actual outcomes filled in. SIMULATED HISTORICAL: reconstructed via backfill AFTER games completed.">
              {snapshotStatus.label}
            </span>
          )}
          {companionFrozenBadge && (
            <span style={statusBadgeStyle('good')}
                  title="A frozen pregame snapshot exists for this date. Grading is against those ranks — this live view shows what has changed since the freeze.">
              {companionFrozenBadge}
            </span>
          )}
          <span>
            <code style={{ background: 'var(--panel-2)', padding: '1px 5px', borderRadius: 3, color: 'var(--muted)' }}>
              {bundle.source === 'snapshots' ? 'snapshots (frozen)' : 'universe (live)'}
            </code>
          </span>
          <span>·</span>
          <span>v{bundle.model_version}</span>
          <span>·</span>
          <span>{bundle.rows.length} starters</span>
          {isPastDate && bundle.source === 'snapshots' && !outcomesAvailable && (
            <>
              <span>·</span>
              <span>outcomes pending</span>
            </>
          )}
          <span>·</span>
          <span title="The Hit Score column is the ranker's raw sigmoid output ×100. It is NOT an empirically calibrated probability. Ranking within the day is meaningful; the absolute value is not a P(hit).">
            Hit Score = ranker output, not a calibrated probability
          </span>
        </div>
      )}

      {/* ---- Top-N daily result summary (only when outcomes enriched) ---- */}
      {topNSummary && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          padding: '8px 12px', marginBottom: 10,
          background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 13, color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
        }}>
          <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {ranker === '1plus' ? '1+ Hit' : '2+ Hits'} results
          </span>
          {(['top3', 'top5', 'top10', 'top25'] as const).map((k) => {
            const n = k === 'top3' ? 3 : k === 'top5' ? 5 : k === 'top10' ? 10 : 25;
            const s = topNSummary[k];
            const rate = s.total > 0 ? s.hits / s.total : 0;
            const tone = s.total === 0 ? 'muted' : rate >= 0.5 ? 'good' : rate >= 0.3 ? 'neutral' : 'weak';
            const color = tone === 'good' ? 'var(--good)' : tone === 'neutral' ? 'var(--text)' : tone === 'weak' ? '#fca5a5' : 'var(--muted)';
            return (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{ color: 'var(--muted)', fontSize: 11 }}>Top {n}:</span>
                <span style={{ color, fontWeight: 600 }}>{s.hits}/{s.total || n}</span>
              </span>
            );
          })}
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
function statusBadgeStyle(tone: 'good' | 'neutral' | 'warn'): React.CSSProperties {
  // Semantic colours for the snapshot-status badge. 'good' = FINAL
  // enriched (results present). 'warn' = SIMULATED historical
  // (backfilled, NOT a genuine pregame). 'neutral' = pregame frozen
  // or live view.
  const bg = tone === 'good'   ? 'rgba(74,222,128,0.12)'
           : tone === 'warn'   ? 'rgba(255,209,102,0.10)'
           :                     'rgba(133,147,184,0.10)';
  const fg = tone === 'good'   ? 'var(--good)'
           : tone === 'warn'   ? 'var(--accent-2)'
           :                     'var(--muted)';
  return {
    background: bg, color: fg,
    padding: '1px 7px', borderRadius: 4, fontSize: 10,
    fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
    border: `1px solid ${fg}33`,
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
