/**
 * SleeperBoardPanel — renders the forward-looking volatility/upside layer
 * that sits BELOW the core HR Targets board.
 *
 * Four categories, each a small card list:
 *   - Sleepers              — outside the core, multiple upside signals
 *   - Boom/Bust             — elite power gone cold, high-variance ceiling
 *   - Undervalued Longshots — book has them +500..+900 with a real signal
 *   - Weather-enhanced      — wind-out / warm value plays
 *
 * This is explicitly NOT the main ranking. The header copy reinforces
 * that it's a discovery layer for overlooked HR candidates, not the
 * model's confident picks.
 */
import { Link } from 'react-router-dom';
import type { SleeperBoard, SleeperCandidate, ReasonChip } from '../lib/stats';

const CATEGORY_META: Record<
  keyof SleeperBoard,
  { title: string; blurb: string; accent: string }
> = {
  sleepers: {
    title: 'Top Sleepers',
    blurb: 'Buried in the rankings but stacking multiple upside signals.',
    accent: 'var(--accent, #ff7a18)',
  },
  boomBust: {
    title: 'Boom / Bust',
    blurb: 'Elite power gone quiet — high ceiling, low floor.',
    accent: '#c084fc',
  },
  longshots: {
    title: 'Undervalued Longshots',
    blurb: 'Book has them +500 to +900 but a real edge exists.',
    accent: '#4cd97a',
  },
  weatherPlays: {
    title: 'Weather-Enhanced Value',
    blurb: 'Wind blowing out / warm conditions boosting HR odds.',
    accent: '#38bdf8',
  },
};

export default function SleeperBoardPanel({ board, asOf }: { board: SleeperBoard; asOf: string }) {
  const empty =
    board.sleepers.length === 0 &&
    board.boomBust.length === 0 &&
    board.longshots.length === 0 &&
    board.weatherPlays.length === 0;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>Sleeper / Chaos layer</h2>
        <span className="subtle" style={{ fontSize: 12 }}>
          volatility &amp; upside — separate from the core rankings above
        </span>
      </div>
      <div className="subtle" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        These are players ranked <strong>outside the Top 15</strong> whose profile carries
        upside the Heat Score underweights — long odds, wind out, weak HR pitchers, platoon
        edges, improving form, or volatile power. <strong>Not the model's confident picks</strong> —
        a discovery list for overlooked HR candidates. The core Top 10 stays stable; this layer
        is where you go fishing.
      </div>

      {empty ? (
        <div className="subtle" style={{ fontSize: 13 }}>
          No sleeper candidates surfaced for {asOf} — either games haven't been enriched yet
          (probable pitchers / weather), or the upside signals are concentrated in the core
          Top 15. Check back closer to game time.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          }}
        >
          <SleeperColumn meta={CATEGORY_META.sleepers} rows={board.sleepers} asOf={asOf} />
          <SleeperColumn meta={CATEGORY_META.boomBust} rows={board.boomBust} asOf={asOf} />
          <SleeperColumn meta={CATEGORY_META.longshots} rows={board.longshots} asOf={asOf} />
          <SleeperColumn meta={CATEGORY_META.weatherPlays} rows={board.weatherPlays} asOf={asOf} />
        </div>
      )}
    </div>
  );
}

function SleeperColumn({
  meta,
  rows,
  asOf,
}: {
  meta: { title: string; blurb: string; accent: string };
  rows: SleeperCandidate[];
  asOf: string;
}) {
  return (
    <div
      style={{
        background: 'var(--panel-2)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 10,
        borderTop: `3px solid ${meta.accent}`,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: meta.accent }}>{meta.title}</div>
      <div className="subtle" style={{ fontSize: 11, marginTop: 2, marginBottom: 8, lineHeight: 1.35 }}>
        {meta.blurb}
      </div>
      {rows.length === 0 ? (
        <div className="subtle" style={{ fontSize: 12 }}>— none today —</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rows.map((c) => (
            <SleeperCard key={c.player_id} c={c} asOf={asOf} />
          ))}
        </div>
      )}
    </div>
  );
}

function SleeperCard({ c, asOf }: { c: SleeperCandidate; asOf: string }) {
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '8px 9px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <Link className="player-link" to={`/player/${c.player_id}?asOf=${asOf}`} style={{ fontSize: 13, fontWeight: 700 }}>
          {c.player_name}
        </Link>
        <span className="subtle" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          #{c.heat_rank} · {c.heat_score.toFixed(0)} heat
        </span>
      </div>
      <div className="subtle" style={{ fontSize: 11, marginTop: 1 }}>
        {c.team} vs {c.opponent}
        {c.american_odds != null && (
          <> · {c.american_odds > 0 ? '+' : ''}{c.american_odds}</>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {c.tags.map((t) => (
          <SleeperTag key={t.kind} chip={t} />
        ))}
      </div>
    </div>
  );
}

function SleeperTag({ chip }: { chip: ReasonChip }) {
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
