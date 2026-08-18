/**
 * HitsBoard — ranked list for one of the two Hits rankers (1+ or 2+).
 *
 * Kept intentionally simple. The four questions the page must answer:
 *   Who is most likely to get at least one hit today? / 2+?
 *   Why?
 *   How has this ranker performed?  (answered on the Backtest page)
 *   Which lineup slot / matchup?
 *
 * Every column pulls only from data the row carries. No cross-refs,
 * no computed-in-component metrics. If the value is null, the cell
 * shows "—" — never a fake zero.
 */
import { Link } from 'react-router-dom';
import type { HitBoardRow } from '../lib/supabase';

type Ranker = '1plus' | '2plus';

interface Props {
  rows: HitBoardRow[];
  ranker: Ranker;
  limit: number;
  showOutcomeBadges: boolean;    // true when displaying a past date with outcomes enriched
}

/** How many reason chips to render per row. Keeps the board scannable. */
const MAX_CHIPS_PER_ROW = 3;

interface DisplayChip { label: string; tone: 'good' | 'bad' | 'neutral'; kind: string; detail?: string }

/** Extract chip list from the row's contributions blob. Contributions
 *  come from HitTargetContributions which doesn't include chips
 *  directly — the chips live at the row level (from pickHitReasonChips
 *  in hitStats). But the snapshot writer only persists contributions,
 *  not the pre-computed chips. So we derive chips inline from features
 *  present in contributions.base_features. Keeps chip logic reusable
 *  without adding a separate DB column.
 *
 *  This is a small, evidence-only chip picker — mirror of the one in
 *  src/lib/hitStats.ts but simpler because we're only surfacing the
 *  top few. Never fires without underlying data. */
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
        label: `Hot L7 ${(hitRateL7 * 100).toFixed(0)}%`,
        detail: `${Math.round(hitRateL7 * abL7)}/${abL7} in L7d` });
    } else if (hitRateL7 <= 0.15) {
      chips.push({ kind: 'cold_recent', tone: 'bad',
        label: `Cold L7 ${(hitRateL7 * 100).toFixed(0)}%`,
        detail: `${Math.round(hitRateL7 * abL7)}/${abL7} in L7d` });
    }
  }

  if (ranker === '2plus') {
    const multi = f('multi_hit_rate_l10g_asof');
    if (multi != null && multi >= 0.30) {
      chips.push({ kind: 'multi_hit_trend', tone: 'good',
        label: `Multi-hit ${Math.round(multi * 10)}/10`,
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
      label: `Low K/9 ${pK9.toFixed(1)}`,
      detail: 'Contact-friendly pitcher' });
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

  // Prioritize by tone (good first when the score is high, bad first
  // when the score is low), then keep the first MAX_CHIPS_PER_ROW.
  const prob = ranker === '1plus' ? row.hit_prob_1plus : row.hit_prob_2plus;
  if (prob != null && prob >= 0.55) {
    chips.sort((a, b) => (a.tone === 'good' ? -1 : 1) - (b.tone === 'good' ? -1 : 1));
  } else {
    chips.sort((a, b) => (a.tone === 'bad' ? -1 : 1) - (b.tone === 'bad' ? -1 : 1));
  }
  return chips.slice(0, MAX_CHIPS_PER_ROW);
}

function confidenceStyle(conf: string | null): React.CSSProperties {
  if (conf === 'high') return { color: '#059669', fontWeight: 600 };
  if (conf === 'low') return { color: '#d97706', fontWeight: 600 };
  return { color: '#6b7280', fontWeight: 500 };
}

function chipStyle(tone: 'good' | 'bad' | 'neutral'): React.CSSProperties {
  const bg = tone === 'good' ? '#dcfce7' : tone === 'bad' ? '#fee2e2' : '#f3f4f6';
  const fg = tone === 'good' ? '#166534' : tone === 'bad' ? '#991b1b' : '#374151';
  return {
    background: bg, color: fg,
    padding: '2px 8px', borderRadius: 12, fontSize: 12, whiteSpace: 'nowrap',
    marginRight: 4, marginBottom: 2, display: 'inline-block',
  };
}

function outcomeBadge(row: HitBoardRow): { text: string; bg: string; fg: string } | null {
  if (row.hits == null) return null;
  if (row.hits >= 2) return { text: `${row.hits}H`, bg: '#166534', fg: '#f0fdf4' };
  if (row.hits === 1) return { text: '1H', bg: '#0369a1', fg: '#f0f9ff' };
  return { text: '0H', bg: '#9ca3af', fg: '#f9fafb' };
}

export default function HitsBoard({ rows, ranker, limit, showOutcomeBadges }: Props) {
  const rankKey = ranker === '1plus' ? 'rank_1plus' : 'rank_2plus';
  const probKey = ranker === '1plus' ? 'hit_prob_1plus' : 'hit_prob_2plus';
  const confKey = ranker === '1plus' ? 'confidence_1plus' : 'confidence_2plus';

  const sorted = rows
    .filter((r) => r[rankKey] != null)
    .sort((a, b) => (a[rankKey] as number) - (b[rankKey] as number))
    .slice(0, limit);

  if (sorted.length === 0) {
    return <p style={{ color: '#6b7280' }}>No rows to display.</p>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '8px 10px', width: 40 }}>#</th>
            <th style={{ padding: '8px 10px' }}>Player</th>
            <th style={{ padding: '8px 10px' }}>Team → Opp</th>
            <th style={{ padding: '8px 10px', textAlign: 'right' }}>
              P({ranker === '1plus' ? '≥1 Hit' : '≥2 Hits'})
            </th>
            <th style={{ padding: '8px 10px', textAlign: 'center', width: 60 }}>Slot</th>
            <th style={{ padding: '8px 10px' }}>Opp Pitcher</th>
            <th style={{ padding: '8px 10px', width: 80 }}>Conf</th>
            <th style={{ padding: '8px 10px' }}>Why</th>
            {showOutcomeBadges && <th style={{ padding: '8px 10px', width: 60 }}>Actual</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const rank = r[rankKey] as number;
            const prob = r[probKey];
            const conf = r[confKey];
            const chips = pickTopChips(r, ranker);
            const outcome = showOutcomeBadges ? outcomeBadge(r) : null;
            const rowStyle: React.CSSProperties = {
              borderBottom: '1px solid #f3f4f6',
              backgroundColor: rank <= 3 ? '#fafaf9' : 'transparent',
            };
            return (
              <tr key={r.player_id} style={rowStyle}>
                <td style={{ padding: '10px', fontWeight: 600, color: rank <= 3 ? '#111827' : '#6b7280' }}>{rank}</td>
                <td style={{ padding: '10px' }}>
                  <Link to={`/hits/${r.target_date}/${r.player_id}`} style={{ color: '#111827', fontWeight: 500 }}>
                    {r.player_name}
                  </Link>
                  {r.lineup_status === 'pending' && (
                    <span style={{ color: '#d97706', fontSize: 11, marginLeft: 6 }}>pending</span>
                  )}
                </td>
                <td style={{ padding: '10px', color: '#6b7280' }}>
                  {r.team} → {r.opponent ?? '—'}
                </td>
                <td style={{ padding: '10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {prob != null ? `${(Number(prob) * 100).toFixed(1)}%` : '—'}
                </td>
                <td style={{ padding: '10px', textAlign: 'center', color: '#6b7280' }}>
                  {r.batting_order_slot ?? '—'}
                </td>
                <td style={{ padding: '10px', color: '#6b7280', fontSize: 13 }}>
                  {r.opposing_starter_id != null
                    ? <span>#{r.opposing_starter_id}{r.opposing_starter_hand ? ` (${r.opposing_starter_hand})` : ''}</span>
                    : '—'}
                </td>
                <td style={{ padding: '10px', ...confidenceStyle(conf as string | null) }}>
                  {conf ?? '—'}
                </td>
                <td style={{ padding: '10px' }}>
                  {chips.length === 0
                    ? <span style={{ color: '#9ca3af', fontSize: 12 }}>no chips</span>
                    : chips.map((c) => (
                        <span key={c.kind} style={chipStyle(c.tone)} title={c.detail ?? ''}>
                          {c.label}
                        </span>
                      ))}
                </td>
                {showOutcomeBadges && (
                  <td style={{ padding: '10px', textAlign: 'center' }}>
                    {outcome
                      ? <span style={{
                          background: outcome.bg, color: outcome.fg,
                          padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
                        }}>{outcome.text}</span>
                      : <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>}
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
