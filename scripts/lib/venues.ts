/**
 * Tiny helper for keeping the canonical `venues` catalog in sync with
 * whatever venue (id, name) pairs we see during ingest or enrichment.
 *
 * Called from processDate (when fetchSchedule includes venue info) and
 * from enrichVenues (when we resolve venue from a game's live feed).
 *
 * Idempotent: on conflict by venue_id, only updates name/city/state if we
 * have new info.
 */
import { supabaseAdmin } from './supabaseAdmin.js';

export interface VenueSeed {
  venue_id: number;
  name: string;
  city?: string | null;
  state?: string | null;
}

export async function upsertVenues(seeds: VenueSeed[]): Promise<number> {
  // Dedup by venue_id; prefer the most recently seen name/city/state.
  const byId = new Map<number, VenueSeed>();
  for (const s of seeds) {
    if (!Number.isFinite(s.venue_id) || !s.name) continue;
    byId.set(s.venue_id, s);
  }
  if (byId.size === 0) return 0;

  const rows = Array.from(byId.values()).map((v) => ({
    venue_id: v.venue_id,
    name: v.name,
    city: v.city ?? null,
    state: v.state ?? null,
  }));

  const { error } = await supabaseAdmin.from('venues').upsert(rows, { onConflict: 'venue_id' });
  if (error) throw new Error(`upsert venues failed: ${error.message}`);
  return rows.length;
}
