import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { supabase, type HomeRunRow, type PlayerRow } from '../lib/supabase';
import { applyCanonicalTeams, computePlayerView, singlePlayerHandedness } from '../lib/stats';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const PAGE_SIZE = 1000;

/**
 * Fetch every HR row for a single player. Pages through the 1k Supabase
 * default. A single hitter will never come close to that, but we page
 * defensively so future seasons / multi-year history just works.
 */
async function fetchAllHrsForPlayer(playerId: number): Promise<HomeRunRow[]> {
  const all: HomeRunRow[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('home_runs')
      .select('*')
      .eq('player_id', playerId)
      .order('game_date', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as HomeRunRow[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

export default function PlayerDetail() {
  const { playerId } = useParams<{ playerId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Anchor: ?asOf=YYYY-MM-DD if present, else today. Lets the dashboard
  // hand off its current "as of" context without losing it on navigate.
  const asOfFromUrl = searchParams.get('asOf');
  const [asOf, setAsOf] = useState<string>(asOfFromUrl ?? todayISO());

  const [allHrs, setAllHrs] = useState<HomeRunRow[]>([]);
  const [playerRow, setPlayerRow] = useState<PlayerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- fetch every HR for this player + the canonical players row ----
  useEffect(() => {
    if (!playerId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const id = Number(playerId);

    Promise.all([
      fetchAllHrsForPlayer(id),
      // Soft fetch: if players hasn't been enriched yet, we just don't get
      // canonical team / name — the page still renders using HR-derived values.
      supabase
        .from('players')
        .select('*')
        .eq('player_id', id)
        .maybeSingle()
        .then(({ data, error: pErr }) => {
          if (pErr) {
            // soft fail — log but don't propagate
            // eslint-disable-next-line no-console
            console.warn('[PlayerDetail] players fetch failed:', pErr.message);
            return null;
          }
          return (data as PlayerRow | null) ?? null;
        }),
    ])
      .then(([rows, player]) => {
        if (cancelled) return;
        setAllHrs(rows);
        setPlayerRow(player);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  // Build a 1-entry index for this player so applyCanonicalTeams remaps team
  // strings in the log to the canonical MLB team. If no canonical row exists,
  // canonical map is empty and rows pass through.
  const playerOnlyIndex = useMemo(() => {
    if (!playerRow || !playerRow.current_team_name) return new Map();
    return new Map([[playerRow.player_id, { team: playerRow.current_team_name, full_name: playerRow.full_name }]]);
  }, [playerRow]);

  const canonHrs = useMemo(() => applyCanonicalTeams(allHrs, playerOnlyIndex), [allHrs, playerOnlyIndex]);

  // ---- compute everything from raw HRs ----
  // This is the SAME math the dashboard uses (computePlayerView delegates
  // to the same date logic). PlayerDetail and Dashboard cannot disagree.
  const view = useMemo(() => computePlayerView(canonHrs, asOf), [canonHrs, asOf]);
  const handedness = useMemo(() => singlePlayerHandedness(canonHrs, asOf), [canonHrs, asOf]);

  // Display name + team prefer the canonical players row, then fall back to
  // computePlayerView's most-recent-row values, then a plain ID label.
  const displayName = playerRow?.full_name ?? view.player_name;
  const displayTeam = playerRow?.current_team_name ?? view.team;

  // Sync asOf back to URL so the user can bookmark / share
  function changeAsOf(d: string) {
    setAsOf(d);
    const next = new URLSearchParams(searchParams);
    next.set('asOf', d);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <Link to={`/?asOf=${asOf}`}>← Back to dashboard</Link>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
          <span>As of</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => changeAsOf(e.target.value)}
            style={{
              background: 'var(--panel)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 8px',
            }}
          />
        </label>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <div className="subtle">Loading…</div>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ color: 'var(--text)', textTransform: 'none', letterSpacing: 0, fontSize: 24 }}>
          {displayName}{' '}
          <span className="pill" style={{ marginLeft: 8 }}>{displayTeam}</span>
          {playerRow?.primary_position && (
            <span className="pill" style={{ marginLeft: 6 }}>{playerRow.primary_position}</span>
          )}
        </h2>
        <div className="subtle" style={{ marginTop: 4 }}>
          Rolling stats as of <strong>{asOf}</strong>. Values derive from <code>home_runs</code>.{' '}
          {playerRow ? (
            <>Team resolved from <code>players</code> (<em>current MLB team</em>).</>
          ) : (
            <>Team falls back to per-HR row (run <code>npm run enrich:players</code> for canonical team).</>
          )}
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <Stat label="Season HR" value={view.season_total} />
          <Stat label="HRs today" value={view.hrs_today} />
          <Stat label="Last 3 games" value={view.hrs_last_3_games} />
          <Stat label="Last 5 games" value={view.hrs_last_5_games} />
          <Stat label="Last 7 days" value={view.hrs_last_7_days} />
          <Stat label="Last 14 days" value={view.hrs_last_14_days} />
          <Stat label="Last HR date" value={view.last_hr_date ?? '—'} />
          <Stat label="Total HR rows" value={allHrs.length} />
        </div>
      </div>

      {/* ---- Handedness splits ---- */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Handedness splits (season-to-date)</h2>
        {handedness && (handedness.vs_lhp + handedness.vs_rhp) > 0 ? (
          <div className="grid" style={{ marginTop: 12 }}>
            <Stat label={`vs LHP${handedness.bat_side ? ` (${handedness.bat_side}HB)` : ''}`} value={handedness.vs_lhp} />
            <Stat label="vs RHP" value={handedness.vs_rhp} />
            <Stat label="vs LHP — last 30d" value={handedness.vs_lhp_l30d} />
            <Stat label="vs RHP — last 30d" value={handedness.vs_rhp_l30d} />
            {handedness.unknown > 0 && <Stat label="Unknown hand" value={handedness.unknown} />}
          </div>
        ) : (
          <div className="empty">
            No pitcher-handedness data on this player's HRs yet. Run <code>npm run enrich:handedness</code> to backfill.
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Full HR log ({canonHrs.length} rows)</h2>
        {canonHrs.length === 0 ? (
          <div className="empty">No home runs recorded for this player.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Team</th>
                  <th>Opp</th>
                  <th>Inn</th>
                  <th>Pitcher</th>
                  <th className="num">EV</th>
                  <th className="num">LA</th>
                  <th className="num">Dist</th>
                </tr>
              </thead>
              <tbody>
                {canonHrs.map((hr) => (
                  <tr
                    key={hr.id}
                    style={{
                      // dim out rows after asOf (kept visible for transparency,
                      // but they don't contribute to the stats above)
                      opacity: hr.game_date > asOf ? 0.45 : 1,
                    }}
                  >
                    <td>{hr.game_date}</td>
                    <td><span className="pill">{hr.team}</span></td>
                    <td><span className="pill">{hr.opponent}</span></td>
                    <td>{hr.inning ?? '—'}</td>
                    <td>{hr.pitcher_name ?? '—'}</td>
                    <td className="num">{hr.exit_velocity ?? '—'}</td>
                    <td className="num">{hr.launch_angle ?? '—'}</td>
                    <td className="num">{hr.distance != null ? Math.round(hr.distance) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <h2>{label}</h2>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
