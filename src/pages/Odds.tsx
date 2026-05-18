/**
 * /odds — Phase 1 HR-prop odds tracker.
 *
 * Day-over-day model (free-tier-friendly):
 *   We only take ONE snapshot per day (morning) on the free tier of The Odds
 *   API. Intra-day movement (morning → midday → pregame) can't be tracked
 *   without 3× the credit burn. Instead we compare TODAY's morning snapshot
 *   against YESTERDAY's morning snapshot for the same (player, book) and
 *   show the day-over-day delta. That's a meaningful signal: it tells you
 *   whether the market is sharpening or fading a player relative to their
 *   prior-day price.
 *
 * Columns:
 *   - Player / Team / Opp / Book
 *   - Today (today's latest snapshot)
 *   - Yesterday (latest snapshot from target_date - 1)
 *   - Change (implied prob delta — green=shortened, red=drifted)
 *   - Heat Score / Confidence / Implied / Model / Edge
 *
 * Sorting:
 *   - movement (biggest |day-over-day change|, default)
 *   - shortest odds
 *   - best Heat Score
 *   - best Edge
 *
 * Mobile: `.table-wrap` overflow handles narrow viewports.
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
  /** Today's latest snapshot for this (player, book) — always present. */
  today: OddsSnapshotRow;
  /** Yesterday's latest snapshot for the same (player, book). Null on day 1
   *  or for players who weren't in yesterday's slate. */
  yesterday: OddsSnapshotRow | null;
  /** today.american - yesterday.american. Positive American value means
   *  odds got LONGER (less likely per the book); negative means SHORTER.
   *  American sign-flips around zero make this less intuitive than
   *  delta_implied — prefer that one for sorting/coloring. */
  delta_american: number | null;
  /** today.implied_prob - yesterday.implied_prob. Positive = market shortened
   *  (player more likely to homer per book); negative = drifted. */
  delta_implied: number | null;
}

/**
 * Group today's + yesterday's odds rows by (player_id, book) and stitch
 * them into a row that can show day-over-day movement. Yesterday-only
 * rows (player not in today's slate) are dropped — we always anchor on
 * a player who has a TODAY snapshot.
 */
function aggregateRows(
  todayRows: OddsSnapshotRow[],
  yesterdayRows: OddsSnapshotRow[],
): AggRow[] {
  // Helper: pick the LATEST row per (player_id, book) within a slice.
  function latestByKey(rows: OddsSnapshotRow[]): Map<string, OddsSnapshotRow> {
    const out = new Map<string, OddsSnapshotRow>();
    const sorted = rows.slice().sort((a, b) => (a.snapshot_time < b.snapshot_time ? -1 : 1));
    for (const r of sorted) {
      if (r.player_id == null) continue;
      out.set(`${r.player_id}-${r.book}`, r); // last write wins → latest
    }
    return out;
  }

  const todayMap = latestByKey(todayRows);
  const yesterdayMap = latestByKey(yesterdayRows);

  const out: AggRow[] = [];
  for (const [key, today] of todayMap) {
    const yesterday = yesterdayMap.get(key) ?? null;
    const delta_american = yesterday ? today.american_odds - yesterday.american_odds : null;
    const delta_implied = yesterday ? today.implied_prob - yesterday.implied_prob : null;
    out.push({
      key,
      player_id: today.player_id!,
      player_name: today.player_name,
      team: today.team,
      opponent: today.opponent,
      book: today.book,
      game_pk: today.game_pk,
      today,
      yesterday,
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

/** Human label for a day-over-day delta. e.g. +0.022 → "Shortened (+2.2%)" */
function movementLabel(deltaImplied: number | null, deltaAmerican: number | null): string {
  if (deltaImplied == null || deltaAmerican == null) return 'No prior-day line';
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
  const [yesterdayRows, setYesterdayRows] = useState<OddsSnapshotRow[]>([]);
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
    // Fetch today + yesterday in parallel so we can compute day-over-day deltas.
    const yesterday = addDays(targetDate, -1);
    Promise.all([fetchOddsSnapshots(targetDate), fetchOddsSnapshots(yesterday)])
      .then(([t, y]) => {
        if (!cancelled) { setRows(t); setYesterdayRows(y); }
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [targetDate, refreshKey]);

  const allBooks = useMemo(() => Array.from(new Set(rows.map((r) => r.book))).sort(), [rows]);
  const filteredToday = useMemo(() => (book ? rows.filter((r) => r.book === book) : rows), [rows, book]);
  const filteredYesterday = useMemo(
    () => (book ? yesterdayRows.filter((r) => r.book === book) : yesterdayRows),
    [yesterdayRows, book],
  );

  const agg = useMemo(
    () => aggregateRows(filteredToday, filteredYesterday),
    [filteredToday, filteredYesterday],
  );

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
      // Most "favored to homer" = lowest American price.
      c.sort((a, b) => a.today.american_odds - b.today.american_odds);
    } else if (sortKey === 'heat') {
      c.sort((a, b) => (b.today.heat_score ?? -Infinity) - (a.today.heat_score ?? -Infinity));
    } else {
      // edge
      c.sort((a, b) => (b.today.edge ?? -Infinity) - (a.today.edge ?? -Infinity));
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
      const e = r.today.edge;
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
          API free-tier quota. Movement is tracked <strong>day-over-day</strong> instead of intra-day —
          we compare today's morning line to yesterday's morning line for the same (player, book).
          Edit <code>scripts/lib/oddsCron.ts</code> to enable intra-day snapshots on a paid tier.
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
                  <th className="num">Today</th>
                  <th className="num">Yesterday</th>
                  <th>Change (day-over-day)</th>
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
                    <td className="num"><strong>{formatAmerican(r.today.american_odds)}</strong></td>
                    <td className="num">{r.yesterday ? formatAmerican(r.yesterday.american_odds) : '—'}</td>
                    <td style={{ color: movementColor(r.delta_implied), fontSize: 12, whiteSpace: 'nowrap' }}>
                      {movementLabel(r.delta_implied, r.delta_american)}
                    </td>
                    <td className="num">{r.today.heat_score != null ? r.today.heat_score.toFixed(1) : '—'}</td>
                    <td className="num">{r.today.confidence ?? '—'}</td>
                    <td className="num">{formatPct(r.today.implied_prob)}</td>
                    <td className="num">{formatPct(r.today.model_prob)}</td>
                    <td className="num" style={{ color: (r.today.edge ?? 0) > 0 ? 'var(--good, #4cd97a)' : (r.today.edge ?? 0) < 0 ? '#ff8d8d' : undefined }}>
                      {formatEdge(r.today.edge)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="subtle" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
            Change compares today's morning snapshot against yesterday's morning snapshot's
            implied probability for the same (player, book). <strong style={{ color: 'var(--good, #4cd97a)' }}>Green</strong> = market shortened the player day-over-day (more confident);{' '}
            <strong style={{ color: '#ff8d8d' }}>red</strong> = drifted (less confident); <em>"No prior-day line"</em> means the player wasn't on yesterday's slate or wasn't snapshotted yet.
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
