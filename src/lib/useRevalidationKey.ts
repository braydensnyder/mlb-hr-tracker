/**
 * Auto-refresh hook for data-fetching pages.
 *
 * Returns a number that increments whenever data on the page should be
 * re-fetched. Pages add it to the deps array of their fetch useEffect:
 *
 *   const refreshKey = useRevalidationKey();
 *   useEffect(() => { fetchStuff(...); }, [asOf, refreshKey]);
 *
 * Triggers a bump on:
 *   1. Tab becoming visible (e.g. switching back to a Safari tab on iPhone,
 *      reopening the PWA from the home screen, alt-tabbing on desktop).
 *   2. Window regaining focus (safety net — usually redundant with #1).
 *   3. A periodic interval, defaulting to 60 minutes.
 *
 * Why this exists: the app pulls data from Supabase on mount, but if the
 * tab is left open (laptop overnight, iPhone in pocket), the visible
 * rankings can be hours stale. This hook keeps them current without the
 * user needing to manually refresh.
 */
import { useEffect, useState } from 'react';

const ONE_HOUR_MS = 60 * 60 * 1000;

export function useRevalidationKey(intervalMs: number = ONE_HOUR_MS): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);

    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        bump();
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', bump);
    }
    const id = typeof window !== 'undefined' ? window.setInterval(bump, intervalMs) : null;

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', bump);
      }
      if (id != null) window.clearInterval(id);
    };
  }, [intervalMs]);

  return tick;
}
