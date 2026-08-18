/**
 * /hits/backtest — v1 vs v2 side-by-side backtest for the Hits models.
 *
 * Three sections:
 *
 *   1. Rolling summary strip — 7 / 14 / 30 / all-in-range aggregates
 *      per model + ranker. Reports Top-3/5/10/25 hit rate, slate
 *      baseline, absolute lift.
 *
 *   2. Daily table — one row per date. Both models' Top-3/5/10/25
 *      hit counts side-by-side. Baseline column. Row is clickable
 *      to load the disagreement view for that date.
 *
 *   3. Disagreement view — for a chosen date + ranker:
 *      * players in v2 Top-10 but NOT v1 Top-10
 *      * players in v1 Top-10 but NOT v2 Top-10
 *      * shared Top-10
 *      Each row shows rank on both models, rank difference, and
 *      actual outcome when enriched.
 *
 * READ-ONLY. Fetches only from hit_target_snapshots + players catalog
 * (already loaded elsewhere). No ranker code touched.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  fetchHitBacktestForRange,
  fetchHitDisagreement,
  type HitBacktestDayVersion,
  type HitBacktestRange,
  type HitDisagreementResult,
  type HitDisagreementPlayer,
} from '../lib/supabase';
import { mlbToday, addDays as mlbAddDays } from '../lib/mlbDate';
import { HIT_MODEL_VERSIONS } from '../lib/hitModels';

type Ranker = '1plus' | '2plus';
type WindowKey = '7d' | '14d' | '30d' | 'all';

const WINDOWS: Array<{ key: WindowKey; label: string; days: number | null }> = [
  { key: '7d',  label: 'Rolling 7',  days: 7 },
  { key: '14d', label: 'Rolling 14', days: 14 },
  { key: '30d', label: 'Rolling 30', days: 30 },
  { key: 'all', label: 'Season',     days: null },
];

const DEFAULT_LOOKBACK_DAYS = 30;

// ---------- Aggregation helpers ----------

function pickTopNField(v: HitBacktestDayVersion, ranker: Ranker, n: 3 | 5 | 10 | 25) {
  const key = ranker === '1plus'
    ? (n === 3 ? 'top3_1plus' : n === 5 ? 'top5_1plus' : n === 10 ? 'top10_1plus' : 'top25_1plus')
    : (n === 3 ? 'top3_2plus' : n === 5 ? 'top5_2plus' : n === 10 ? 'top10_2plus' : 'top25_2plus');
  return v[key] as { hits: number; total: number; rate: number };
}
function baselineFor(v: HitBacktestDayVersion, ranker: Ranker): number {
  return ranker === '1plus' ? v.baseline_1plus : v.baseline_2plus;
}

interface WindowAgg {
  n_dates: number;
  top3_hits: number; top3_total: number;
  top5_hits: number; top5_total: number;
  top10_hits: number; top10_total: number;
  top25_hits: number; top25_total: number;
  baseline_mean: number;
}

function aggregateWindow(daily: HitBacktestDayVersion[], ranker: Ranker): WindowAgg {
  const enriched = daily.filter((d) => d.outcomes_enriched);
  const agg: WindowAgg = {
    n_dates: enriched.length,
    top3_hits: 0, top3_total: 0, top5_hits: 0, top5_total: 0,
    top10_hits: 0, top10_total: 0, top25_hits: 0, top25_total: 0,
    baseline_mean: 0,
  };
  if (enriched.length === 0) return agg;
  for (const d of enriched) {
    const t3 = pickTopNField(d, ranker, 3); agg.top3_hits += t3.hits; agg.top3_total += t3.total;
    const t5 = pickTopNField(d, ranker, 5); agg.top5_hits += t5.hits; agg.top5_total += t5.total;
    const t10 = pickTopNField(d, ranker, 10); agg.top10_hits += t10.hits; agg.top10_total += t10.total;
    const t25 = pickTopNField(d, ranker, 25); agg.top25_hits += t25.hits; agg.top25_total += t25.total;
    agg.baseline_mean += baselineFor(d, ranker);
  }
  agg.baseline_mean /= enriched.length;
  return agg;
}

function fmtPct(x: number): string { return Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—'; }
function fmtDelta(x: number): string {
  if (!Number.isFinite(x)) return '—';
  const s = (x * 100).toFixed(1);
  return x >= 0 ? '+' + s + 'pp' : s + 'pp';
}
function toneForRate(rate: number, baseline: number): 'good' | 'neutral' | 'weak' {
  if (!Number.isFinite(rate) || !Number.isFinite(baseline)) return 'neutral';
  if (rate >= baseline + 0.10) return 'good';
  if (rate <= baseline - 0.05) return 'weak';
  return 'neutral';
}
function toneColor(tone: 'good' | 'neutral' | 'weak'): string {
  return tone === 'good' ? 'var(--good)' : tone === 'weak' ? '#fca5a5' : 'var(--text)';
}

// ---------- Main page ----------

export default function HitsBacktest() {
  const [params, setParams] = useSearchParams();
  const today = mlbToday();
  const rangeTo = params.get('to') ?? mlbAddDays(today, -1);
  const rangeFrom = params.get('from') ?? mlbAddDays(rangeTo, -(DEFAULT_LOOKBACK_DAYS - 1));
  const ranker = (params.get('r') === '2plus' ? '2plus' : '1plus') as Ranker;
  const disagreementDate = params.get('dis') || null;

  const [range, setRange] = useState<HitBacktestRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [dis, setDis] = useState<HitDisagreementResult | null>(null);
  const [disLoading, setDisLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    fetchHitBacktestForRange(rangeFrom, rangeTo)
      .then((r) => { if (!cancelled) { setRange(r); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [rangeFrom, rangeTo]);

  useEffect(() => {
    if (!disagreementDate) { setDis(null); return; }
    let cancelled = false;
    setDisLoading(true);
    fetchHitDisagreement(disagreementDate, ranker, { topN: 10 })
      .then((d) => { if (!cancelled) { setDis(d); setDisLoading(false); } })
      .catch(() => { if (!cancelled) { setDis(null); setDisLoading(false); } });
    return () => { cancelled = true; };
  }, [disagreementDate, ranker]);

  function updateParam(k: string, v: string | null) {
    const next = new URLSearchParams(params);
    if (v == null) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  }

  // Group by version.
  const byVersion = useMemo(() => {
    const m = new Map<number, HitBacktestDayVersion[]>();
    if (range) for (const r of range.rows) {
      const arr = m.get(r.model_version) ?? []; arr.push(r); m.set(r.model_version, arr);
    }
    return m;
  }, [range]);

  const versions = HIT_MODEL_VERSIONS.map((v) => v.version);
  const versionLabels = new Map(HIT_MODEL_VERSIONS.map((v) => [v.version, v.label]));

  // Dates present across any version (union).
  const allDates = useMemo(() => {
    const s = new Set<string>();
    if (range) for (const r of range.rows) s.add(r.date);
    return [...s].sort();
  }, [range]);

  return (
    <div className="panel" style={{ padding: 14 }}>
      {/* ---- Header ---- */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--muted)' }}>
            Hits · Backtest · {rangeFrom} → {rangeTo}
          </h2>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
            v1 vs v2 side-by-side.{' '}
            <Link to="/hits" style={{ color: 'var(--accent-2)' }}>← back to board</Link>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>from</label>
          <input type="date" value={rangeFrom} onChange={(e) => updateParam('from', e.target.value)}
            style={dateInput()} />
          <label style={{ fontSize: 11, color: 'var(--muted)' }}>to</label>
          <input type="date" value={rangeTo} onChange={(e) => updateParam('to', e.target.value)}
            style={dateInput()} />
        </div>
      </div>

      {/* ---- Ranker toggle ---- */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={segGroup()}>
          {(['1plus', '2plus'] as const).map((r) => (
            <button key={r} onClick={() => updateParam('r', r)} style={segBtn(ranker === r)}>
              {r === '1plus' ? '1+ Hit' : '2+ Hits'}
            </button>
          ))}
        </div>
      </div>

      {loading && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      {err && (
        <div style={{ padding: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.30)', borderRadius: 6, color: '#fca5a5' }}>
          <strong>Failed:</strong> {err}
        </div>
      )}
      {!loading && !err && range && range.rows.length === 0 && (
        <div style={{ padding: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}>
          No hit_target_snapshots rows in this range. Backfill via{' '}
          <code style={{ background: 'var(--panel)', padding: '1px 4px', borderRadius: 3 }}>
            npm run backfill:hit-snapshots -- --from {rangeFrom} --to {rangeTo}
          </code>{' '}
          then rerun the enrichment.
        </div>
      )}

      {!loading && !err && range && range.rows.length > 0 && (
        <>
          {/* ---- Rolling summary ---- */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Rolling summaries ({ranker === '1plus' ? '1+ Hit' : '2+ Hits'})
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    <th style={{ padding: '5px 8px', textAlign: 'left' }}>window</th>
                    <th style={{ padding: '5px 8px', textAlign: 'left' }}>model</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>n dates</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>baseline</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>Top 3</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>abs lift</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>Top 5</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>abs lift</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>Top 10</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>abs lift</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>Top 25</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>abs lift</th>
                  </tr>
                </thead>
                <tbody>
                  {WINDOWS.map((w) => (
                    <RollingRows key={w.key} window={w} rangeTo={rangeTo} byVersion={byVersion} versions={versions} versionLabels={versionLabels} ranker={ranker} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- Daily table ---- */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Daily results ({ranker === '1plus' ? '1+ Hit' : '2+ Hits'}) — click a date to inspect v1↔v2 disagreements
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    <th style={{ padding: '5px 8px', textAlign: 'left' }}>date</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>baseline</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v1 T3</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v1 T5</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v1 T10</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v1 T25</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v2 T3</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v2 T5</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v2 T10</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right' }}>v2 T25</th>
                    <th style={{ padding: '5px 8px', textAlign: 'left' }}>type</th>
                  </tr>
                </thead>
                <tbody>
                  {allDates.map((d, idx) => {
                    const v1 = byVersion.get(1)?.find((r) => r.date === d);
                    const v2 = byVersion.get(2)?.find((r) => r.date === d);
                    const anyEnriched = (v1?.outcomes_enriched || v2?.outcomes_enriched) ?? false;
                    const zebra = idx % 2 === 0 ? 'var(--panel)' : 'var(--panel-2)';
                    const isSelected = d === disagreementDate;
                    const rowStyle: React.CSSProperties = {
                      background: isSelected ? 'rgba(255,209,102,0.08)' : zebra,
                      cursor: 'pointer',
                    };
                    const type = v1?.snapshot_type ?? v2?.snapshot_type ?? '—';
                    return (
                      <tr key={d} style={rowStyle} onClick={() => updateParam('dis', isSelected ? null : d)}>
                        <td style={{ padding: '5px 8px' }}>{d}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--muted)' }}>
                          {anyEnriched ? fmtPct(baselineFor(v1 ?? v2!, ranker)) : '—'}
                        </td>
                        {[3, 5, 10, 25].map((n) => renderDayTopCell(v1, n as 3 | 5 | 10 | 25, ranker, 'v1'))}
                        {[3, 5, 10, 25].map((n) => renderDayTopCell(v2, n as 3 | 5 | 10 | 25, ranker, 'v2'))}
                        <td style={{ padding: '5px 8px', color: 'var(--muted)', fontSize: 11 }}>{type}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- Disagreement view ---- */}
          {disagreementDate && (
            <DisagreementSection
              date={disagreementDate}
              ranker={ranker}
              dis={dis}
              loading={disLoading}
              onClose={() => updateParam('dis', null)}
            />
          )}
        </>
      )}
    </div>
  );
}

// ---------- Rolling summary rows ----------

function RollingRows({
  window,
  rangeTo,
  byVersion,
  versions,
  versionLabels,
  ranker,
}: {
  window: { key: WindowKey; label: string; days: number | null };
  rangeTo: string;
  byVersion: Map<number, HitBacktestDayVersion[]>;
  versions: number[];
  versionLabels: Map<number, string>;
  ranker: Ranker;
}) {
  const cutoff = window.days == null ? null : mlbAddDays(rangeTo, -(window.days - 1));
  return (
    <>
      {versions.map((ver, i) => {
        const rows = (byVersion.get(ver) ?? []).filter((r) => cutoff == null || r.date >= cutoff);
        const agg = aggregateWindow(rows, ranker);
        const label = versionLabels.get(ver) ?? `v${ver}`;
        const cells: React.ReactNode[] = [];
        for (const n of [3, 5, 10, 25] as const) {
          const hits = agg[`top${n}_hits` as const];
          const total = agg[`top${n}_total` as const];
          const rate = total > 0 ? hits / total : 0;
          const lift = rate - agg.baseline_mean;
          const tone = toneForRate(rate, agg.baseline_mean);
          cells.push(
            <td key={`${n}-rate`} style={{ padding: '5px 8px', textAlign: 'right', color: toneColor(tone), fontWeight: tone === 'good' ? 600 : 500 }}>
              {agg.n_dates === 0 ? '—' : `${hits}/${total} ${fmtPct(rate)}`}
            </td>,
            <td key={`${n}-lift`} style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--muted)' }}>
              {agg.n_dates === 0 ? '—' : fmtDelta(lift)}
            </td>,
          );
        }
        return (
          <tr key={ver} style={{ background: i % 2 === 0 ? 'var(--panel)' : 'var(--panel-2)' }}>
            {i === 0 && (
              <td rowSpan={versions.length} style={{ padding: '5px 8px', color: 'var(--muted)', verticalAlign: 'top', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, background: 'var(--panel)' }}>
                {window.label}
              </td>
            )}
            <td style={{ padding: '5px 8px' }}>{label}</td>
            <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--muted)' }}>{agg.n_dates}</td>
            <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--muted)' }}>{agg.n_dates === 0 ? '—' : fmtPct(agg.baseline_mean)}</td>
            {cells}
          </tr>
        );
      })}
    </>
  );
}

// ---------- Daily row cell (top-N for one version) ----------

function renderDayTopCell(v: HitBacktestDayVersion | undefined, n: 3 | 5 | 10 | 25, ranker: Ranker, ver: 'v1' | 'v2') {
  if (!v || !v.outcomes_enriched) {
    return <td key={ver + n} style={{ padding: '5px 8px', textAlign: 'right', color: '#4b5878' }}>—</td>;
  }
  const t = pickTopNField(v, ranker, n);
  const baseline = baselineFor(v, ranker);
  const tone = toneForRate(t.rate, baseline);
  return (
    <td key={ver + n} style={{ padding: '5px 8px', textAlign: 'right', color: toneColor(tone), fontWeight: tone === 'good' ? 600 : 500 }}>
      {t.hits}/{t.total}
    </td>
  );
}

// ---------- Disagreement section ----------

function DisagreementSection({
  date, ranker, dis, loading, onClose,
}: {
  date: string; ranker: Ranker; dis: HitDisagreementResult | null; loading: boolean; onClose: () => void;
}) {
  return (
    <div style={{ marginTop: 14, padding: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            v1 ↔ v2 disagreement · {date} · {ranker === '1plus' ? '1+ Hit' : '2+ Hits'} · Top 10
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            Where each model is finding hitters the other buries. Outcomes shown when enriched.
          </div>
        </div>
        <button onClick={onClose} style={{
          background: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
          color: 'var(--muted)', fontSize: 11, padding: '3px 8px', cursor: 'pointer',
        }}>close</button>
      </div>
      {loading && <p style={{ color: 'var(--muted)', fontSize: 12 }}>Loading disagreement…</p>}
      {!loading && dis && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <DisagreementList title="v2 finds these — v1 does not" tone="good" players={dis.v2_only} showRank={{ primary: 'v2', secondary: 'v1' }} outcomesEnriched={dis.outcomes_enriched} />
          <DisagreementList title="v1 finds these — v2 does not" tone="warn" players={dis.v1_only} showRank={{ primary: 'v1', secondary: 'v2' }} outcomesEnriched={dis.outcomes_enriched} />
          <DisagreementList title="Both models agree (shared Top 10)" tone="neutral" players={dis.shared} showRank={{ primary: 'v1', secondary: 'v2' }} outcomesEnriched={dis.outcomes_enriched} />
        </div>
      )}
      {!loading && !dis && (
        <p style={{ color: '#fca5a5', fontSize: 12 }}>No disagreement data available for {date}.</p>
      )}
    </div>
  );
}

function DisagreementList({
  title, tone, players, showRank, outcomesEnriched,
}: {
  title: string;
  tone: 'good' | 'warn' | 'neutral';
  players: HitDisagreementPlayer[];
  showRank: { primary: 'v1' | 'v2'; secondary: 'v1' | 'v2' };
  outcomesEnriched: boolean;
}) {
  const accent = tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--accent-2)' : 'var(--muted)';
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: 8 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: accent, fontWeight: 700, marginBottom: 6 }}>
        {title}  ({players.length})
      </div>
      {players.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>— none —</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              <th style={{ padding: '3px 6px', textAlign: 'left' }}>player</th>
              <th style={{ padding: '3px 6px', textAlign: 'right' }}>{showRank.primary}</th>
              <th style={{ padding: '3px 6px', textAlign: 'right' }}>{showRank.secondary}</th>
              <th style={{ padding: '3px 6px', textAlign: 'right' }}>Δ</th>
              {outcomesEnriched && <th style={{ padding: '3px 6px', textAlign: 'center' }}>result</th>}
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const primaryRank = showRank.primary === 'v1' ? p.rank_v1 : p.rank_v2;
              const secondaryRank = showRank.secondary === 'v1' ? p.rank_v1 : p.rank_v2;
              return (
                <tr key={p.player_id}>
                  <td style={{ padding: '3px 6px' }}>
                    <span style={{ color: 'var(--text)', fontWeight: 500 }}>{p.player_name}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 4 }}>{p.team}</span>
                  </td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{primaryRank ?? '—'}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{secondaryRank ?? '—'}</td>
                  <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {p.rank_diff == null ? '—' : (p.rank_diff > 0 ? '+' : '') + p.rank_diff}
                  </td>
                  {outcomesEnriched && (
                    <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                      {p.hits == null ? <span style={{ color: '#4b5878' }}>—</span> :
                        <span style={{
                          background: p.hit_success ? 'rgba(74,222,128,0.15)' : 'rgba(133,147,184,0.08)',
                          color: p.hit_success ? 'var(--good)' : 'var(--muted)',
                          padding: '1px 5px', borderRadius: 3, fontSize: 11, fontWeight: p.hit_success ? 700 : 500,
                          border: `1px solid ${p.hit_success ? 'rgba(74,222,128,0.3)' : 'rgba(133,147,184,0.2)'}`,
                        }}>{p.hits}H</span>
                      }
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Style helpers ----------

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
    border: 'none', borderRadius: 4,
    fontSize: 12, fontWeight: active ? 700 : 500,
    cursor: active ? 'default' : 'pointer',
  };
}
function dateInput(): React.CSSProperties {
  return {
    padding: '4px 8px', background: 'var(--panel-2)',
    border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)',
    fontSize: 12, colorScheme: 'dark',
  };
}
