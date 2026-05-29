/**
 * ColdBatterReboundCard — discovery section in the Sleeper / Chaos area.
 *
 * Surfaces hitters whom the model is penalizing for being "cold" (0 HR in
 * the last 7 days) but who still carry meaningful HR upside (HR Pitcher,
 * Power Park, Wind Out, Warm Weather, Platoon Edge, Mid Power, Elite
 * Power). The rebound score quantifies how much signal is sitting under
 * the cold drag — see computeColdBatterRebound in src/lib/stats.ts.
 *
 * STRICTLY a discovery list:
 *   - Does NOT affect the main HR Targets ranking.
 *   - Does NOT affect the Top 10.
 *   - Read-only over the already-ranked list.
 */
import { Link } from 'react-router-dom';
import type { ColdReboundCandidate, ReasonChip } from '../lib/stats';

interface Props {
  picks: ColdReboundCandidate[];
  asOf: string;
}

export default function ColdBatterReboundCard({ picks, asOf }: Props) {
  if (picks.length === 0) {
    return (
      <div className="panel" style={{ marginBottom: 16 }}>
        <Header />
        <p className="subtle" style={{ fontSize: 12, margin: '6px 0 0' }}>
          No cold-penalized hitters with meaningful upside surfaced for {asOf}.
        </p>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <Header />
      <div className="subtle" style={{ fontSize: 12, marginTop: 6, marginBottom: 10, lineHeight: 1.45 }}>
        Hitters currently penalized by the <strong>Cold Batter</strong> rule
        whose matchup carries real upside — the model may be over-penalizing
        them. <strong>Not a confident pick</strong>; a discovery layer separate from
        the Top 10.
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {picks.map((c) => <ReboundCard key={c.player_id} c={c} asOf={asOf} />)}
      </div>
      <p className="subtle" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.4 }}>
        Rebound = upside signals + |cold penalty|. Read-only; ranking and Top 10 unchanged.
      </p>
    </div>
  );
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>
        <span style={{ color: '#c084fc' }}>❄️</span> Cold Batter Rebound
      </h2>
      <span className="subtle" style={{ fontSize: 12 }}>
        over-penalized hitters with real HR upside
      </span>
    </div>
  );
}

function ReboundCard({ c, asOf }: { c: ColdReboundCandidate; asOf: string }) {
  return (
    <div
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        borderLeft: '3px solid #c084fc',
        borderRadius: 8,
        padding: '9px 11px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <Link
            to={`/player/${c.player_id}?asOf=${asOf}`}
            className="player-link"
            style={{ fontSize: 13.5, fontWeight: 700 }}
          >
            {c.player_name}
          </Link>
          <span className="subtle" style={{ fontSize: 11 }}>
            {c.team} vs {c.opponent}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, color: '#c084fc', fontWeight: 600 }}>
            Rebound {c.rebound_score.toFixed(0)}
          </span>
          <span className="subtle" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            #{c.heat_rank} · {c.heat_score.toFixed(0)} heat
            {c.american_odds != null && (
              <> · {c.american_odds > 0 ? '+' : ''}{c.american_odds}</>
            )}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {c.tags.map((t, i) => <ReboundChip key={`${t.kind}-${i}`} chip={t} />)}
      </div>
      <div className="subtle" style={{ fontSize: 10.5, marginTop: 6 }}>
        upside {c.upside_total} + {Math.abs(c.cold_penalty)} cold-drag
      </div>
    </div>
  );
}

function ReboundChip({ chip }: { chip: ReasonChip }) {
  const bg =
    chip.tone === 'good' ? 'rgba(64,200,120,0.14)' :
    chip.tone === 'bad'  ? 'rgba(255,110,110,0.14)' :
                           'rgba(192,132,252,0.16)';
  const border =
    chip.tone === 'good' ? '1px solid rgba(64,200,120,0.45)' :
    chip.tone === 'bad'  ? '1px solid rgba(255,110,110,0.45)' :
                           '1px solid rgba(192,132,252,0.5)';
  const color =
    chip.tone === 'good' ? 'var(--good, #4cd97a)' :
    chip.tone === 'bad'  ? '#ff8d8d' :
                           '#c084fc';
  return (
    <span
      title={chip.detail ?? chip.label}
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: bg,
        border,
        color,
      }}
    >
      {chip.label}
    </span>
  );
}
