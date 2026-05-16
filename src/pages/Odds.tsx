/**
 * /odds — Phase 1 HR-prop odds tracker.
 *
 * What this page shows:
 *   - For each (player, book) on the target date, the morning / midday /
 *     pregame / current snapshots stitched together.
 *   - Player, Team, Opponent, Current odds, Morning odds, Δ (movement)
 *   - Heat Score, Confidence, Weather boost (if any)
 *   - Implied probability, Model probability, Edge (Model − Market)
 *
 * What this page DOES NOT do (per user spec):
 *   - Influence the HR ranking model
 *   - Make betting recommendations
 *
 * Visual rules:
 *   - Green delta  → odds shortened (e.g. +600 → +450); market is more confident
 *   - Red delta    → odds drifted (e.g. +500 → +650); market is less confident
 *   - Neutral gray → unchanged or no morning baseline yet
 *
 * Sorting (column headers click to toggle):
 *   - movement (default)
 *   - shortest odds
 *   - best Heat Score
 *   - best Edge
 *
 * Mobile: the table uses overflow-x scroll inside `.table-wrap` so the
 * full column set is reachable. The summary "Model vs Market" cards
 * stack vertically.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { fetchOddsSnapshots, type OddsSnapshotRow } from '../lib/supabase';
import { mlbToday, addDays } from '../lib/mlbDate';
import { useRevalidationKey } from '../lib/useRevalidationKey';
import {
  formatAmerican,
  formatPct,
  formatEdge,
} from '../lib/oddsMath';

const todayISO = mlbToday;

type SortKey = 'movement' | 'shortestOdds' | 'heat' | 'edge';

interface AggRow {
  key: string;                 // player_id + book
  player_id: number;
  player_name: string;
  team: string | null;
  opponent: string | null;
  book: string;
  game_pk: number;
  morning: OddsSnapshotRow | null;
  midday: OddsSnapshotRow | null;
  pregame: OddsSnapshotRow | null;
  /** The freshest snapshot for the row — used as "current odds". */
  current: OddsSnapshotRow;
  /** Movement = morning_american - current_american. Positive = shortened
   *  if both are positive American; negative = drifted (we render with
   *  a sign that matches what the user sees on a sportsbook). */
  delta_american: number | null;
  /** Implied probability delta (current - morning). Positive = market thinks
   *  HR more likely now than at morning. Cleaner than American-delta for
   *  cross-sign comparisons. */
  delta_implied: number | null;
}

function aggregateRows(rows: OddsSnapshotRow[]): AggRow[] {
  // Group by (player_id, book).
  const groups = new Map<string, OddsSnapshotRow[]>();
  for (const r of rows) {
    if (r.player_id == null) continue;        // Phase 1 ignores unmatched names
    const k = `${r.player_id}-${r.book}`;
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(r);
  }

  const out: AggRow[] = [];
  for (const [key, arr] of groups) {
    // Sort by snapshot_time so `current` is freshest.
    arr.sort((a, b) => (a.snapshot_time < b.snapshot_time ? -1 : 1));
    const morning = arr.find((r) => r.snapshot_type === 'morning') ?? null;
    const midday  = arr.find((r) => r.snapshot_type === 'midday')  ?? null;
    const pregame = arr.find((r) => r.snapshot_type === 'pregame') ?? null;
    const current = arr[arr.length - 1];
    const delta_american =
      morning != null ? current.american_odds - morning.american_odds : null;
    const delta_implied =
      morning != null ? current.implied_prob - morning.implied_prob : null;

    out.push({
      key,
      player_id: current.player_id!,
      player_name: current.player_name,
      team: current.team,
      opponent: current.opponent,
      book: current.book,
      game_pk: current.game_pk,
      morning, midday, pregame, current,
      delta_american,
      delta_implied,
    });
  }
  return out;
}

/** Color a movement value. "Shortening" = positive implied-delta = green. */
function movementColor(deltaImplied: number | null): string | undefined {
  if (deltaImplied == null || deltaImplied === 0) return undefined;
  if (deltaImplied > 0.005) return 'var(--good, #4cd97a)';     // ≥ +0.5 pct → green
  if (deltaImplied < -0.005) return '#ff8d8d';                 // ≤ -0.5 pct → red
  return undefined;
}

