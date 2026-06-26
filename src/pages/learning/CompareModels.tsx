/**
 * /learning/compare/:date — Side-by-side model comparison matrix.
 *
 * For each player who appeared in at least one model's Top 10:
 *   - rows = player
 *   - columns = v1..vN
 *   - cell = ✓ (in this model's Top 10 AND homered), ⚪ (Top 10 but no HR), · (not in Top 10)
 * Highlights unanimous picks, majority picks, unique picks.
 * Separate sub-grid for Safe / Value / Chaos parlay legs.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchAllVersionsForDate,
  fetchCapturedDates,
  fetchModelVersions,
  type LearningPredictionRow,
  type ModelVersionRow,
} from '../../lib/supabase';

type Filter = 'all' | 'top10' | 'safe' | 'value' | 'chaos';
type Highlight = 'all' | 'unanimous' | 'majority' | 'unique';

export default function CompareModelsPage() {
  const params = useParams<{ date: string }>();
  const date = params.date ?? '';
  const [predictions, setPredictions] = useState<LearningPredictionRow[]>([]);
  const [versions, setVersions] = useState<ModelVersionRow[]>([]);
  const [allDates, setAllDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('top10');
  const [highlight, setHighlight] = useState<Highlight>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const [preds, vs, dates] = await Promise.all([
          fetchAllVersionsForDate(date),
          fetchModelVersions(),
          fetchCapturedDates({ limit: 60 }),
        ]);
        if (cancelled) return;
        setPredictions(preds);
        setVersions(vs);
        setAllDates(dates);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  // Predicate: should this row be counted in the filter?
  function inFilter(p: LearningPredictionRow): boolean {
    switch (filter) {
      case 'all': return true;
      case 'top10': return p.rank != null && p.rank <= 10;
      case 'safe': return p.in_safe;
      case 'value': return p.in_value;
      case 'chaos': return p.in_chaos;
    }
  }

  // Build player → version → present
  type Cell = { in_filter: boolean; homered: boolean; rank: number | null };
  const matrix = useMemo(() => {
    const m = new Map<number, { player_name: string; team: string; perVersion: Map<number, Cell> }>();
    for (const p of predictions) {
      if (!inFilter(p)) continue;
      let row = m.get(p.player_id);
      if (!row) { row = { player_name: p.player_name, team: p.team, perVersion: new Map() }; m.set(p.player_id, row); }
      row.perVersion.set(p.model_version, { in_filter: true, homered: p.homered === true, rank: p.rank });
    }
    return m;
  }, [predictions, filter]);

  // Filter by highlight
  const filteredRows = useMemo(() => {
    const rows = Array.from(matrix.entries()).map(([pid, row]) => {
      const presentVersions = row.perVersion.size;
      const totalVersions = versions.length;
      return {
        player_id: pid,
        player_name: row.player_name,
        team: row.team,
        perVersion: row.perVersion,
        presentVersions,
        totalVersions,
        type: presentVersions === totalVersions ? 'unanimous' :
              presentVersions > totalVersions / 2 ? 'majority' :
              presentVersions === 1 ? 'unique' : 'minority',
        anyHomered: Array.from(row.perVersion.values()).some((c) => c.homered),
      };
    });

    let visible = rows;
    if (highlight === 'unanimous') visible = rows.filter((r) => r.type === 'unanimous');
    else if (highlight === 'majority') visible = rows.filter((r) => r.type === 'majority' || r.type === 'unanimous');
    else if (highlight === 'unique') visible = rows.filter((r) => r.type === 'unique');

    // Sort: HR hitters first, then by # of versions that picked them, then by name.
    return visible.sort((a, b) => {
      if (a.anyHomered !== b.anyHomered) return a.anyHomered ? -1 : 1;
      if (b.presentVersions !== a.presentVersions) return b.presentVersions - a.presentVersions;
      return a.player_name.localeCompare(b.player_name);
    });
  }, [matrix, versions, highlight]);

  // Counts for header
  const counts = useMemo(() => {
    const rows = Array.from(matrix.values());
    const totalV = versions.length;
    const unanimous = rows.filter((r) => r.perVersion.size === totalV).length;
    const majority = rows.filter((r) => r.perVersion.size > totalV / 2 && r.perVersion.size < totalV).length;
    const unique = rows.filter((r) => r.perVersion.size === 1).length;
    return { total: rows.length, unanimous, majority, unique };
  }, [matrix, versions]);

  const dateIndex = allDates.indexOf(date);
  const prevDate = dateIndex !== -1 && dateIndex < allDates.length - 1 ? allDates[dateIndex + 1] : null;
  const nextDate = dateIndex > 0 ? allDates[dateIndex - 1] : null;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <Link to="/learning" style={{ fontSize: 13 }}>← Learning Dashboard</Link>
        <h1 style={{ margin: 0, fontSize: 22 }}>⚖️ Compare — {date}</h1>
        {prevDate && <Link to={`/learning/compare/${prevDate}`} style={{ fontSize: 12 }}>← {prevDate}</Link>}
        {nextDate && <Link to={`/learning/compare/${nextDate}`} style={{ fontSize: 12 }}>{nextDate} →</Link>}
        <Link to={`/learning/day/${date}`} style={{ fontSize: 12, marginLeft: 'auto' }}>Per-version detail →</Link>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle">Loading…</div>}

      {!loading && predictions.length === 0 && (
        <div className="cm-panel">
          <p>No captures for {date}. Run capture + replay first.</p>
        </div>
      )}

      {!loading && predictions.length > 0 && (
        <div className="cm-panel">
          <div className="cm-controls">
            <div className="cm-btn-row">
              <span style={{ fontSize: 11, opacity: 0.7 }}>Filter:</span>
              {(['top10', 'safe', 'value', 'chaos', 'all'] as Filter[]).map((f) => (
                <button key={f} className={`cm-btn ${filter === f ? 'cm-btn--active' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'top10' ? 'Top 10' : f === 'all' ? 'All ranked' : f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <div className="cm-btn-row">
              <span style={{ fontSize: 11, opacity: 0.7 }}>Show:</span>
              {(['all', 'unanimous', 'majority', 'unique'] as Highlight[]).map((h) => (
                <button key={h} className={`cm-btn ${highlight === h ? 'cm-btn--active' : ''}`} onClick={() => setHighlight(h)}>
                  {h.charAt(0).toUpperCase() + h.slice(1)}
                  {h === 'unanimous' && ` (${counts.unanimous})`}
                  {h === 'majority' && ` (${counts.majority})`}
                  {h === 'unique' && ` (${counts.unique})`}
                </button>
              ))}
            </div>
          </div>

          <div className="cm-table-wrap" style={{ marginTop: 8 }}>
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Team</th>
                  {versions.map((v) => (
                    <th key={v.version} className="num" title={v.name}>v{v.version}</th>
                  ))}
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr key={r.player_id} className={`cm-row cm-row--${r.type}`}>
                    <td><strong>{r.player_name}</strong>{r.anyHomered && <span style={{ color: '#6bd482', marginLeft: 4 }}>HR</span>}</td>
                    <td>{r.team}</td>
                    {versions.map((v) => {
                      const cell = r.perVersion.get(v.version);
                      const present = cell?.in_filter ?? false;
                      const homered = cell?.homered ?? false;
                      const sym = present
                        ? (homered ? '✓' : (filter === 'top10' ? `#${cell?.rank}` : '○'))
                        : '·';
                      const color = present ? (homered ? '#6bd482' : '#cfe') : '#444';
                      return (
                        <td key={v.version} className="num" style={{ color, fontWeight: present ? 700 : 400 }}>
                          {sym}
                        </td>
                      );
                    })}
                    <td>
                      <span className={`cm-verdict cm-verdict--${r.type}`}>
                        {r.type === 'unanimous' ? `Unanimous (${r.presentVersions}/${r.totalVersions})`
                          : r.type === 'majority' ? `Majority (${r.presentVersions}/${r.totalVersions})`
                            : r.type === 'unique' ? `Unique to one model`
                              : `Minority (${r.presentVersions}/${r.totalVersions})`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="subtle" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
            <strong>How to read:</strong> ✓ = model included this player AND they homered. ○ = included but missed.
            #N = rank in Top 10 (when Top-10 filter is active). · = not included by this model. HR badge = player actually homered.
            Unanimous picks = every model agreed. Unique picks = only one model spotted them.
          </p>
        </div>
      )}

      <CompareModelsStyles />
    </>
  );
}

function CompareModelsStyles() {
  return (
    <style>{`
      .cm-panel {
        background: var(--panel, #11141c); border: 1px solid var(--border, #232732);
        border-radius: 10px; padding: 12px 14px;
      }
      .cm-controls { display: grid; gap: 6px; }
      .cm-btn-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .cm-btn {
        background: var(--panel-2, #14171f); border: 1px solid var(--border, #232732);
        color: #cfe; padding: 3px 9px; border-radius: 6px; font-size: 11px; cursor: pointer;
      }
      .cm-btn--active { background: #2d3a52; border-color: #4a6fa5; color: #fff; font-weight: 700; }

      .cm-table-wrap { overflow-x: auto; }
      .cm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .cm-table th, .cm-table td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border, #1f2330); white-space: nowrap; }
      .cm-table th.num, .cm-table td.num { text-align: right; }
      .cm-row--unanimous td { background: rgba(192,132,252,0.07); }
      .cm-row--unique td { background: rgba(255,210,140,0.05); }
      .cm-verdict {
        display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .cm-verdict--unanimous { background: rgba(192,132,252,0.20); color: #c084fc; }
      .cm-verdict--majority  { background: rgba(76,199,255,0.18); color: #4cc7ff; }
      .cm-verdict--unique    { background: rgba(255,210,140,0.18); color: #ffd28c; }
      .cm-verdict--minority  { background: rgba(170,177,192,0.15); color: #aab1c0; }
    `}</style>
  );
}
