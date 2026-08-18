/**
 * HitsBoard — compact dark-theme ranked list for one of the two Hits
 * rankers (1+ or 2+). Visual pass — no scoring logic here.
 *
 * Matches the rest of the app: dark navy rows, high-contrast text,
 * bold player names, muted secondaries, chip overflow, thin game
 * dividers. All colours pulled from the CSS variables in index.css.
 */
import { Link } from 'react-router-dom';
import type { HitBoardRow } from '../lib/supabase';

type Ranker = '1plus' | '2plus';

interface Props {
  rows: HitBoardRow[];
  ranker: Ranker;
  limit: number;
  showOutcomeBadges: boolean;
  pitcherNames: Map<number, string>;
}

const MAX_CHIPS_PER_ROW = 3;

interface DisplayChip { label: string; tone: 'good' | 'bad' | 'neutral'; kind: string; detail?: string }

/** Short evidence-only chips. Never fires without underlying data.
 *  Labels tightened per the UI pass. */
function pickTopChips(row: HitBoardRow, ranker: Ranker): DisplayChip[] {
  const contribs = (ranker === '1plus' ? row.contributions_1plus_json : row.contributions_2plus_json) ?? {};
  const base = (contribs as any).base_features ?? {};
  const f = (k: string): number | null => {
    const v = base[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const chips: DisplayChip[] = [];

  const seasonAvg = f('season_avg_asof');
  if (seasonAvg != null && seasonAvg >= 0.290) {
    chips.push({ kind: 'strong_contact', tone: 'good',
      label: `.${(seasonAvg * 1000).toFixed(0).padStart(3, '0')} AVG`,
      detail: 'Strong season contact' });
  }

  const hitRateL7 = f('hit_rate_l7d_asof');
  const abL7 = f('ab_l7d_asof');
  if (hitRateL7 != null && abL7 != null && abL7 >= 12) {
    if (hitRateL7 >= 0.32) {
      chips.push({ kind: 'hot_recent', tone: 'good',
        label: `Hot L7`,
        detail: `${Math.round(hitRateL7 * abL7)}/${abL7} = ${(hitRateL7 * 100).toFixed(0)}% in L7d` });
    } else if (hitRateL7 <= 0.15) {
      chips.push({ kind: 'cold_recent', tone: 'bad',
        label: `Cold L7`,
        detail: `${Math.round(hitRateL7 * abL7)}/${abL7} = ${(hitRateL7 * 100).toFixed(0)}% in L7d` });
    }
  }

  if (ranker === '2plus') {
    const multi = f('multi_hit_rate_l10g_asof');
    if (multi != null && multi >= 0.30) {
      chips.push({ kind: 'multi_hit_trend', tone: 'good',
        label: `Multi ${Math.round(multi * 10)}/10`,
        detail: `${Math.round(multi * 10)} of last 10 games ≥ 2 H` });
    }
  }

  const pH9 = f('pitcher_h_per_9_asof');
  if (pH9 != null && pH9 >= 9.5) {
    chips.push({ kind: 'favorable_h9', tone: 'good',
      label: `H/9 ${pH9.toFixed(1)}`,
      detail: 'Pitcher gives up many hits' });
  }
  const pK9 = f('pitcher_k_per_9_asof');
  if (pK9 != null && pK9 >= 11) {
    chips.push({ kind: 'dominant_pitcher', tone: 'bad',
      label: `K/9 ${pK9.toFixed(1)}`,
      detail: 'Dominant K pitcher' });
  } else if (pK9 != null && pK9 <= 7) {
    chips.push({ kind: 'low_k_pitcher', tone: 'good',
      label: `Low K/9`,
      detail: `${pK9.toFixed(1)} K/9 — contact-friendly` });
  }

  const platoon = f('platoon_hit_rate_asof');
  if (platoon != null && seasonAvg != null && platoon >= seasonAvg + 0.030) {
    chips.push({ kind: 'platoon_edge', tone: 'good',
      label: `Platoon +${((platoon - seasonAvg) * 1000).toFixed(0)}`,
      detail: `${(platoon * 100).toFixed(0)}% vs opp hand` });
  }

  const expectedPa = f('expected_pa');
  if (expectedPa != null && expectedPa >= 4.5 && row.batting_order_slot != null && row.batting_order_slot <= 3) {
    chips.push({ kind: 'top_of_order', tone: 'good',
      label: `Bat ${row.batting_order_slot}`,
      detail: `~${expectedPa.toFixed(2)} expected PA` });
  }

  // Order by tone (good first when the score is high, bad first when low).
  const prob = ranker === '1plus' ? row.hit_prob_1plus : row.hit_prob_2plus;
  if (prob != null && prob >= 0.55) {
    chips.sort((a, b) => (a.tone === 'good' ? -1 : 1) - (b.tone === 'good' ? -1 : 1));
  } else {
    chips.sort((a, b) => (a.tone === 'bad' ? -1 : 1) - (b.tone === 'bad' ? -1 : 1));
  }
  return chips;
}

function chipStyle(tone: 'good' | 'bad' | 'neutral'): React.CSSProperties {
  // Dark-theme palette that reads on --panel and --panel-2.
  const bg = tone === 'good' ? 'rgba(74,222,128,0.14)'
           : tone === 'bad'  ? 'rgba(239,68,68,0.14)'
           :                    'rgba(133,147,184,0.12)';
  const fg = tone === 'good' ? '#4ade80'
           : tone === 'bad'  ? '#fca5a5'
           :                    '#8593b8';
  return {
    background: bg, color: fg,
    padding: '1px 8px', borderRadius: 10, fontSize: 11, whiteSpace: 'nowrap',
    marginRight: 4, marginBottom: 2, display: 'inline-block',
    border: `1px solid ${fg}22`,
  };
}

function confidencePill(conf: string | null): React.ReactNode {
  if (!conf) return <span style={{ color: '#4b5878', fontSize: 11 }}>—</span>;
  const map: Record<string, { text: string; fg: string; bg: string }> = {
    high:   { text: 'HIGH', fg: '#4ade80', bg: 'rgba(74,222,128,0.10)' },
    medium: { text: 'MED',  fg: '#8593b8', bg: 'rgba(133,147,184,0.08)' },
    low:    { text: 'LOW',  fg: '#8593b8', bg: 'rgba(133,147,184,0.08)' },
  };
  const s = map[conf] ?? map.medium;
  return (
    <span style={{
      background: s.bg, color: s.fg,
      padding: '1px 7px', borderRadius: 4, fontSize: 10,
      fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
      border: `1px solid ${s.fg}22`,
    }}>{s.text}</span>
  );
}

function outcomeBadge(row: HitBoardRow): React.ReactNode {
  if (row.hits == null) return <span style={{ color: '#4b5878', fontSize: 11 }}>—</span>;
  if (row.hits >= 2) {
    return <span style={{
      background: 'rgba(74,222,128,0.18)', color: '#4ade80',
      padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 700,
      border: '1px solid #4ade8033',
    }}>{row.hits}H</span>;
  }
  if (row.hits === 1) {
    return <span style={{
      background: 'rgba(255,209,102,0.15)', color: '#ffd166',
      padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
      border: '1px solid #ffd16633',
    }}>1H</span>;
  }
  return <span style={{
    background: 'rgba(133,147,184,0.08)', color: '#8593b8',
    padding: '1px 7px', borderRadius: 4, fontSize: 11,
    border: '1px solid #8593b833',
  }}>0H</span>;
}

/** Format opposing-pitcher cell: "Paul Skenes (R)". Falls back to id if
 *  the catalog didn't resolve the name. Never invents a name. */
function formatOpposingPitcher(id: number | null, hand: string | null, pitcherNames: Map<number, string>): React.ReactNode {
  if (id == null) return <span style={{ color: '#4b5878' }}>—</span>;
  const name = pitcherNames.get(id) ?? `#${id}`;
  return (
    <span style={{ color: '#c8d3ee' }} title={pitcherNames.has(id) ? `pitcher_id=${id}` : 'not in players catalog — showing id'}>
      {name}{hand ? <span style={{ color: '#8593b8' }}> ({hand})</span> : null}
    </span>
  );
}

export default function HitsBoard({ rows, ranker, limit, showOutcomeBadges, pitcherNames }: Props) {
  const rankKey = ranker === '1plus' ? 'rank_1plus' : 'rank_2plus';
  const probKey = ranker === '1plus' ? 'hit_prob_1plus' : 'hit_prob_2plus';
  const confKey = ranker === '1plus' ? 'confidence_1plus' : 'confidence_2plus';
  const probLabel = ranker === '1plus' ? 'P(1+)' : 'P(2+)';

  const sorted = rows
    .filter((r) => r[rankKey] != null)
    .sort((a, b) => (a[rankKey] as number) - (b[rankKey] as number))
    .slice(0, limit);

  if (sorted.length === 0) {
    return <p style={{ color: 'var(--muted)' }}>No rows to display.</p>;
  }

  // Thin game divider: mark the row where game_pk changes from the previous.
  let prevGamePk: number | null = null;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            <th style={{ padding: '6px 8px', textAlign: 'left', width: 32 }}>#</th>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}>Player</th>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}>Matchup</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>{probLabel}</th>
            <th style={{ padding: '6px 8px', textAlign: 'center', width: 40 }}>Slot</th>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}>Opp Pitcher</th>
            <th style={{ padding: '6px 8px', textAlign: 'center', width: 48 }}>Conf</th>
            <th style={{ padding: '6px 8px', textAlign: 'left' }}>Why</th>
            {showOutcomeBadges && <th style={{ padding: '6px 8px', textAlign: 'center', width: 48 }}>Actual</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, idx) => {
            const rank = r[rankKey] as number;
            const prob = r[probKey];
            const conf = r[confKey] as string | null;
            const allChips = pickTopChips(r, ranker);
            const visible = allChips.slice(0, MAX_CHIPS_PER_ROW);
            const overflow = allChips.length - visible.length;

            const newGame = r.game_pk !== prevGamePk && idx > 0;
            prevGamePk = r.game_pk;

            const zebra = idx % 2 === 0 ? 'var(--panel)' : 'var(--panel-2)';
            const rowStyle: React.CSSProperties = {
              background: zebra,
              borderTop: newGame ? '1px solid var(--border)' : '1px solid rgba(36,51,88,0.35)',
            };

            return (
              <tr key={r.player_id} style={rowStyle}>
                <td style={{ padding: '8px', color: rank <= 3 ? 'var(--accent-2)' : 'var(--muted)', fontWeight: rank <= 3 ? 700 : 500, fontVariantNumeric: 'tabular-nums' }}>{rank}</td>
                <td style={{ padding: '8px' }}>
                  <Link to={`/hits/${r.target_date}/${r.player_id}`} style={{ color: 'var(--text)', fontWeight: 600, textDecoration: 'none' }}>
                    {r.player_name}
                  </Link>
                  {r.lineup_status === 'pending' && (
                    <span style={{ color: 'var(--accent-2)', fontSize: 10, marginLeft: 6, letterSpacing: 0.4 }}>PENDING</span>
                  )}
                </td>
                <td style={{ padding: '8px', color: 'var(--muted)', fontSize: 12 }}>
                  {r.team} → {r.opponent ?? '—'}
                </td>
                <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text)', fontWeight: 500 }}>
                  {prob != null ? `${(Number(prob) * 100).toFixed(1)}%` : '—'}
                </td>
                <td style={{ padding: '8px', textAlign: 'center', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                  {r.batting_order_slot ?? '—'}
                </td>
                <td style={{ padding: '8px', fontSize: 12 }}>
                  {formatOpposingPitcher(r.opposing_starter_id, r.opposing_starter_hand, pitcherNames)}
                </td>
                <td style={{ padding: '8px', textAlign: 'center' }}>
                  {confidencePill(conf)}
                </td>
                <td style={{ padding: '8px' }}>
                  {visible.length === 0
                    ? <span style={{ color: '#4b5878', fontSize: 11 }}>—</span>
                    : (
                      <>
                        {visible.map((c) => (
                          <span key={c.kind} style={chipStyle(c.tone)} title={c.detail ?? ''}>
                            {c.label}
                          </span>
                        ))}
                        {overflow > 0 && (
                          <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 2 }} title={allChips.slice(MAX_CHIPS_PER_ROW).map((c) => c.label).join(' · ')}>
                            +{overflow} more
                          </span>
                        )}
                      </>
                    )}
                </td>
                {showOutcomeBadges && (
                  <td style={{ padding: '8px', textAlign: 'center' }}>
                    {outcomeBadge(r)}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