/** Human label for a delta. e.g. +0.022 → "Shortened (+2.2%)" */
function movementLabel(deltaImplied: number | null, deltaAmerican: number | null): string {
  if (deltaImplied == null || deltaAmerican == null) return 'No morning line yet';
  if (Math.abs(deltaImplied) < 0.005) return 'Unchanged';
  const dir = deltaImplied > 0 ? 'Shortened' : 'Drifted';
  const sign = deltaImplied > 0 ? '+' : '';
  return `${dir} (${sign}${(deltaImplied * 100).toFixed(1)}%)`;
}

export default function Odds() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [targetDate, setTargetDateState] = useState<string>(searchParams.get('date') ?? todayISO());
  const [book, setBook] = useState<string>(searchParams.get('book') ?? '');
  const [sortKey, setSortKey] = useState<SortKey>('movement');
  const [rows, setRows] = useState<OddsSnapshotRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshKey = useRevalidationKey();

  function setTargetDate(d: string) {
    setTargetDateState(d);
    const p = new URLSearchParams(searchParams);
    p.set('date', d);
    setSearchParams(p, { replace: true });
  }
  function setBookFilter(b: string) {
    setBook(b);
    const p = new URLSearchParams(searchParams);
    if (b) p.set('book', b); else p.delete('book');
    setSearchParams(p, { replace: true });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOddsSnapshots(targetDate)
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [targetDate, refreshKey]);

  const allBooks = useMemo(() => Array.from(new Set(rows.map((r) => r.book))).sort(), [rows]);
  const filteredRows = useMemo(() => (book ? rows.filter((r) => r.book === book) : rows), [rows, book]);

  const agg = useMemo(() => aggregateRows(filteredRows), [filteredRows]);

  const sorted = useMemo(() => {
    const c = agg.slice();
    if (sortKey === 'movement') {
      c.sort((a, b) => {
        const ai = a.delta_implied ?? 0;
        const bi = b.delta_implied ?? 0;
        // Biggest absolute movement first.
        return Math.abs(bi) - Math.abs(ai);
      });
    } else if (sortKey === 'shortestOdds') {
      // Most "favored to homer" = lowest American-implied price.
      // For HR props that's typically the smallest positive odds.
      c.sort((a, b) => a.current.american_odds - b.current.american_odds);
    } else if (sortKey === 'heat') {
      c.sort((a, b) => (b.current.heat_score ?? -Infinity) - (a.current.heat_score ?? -Infinity));
    } else {
      // edge
      c.sort((a, b) => (b.current.edge ?? -Infinity) - (a.current.edge ?? -Infinity));
    }
    return c;
  }, [agg, sortKey]);

  // Summary tiles
  const totals = useMemo(() => {
    let shortened = 0, drifted = 0, unchanged = 0;
    let edgePos = 0, edgeNeg = 0;
    for (const r of agg) {
      const d = r.delta_implied;
      if (d == null) continue;
      if (d > 0.005) shortened++;
      else if (d < -0.005) drifted++;
      else unchanged++;
      const e = r.current.edge;
      if (e == null) continue;
      if (e > 0) edgePos++;
      else if (e < 0) edgeNeg++;
    }
    return { shortened, drifted, unchanged, edgePos, edgeNeg };
  }, [agg]);

  const today = todayISO();
  const yesterday = addDays(today, -1);

  return (
    <>
      <div className="kpi-strip" style={{ marginBottom: 12 }}>
        <Kpi label="Target date" value={targetDate} />
        <Kpi label="Players × books" value={agg.length} />
        <Kpi label="Shortened" value={totals.shortened} />
        <Kpi label="Drifted" value={totals.drifted} />
      </div>

      <div className="filters" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="filter-presets">
          <button type="button" onClick={() => setTargetDate(today)} aria-pressed={targetDate === today}>Today</button>
          <button type="button" onClick={() => setTargetDate(yesterday)} aria-pressed={targetDate === yesterday}>Yesterday</button>
        </div>
        <label>
          <span>Custom date</span>
          <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </label>
        <label>
          <span>Book</span>
          <select value={book} onChange={(e) => setBookFilter(e.target.value)}>
            <option value="">All books</option>
            {allBooks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <Link to="/targets" style={{ alignSelf: 'end', marginLeft: 'auto', fontSize: 13 }}>HR Targets →</Link>
      </div>

      <div className="panel" style={{ marginBottom: 12, background: 'var(--panel-2)', borderColor: 'var(--accent)' }}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--accent-2)' }}>Phase 1 — research only.</strong>{' '}
          Sportsbook odds are tracked for comparison against the model's Heat Score. They do NOT
          influence the ranking. Model probability is derived from Heat Score via a tuned sigmoid
          (see <code>src/lib/oddsMath.ts</code>). "Edge" = model_prob − implied_prob.
        </div>
        <div className="subtle" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>
          Cadence: one <strong>morning</strong> snapshot per day (PT 7–11) to fit inside The Odds
          API free-tier quota. Midday / pregame columns will stay empty until a paid tier is wired —
          edit <code>scripts/lib/oddsCron.ts</code> to enable them.
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle" style={{ marginBottom: 12 }}>Loading odds for {targetDate}…</div>}

      {!loading && agg.length === 0 && !error && (
        <div className="panel">
          <h2>No odds snapshots for {targetDate}</h2>
          <p className="subtle" style={{ marginTop: 6 }}>
            Either the cron hasn't taken a snapshot yet today, the migration
            <code> 011_odds_snapshots.sql</code> hasn't been applied, or{' '}
            <code>ODDS_API_KEY</code> isn't set in the Vercel env. Run{' '}
            <code>npm run snapshot:odds</code> locally to populate today, or
            wait for the cron's morning / midday / pregame window.
          </p>
        </div>
      )}

      {!loading && agg.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <SortButton current={sortKey} onClick={setSortKey} value="movement">Biggest movement</SortButton>
            <SortButton current={sortKey} onClick={setSortKey} value="shortestOdds">Shortest odds</SortButton>
            <SortButton current={sortKey} onClick={setSortKey} value="heat">Best Heat Score</SortButton>
            <SortButton current={sortKey} onClick={setSortKey} value="edge">Best edge</SortButton>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Opp</th>
                  <th>Book</th>
                  <th className="num">Morning</th>
                  <th className="num">Midday</th>
                  <th className="num">Pregame</th>
                  <th className="num">Current</th>
                  <th>Movement</th>
                  <th className="num">Heat</th>
                  <th className="num">Conf</th>
                  <th className="num">Implied</th>
                  <th className="num">Model</th>
                  <th className="num">Edge</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <Link className="player-link" to={`/player/${r.player_id}?asOf=${targetDate}`}>
                        {r.player_name}
                      </Link>
                    </td>
                    <td><span className="pill">{r.team ?? '—'}</span></td>
                    <td className="subtle" style={{ fontSize: 12 }}>vs {r.opponent ?? '—'}</td>
                    <td className="subtle" style={{ fontSize: 12 }}>{r.book}</td>
                    <td className="num">{r.morning ? formatAmerican(r.morning.american_odds) : '—'}</td>
                    <td className="num">{r.midday ? formatAmerican(r.midday.american_odds) : '—'}</td>
                    <td className="num">{r.pregame ? formatAmerican(r.pregame.american_odds) : '—'}</td>
                    <td className="num"><strong>{formatAmerican(r.current.american_odds)}</strong></td>
                    <td style={{ color: movementColor(r.delta_implied), fontSize: 12, whiteSpace: 'nowrap' }}>
                      {movementLabel(r.delta_implied, r.delta_american)}
                    </td>
                    <td className="num">{r.current.heat_score != null ? r.current.heat_score.toFixed(1) : '—'}</td>
                    <td className="num">{r.current.confidence ?? '—'}</td>
                    <td className="num">{formatPct(r.current.implied_prob)}</td>
                    <td className="num">{formatPct(r.current.model_prob)}</td>
                    <td className="num" style={{ color: (r.current.edge ?? 0) > 0 ? 'var(--good, #4cd97a)' : (r.current.edge ?? 0) < 0 ? '#ff8d8d' : undefined }}>
                      {formatEdge(r.current.edge)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
            Movement compares <strong>current</strong> against the <strong>morning</strong> snapshot's
            implied probability. Green = market shortened (more confident); red = drifted (less confident).
            Edge column = our model_prob (sigmoid of Heat Score) − the book's implied_prob;{' '}
            <strong>positive ≠ a bet recommendation</strong>, it just means the model disagrees with the market.
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}

function SortButton({
  current,
  value,
  onClick,
  children,
}: {
  current: SortKey;
  value: SortKey;
  onClick: (s: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      aria-pressed={active}
      style={{
        padding: '4px 10px',
        borderRadius: 6,
        fontSize: 12,
        background: active ? 'var(--accent, #4a90e2)' : 'var(--panel-2)',
        color: active ? 'white' : 'var(--text)',
        border: `1px solid ${active ? 'var(--accent, #4a90e2)' : 'var(--border)'}`,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
