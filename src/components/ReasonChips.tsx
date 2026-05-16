/**
 * ReasonChips — compact, color-toned chips for HR Target reasons.
 *
 * Why this exists: the previous "reasons" UI joined long sentences with
 * " · " separators. On mobile that wrapped into a wall of text and made
 * obviously-false claims (like "2 HR over last 2 HR games" for a hitter
 * whose HRs were a month apart) feel definitive. Chips are short by
 * construction and the tone color signals direction at a glance.
 *
 * - good    → muted green pill
 * - bad     → muted red pill
 * - neutral → muted gray pill
 *
 * `variant="row"` is the compact list shown on the main row.
 * `variant="detail"` renders the same chips at slightly larger size and
 *  appends each chip's `detail` text underneath for verification — used
 *  in the expanded row.
 */
import React from 'react';
import type { ReasonChip } from '../lib/stats';

const TONE_BG: Record<ReasonChip['tone'], string> = {
  good: 'rgba(64, 200, 120, 0.14)',
  bad: 'rgba(255, 110, 110, 0.14)',
  neutral: 'rgba(160, 160, 160, 0.14)',
};
const TONE_BORDER: Record<ReasonChip['tone'], string> = {
  good: 'rgba(64, 200, 120, 0.45)',
  bad: 'rgba(255, 110, 110, 0.45)',
  neutral: 'rgba(160, 160, 160, 0.45)',
};
const TONE_TEXT: Record<ReasonChip['tone'], string> = {
  good: 'var(--good, #4cd97a)',
  bad: '#ff8d8d',
  neutral: 'var(--muted, #aaa)',
};

export default function ReasonChips({
  chips,
  variant = 'row',
}: {
  chips: ReasonChip[];
  variant?: 'row' | 'detail';
}) {
  if (!chips || chips.length === 0) {
    return (
      <span className="subtle" style={{ fontSize: 12 }}>
        —
      </span>
    );
  }

  const fontSize = variant === 'detail' ? 12 : 11;
  const padding = variant === 'detail' ? '4px 9px' : '2px 7px';

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        rowGap: 4,
      }}
    >
      {chips.map((c) => (
        <span
          key={c.kind}
          className="reason-chip"
          title={c.detail ?? c.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding,
            borderRadius: 999,
            fontSize,
            lineHeight: 1.2,
            fontWeight: 600,
            background: TONE_BG[c.tone],
            border: `1px solid ${TONE_BORDER[c.tone]}`,
            color: TONE_TEXT[c.tone],
            whiteSpace: 'nowrap',
          }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Verbose chip list for the expanded detail — chip + its source value. */
export function ReasonChipDetails({ chips }: { chips: ReasonChip[] }) {
  if (!chips || chips.length === 0) {
    return (
      <div className="subtle" style={{ fontSize: 12 }}>
        No verified signals to display.
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {chips.map((c) => (
        <div
          key={c.kind}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              padding: '3px 8px',
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              background: TONE_BG[c.tone],
              border: `1px solid ${TONE_BORDER[c.tone]}`,
              color: TONE_TEXT[c.tone],
              whiteSpace: 'nowrap',
            }}
          >
            {c.label}
          </span>
          <span className="subtle" style={{ fontSize: 12 }}>
            {c.detail ?? ''}
          </span>
        </div>
      ))}
    </div>
  );
}
