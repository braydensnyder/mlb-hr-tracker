/**
 * ResearchDrawer — a single collapsible accordion that wraps the
 * research-only sections (Sleeper/Chaos, Certified Sleeper, Reverse
 * Engineering Analysis). Collapsed by default so the main page stays
 * focused on daily picks + diagnostics.
 *
 * Persists open/close in localStorage so the user's preference survives
 * page navigation within the same session.
 */
import { useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'hrtracker:research-drawer:open';

export default function ResearchDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            🔬 Research / Dev Tools
            <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.6, fontWeight: 400 }}>
              {open ? '— click to collapse' : '— click to expand'}
            </span>
          </h2>
          <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
            Sleeper / Chaos board, Certified Sleeper bankroll tracker, full reverse-engineering
            analysis. <strong>Not needed for daily picks</strong> — kept here for research only.
          </div>
        </div>
        <span style={{ fontSize: 18, opacity: 0.7 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
}
