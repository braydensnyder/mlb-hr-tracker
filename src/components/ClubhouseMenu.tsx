/**
 * ClubhouseMenu — single branded dropdown that replaces the inline nav
 * links. Same component on desktop and mobile — no separate hamburger.
 *
 * Behavior:
 *   - Trigger button ("Clubhouse ⚾") sits on the right of the header.
 *   - Click toggles a panel anchored under the button.
 *   - Click-outside closes. Escape closes. Selecting an item closes.
 *   - The active route gets a left accent stripe + colored label.
 *   - On narrow viewports the panel hugs the right edge with a small
 *     inset so it can't clip off-screen.
 *
 * Premium feel choices:
 *   - Button uses the project's --accent token plus a hover/active brighten,
 *     not the generic browser button.
 *   - Panel uses an elevated shadow + 1px border in --border, matching the
 *     rest of the panel styling. No flat "gray rectangle".
 *   - Each item is a full row with a label + short description, so the menu
 *     reads like a small landing page instead of a bare list.
 */
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  description: string;
  /** match the location.pathname exactly via NavLink's `end` semantics */
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { to: '/',         label: 'Dashboard',  description: "Today's HRs, leaders, and live status", end: true },
  { to: '/card',     label: 'The Card',   description: 'Tonight\'s picks — Cores, Boosts, Spice' },
  { to: '/teams',    label: 'Team Board', description: 'One pick per team — league-wide representation' },
  { to: '/lab',      label: 'Parlay Lab', description: 'Safe / Value / Chaos parlays + historical backtest' },
  { to: '/matchups', label: 'Matchups',   description: 'Today\'s probable pitchers and game notes' },
  { to: '/targets',  label: 'HR Targets', description: 'Heat Score model + research deep-dive' },
  { to: '/odds',     label: 'Odds',       description: 'HR props, line movement, Model vs Market' },
  { to: '/backtest', label: 'Backtest',   description: 'Hit rate, lift vs random, miss analysis' },
];

export default function ClubhouseMenu() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Close when the route changes (selecting an item navigates and closes).
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // The active label powers the button's small badge so the user can see
  // where they are without opening the menu.
  const activeItem = ITEMS.find((it) => (it.end ? location.pathname === it.to : location.pathname.startsWith(it.to))) ?? ITEMS[0];

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="clubhouse-menu-panel"
        onClick={() => setOpen((o) => !o)}
        className="clubhouse-trigger"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          borderRadius: 999,
          fontWeight: 700,
          fontSize: 14,
          color: 'var(--text, #fff)',
          background: open
            ? 'linear-gradient(180deg, rgba(255,122,24,0.30), rgba(255,122,24,0.18))'
            : 'linear-gradient(180deg, rgba(255,122,24,0.20), rgba(255,122,24,0.10))',
          border: `1px solid ${open ? 'rgba(255,122,24,0.85)' : 'rgba(255,122,24,0.55)'}`,
          cursor: 'pointer',
          letterSpacing: 0.2,
          transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease',
          transform: open ? 'translateY(0)' : 'translateY(0)',
        }}
        onMouseDown={(e) => e.currentTarget.style.transform = 'translateY(1px)'}
        onMouseUp={(e) => e.currentTarget.style.transform = 'translateY(0)'}
        onMouseLeave={(e) => e.currentTarget.style.transform = 'translateY(0)'}
      >
        <span>Clubhouse</span>
        <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>⚾</span>
        {/* Tiny active-page chip so the user knows where they are
            without having to open the menu. Hidden on very narrow screens. */}
        <span
          className="clubhouse-active-chip"
          style={{
            marginLeft: 6,
            paddingLeft: 8,
            borderLeft: '1px solid rgba(255,255,255,0.18)',
            fontSize: 11,
            opacity: 0.85,
            fontWeight: 600,
          }}
        >
          {activeItem.label}
        </span>
        <span aria-hidden style={{
          fontSize: 10,
          marginLeft: 2,
          transition: 'transform 150ms ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0)',
          opacity: 0.8,
        }}>
          ▾
        </span>
      </button>

      {open && (
        <div
          id="clubhouse-menu-panel"
          role="menu"
          className="clubhouse-panel"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            minWidth: 260,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--panel, #11141c)',
            border: '1px solid var(--border, #2a2f3b)',
            borderRadius: 12,
            boxShadow: '0 16px 40px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.30)',
            padding: 6,
            zIndex: 100,
          }}
        >
          {ITEMS.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              role="menuitem"
              className={({ isActive }) => `clubhouse-item${isActive ? ' is-active' : ''}`}
              style={({ isActive }) => ({
                display: 'grid',
                gridTemplateColumns: '4px 1fr',
                gap: 10,
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 8,
                textDecoration: 'none',
                color: isActive ? 'var(--accent, #ff7a18)' : 'var(--text, #fff)',
                background: isActive ? 'rgba(255,122,24,0.10)' : 'transparent',
                transition: 'background 100ms ease, color 100ms ease',
              })}
            >
              {({ isActive }) => (
                <>
                  {/* Left accent stripe — only visible on active. Reserves
                      the 4px column always so labels don't shift on click. */}
                  <span
                    aria-hidden
                    style={{
                      width: 4,
                      height: '100%',
                      minHeight: 30,
                      borderRadius: 3,
                      background: isActive ? 'var(--accent, #ff7a18)' : 'transparent',
                    }}
                  />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>
                      {it.label}
                    </div>
                    <div
                      className="subtle"
                      style={{
                        fontSize: 11,
                        marginTop: 2,
                        opacity: 0.7,
                        lineHeight: 1.35,
                      }}
                    >
                      {it.description}
                    </div>
                  </div>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}

      {/* Inline style for hover affordance + mobile hide of the active chip.
          Kept inline so the component is self-contained (no global CSS edits). */}
      <style>{`
        .clubhouse-item:hover { background: rgba(255,255,255,0.04) !important; }
        .clubhouse-item.is-active:hover { background: rgba(255,122,24,0.14) !important; }
        .clubhouse-trigger:hover { filter: brightness(1.05); }
        @media (max-width: 520px) {
          .clubhouse-active-chip { display: none; }
        }
      `}</style>
    </div>
  );
}
