/**
 * enrichVenues — backfill venue_id + venue_name on `home_runs` and `games`,
 * keep the canonical `venues` catalog up to date, and recompute the
 * `venue_hr_summary` derived cache.
 *
 * Strategy:
 *   1. Find every game_pk that has missing venue info on either:
 *        - games.venue_id IS NULL OR games.venue_name IS NULL
 *        - home_runs.venue_id IS NULL OR home_runs.venue_name IS NULL
 *   2. For each such game_pk, fetch the live feed once, read
 *      gameData.venue.{id,name}, and update the games row + every
 *      home_runs row in that game in a single pass.
 *   3. Upsert each resolved (venue_id, name) into the canonical `venues` table.
 *   4. After enrichment, rebuild `venue_hr_summary` for the as-of date
 *      (default: today) so the frontend has a fresh derived view.
 *
 * Idempotent: only acts on rows where venue info is currently NULL.
 *
 * CLI flags (via runEnrichVenues.ts):
 *   --delay N        ms between API calls (default 250)
 *   --limit N        cap how many games to enrich this run
 *   --dry-run        no writes, just report what would change
 *   --skip-summary   skip the venue_hr_summary rebuild at the end
 *   --as-of YYYY-MM-DD   anchor for the summary (default: today)
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { fetchGameFeed } from './fetchGameFeed.js';
import { upsertVenues } from './lib/venues.js';
import { withRetry } from './lib/retry.js';
import { mlbToday, addDays as mlbAddDays } from './lib/mlbDate.js';

export interface EnrichVenuesOptions {
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
  skipSummary?: boolean;
  asOf?: string; // YYYY-MM-DD anchor for venue_hr_summary
}

export interface EnrichVenuesResult {
  gamesScanned: number;
  gamesResolved: number;
  homeRunsUpdated: number;
  venuesCatalogUpserts: number;
  summaryRowsWritten: number;
  failures: { game_pk: number; error: string }[];
}

const PAGE = 1000;

async function listGamePksMissingVenue(): Promise<number[]> {
  const ids = new Set<number>();

  // games rows missing venue_id OR venue_name
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('games')
      .select('game_pk')
      .or('venue_id.is.null,venue_name.is.null')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list games failed: ${error.message}`);
    const rows = (data ?? []) as { game_pk: number }[];
    for (const r of rows) ids.add(r.game_pk);
    if (rows.length < PAGE) break;
  }

  // home_runs rows missing venue_id OR venue_name (older HRs from before the column existed)
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('game_pk')
      .or('venue_id.is.null,venue_name.is.null')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list home_runs failed: ${error.message}`);
    const rows = (data ?? []) as { game_pk: number }[];
    for (const r of rows) ids.add(r.game_pk);
    if (rows.length < PAGE) break;
  }

  return Array.from(ids).sort((a, b) => a - b);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Pacific calendar date — see scripts/lib/mlbDate.ts.
const todayISO = mlbToday;
const addDays = mlbAddDays;

interface VenueAgg {
  venue_id: number;
  venue_name: string;
  hrs_season: number;
  hrs_l7d: number;
  hrs_l14d: number;
  hitters: Set<number>;
  teams: Set<string>;
}

/**
 * Rebuilds the venue_hr_summary table from raw home_runs.
 * Anchored at the given asOf date; "season" = year-of(asOf) start through asOf.
 *
 * `home_runs` is the source of truth; this just materializes a cached view.
 */
async function rebuildVenueSummary(asOf: string): Promise<number> {
  const seasonStart = `${asOf.slice(0, 4)}-01-01`;
  const sevenStart = addDays(asOf, -6);
  const fourteenStart = addDays(asOf, -13);

  const buckets = new Map<number, VenueAgg>();

  // Page through every relevant HR row.
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select('venue_id, venue_name, game_date, player_id, team, opponent')
      .gte('game_date', seasonStart)
      .lte('game_date', asOf)
      .not('venue_id', 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`select home_runs for summary failed: ${error.message}`);
    const rows = (data ?? []) as { venue_id: number; venue_name: string | null; game_date: string; player_id: number; team: string; opponent: string }[];
    for (const r of rows) {
      let b = buckets.get(r.venue_id);
      if (!b) {
        b = {
          venue_id: r.venue_id,
          venue_name: r.venue_name ?? '(unknown venue)',
          hrs_season: 0,
          hrs_l7d: 0,
          hrs_l14d: 0,
          hitters: new Set(),
          teams: new Set(),
        };
        buckets.set(r.venue_id, b);
      }
      // keep the most recently observed name in case it was filled in late
      if (r.venue_name) b.venue_name = r.venue_name;
      b.hrs_season++;
      if (r.game_date >= sevenStart) b.hrs_l7d++;
      if (r.game_date >= fourteenStart) b.hrs_l14d++;
      b.hitters.add(r.player_id);
      b.teams.add(r.team);
      b.teams.add(r.opponent);
    }
    if (rows.length < PAGE) break;
  }

  if (buckets.size === 0) return 0;

  // Truncate then re-insert. We only support one anchor at a time; this keeps
  // the table small and correct (no stale rows for venues that no longer match).
  const { error: delErr } = await supabaseAdmin
    .from('venue_hr_summary')
    .delete()
    .neq('venue_id', -1); // matches all
  if (delErr) throw new Error(`wipe venue_hr_summary failed: ${delErr.message}`);

  const summaryRows = Array.from(buckets.values()).map((b) => ({
    venue_id: b.venue_id,
    venue_name: b.venue_name,
    computed_for: asOf,
    hrs_season: b.hrs_season,
    hrs_l7d: b.hrs_l7d,
    hrs_l14d: b.hrs_l14d,
    unique_hitters: b.hitters.size,
    teams_seen: Array.from(b.teams).sort(),
  }));

  // Chunk to be safe on payload size.
  const CHUNK = 500;
  for (let i = 0; i < summaryRows.length; i += CHUNK) {
    const slice = summaryRows.slice(i, i + CHUNK);
    const { error: insErr } = await supabaseAdmin
      .from('venue_hr_summary')
      .upsert(slice, { onConflict: 'venue_id' });
    if (insErr) throw new Error(`insert venue_hr_summary failed: ${insErr.message}`);
  }
  return summaryRows.length;
}

export async function enrichVenues(opts: EnrichVenuesOptions = {}): Promise<EnrichVenuesResult> {
  const delayMs = opts.delayMs ?? 250;
  const dryRun = !!opts.dryRun;
  const skipSummary = !!opts.skipSummary;
  const asOf = opts.asOf ?? todayISO();

  let ids = await listGamePksMissingVenue();
  console.log(`[enrichVenues] ${ids.length} game(s) need venue (id or name)`);
  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < ids.length) {
    console.log(`[enrichVenues] --limit ${opts.limit} → only enriching first ${opts.limit}`);
    ids = ids.slice(0, opts.limit);
  }

  const result: EnrichVenuesResult = {
    gamesScanned: ids.length,
    gamesResolved: 0,
    homeRunsUpdated: 0,
    venuesCatalogUpserts: 0,
    summaryRowsWritten: 0,
    failures: [],
  };

  const seenVenues = new Map<number, string>();

  for (let i = 0; i < ids.length; i++) {
    const gamePk = ids[i];
    try {
      const feed = await withRetry(() => fetchGameFeed(gamePk));
      const venueName: string | null = feed?.gameData?.venue?.name ?? null;
      const venueId: number | null = feed?.gameData?.venue?.id ? Number(feed.gameData.venue.id) : null;

      if (!venueName || !venueId) {
        console.log(`  game ${gamePk} → feed missing venue (name=${venueName ?? 'null'}, id=${venueId ?? 'null'})`);
        continue;
      }

      seenVenues.set(venueId, venueName);

      if (dryRun) {
        if (i % 25 === 0) console.log(`  [dry-run] would set game ${gamePk} → "${venueName}" (id=${venueId})`);
        result.gamesResolved++;
        continue;
      }

      // Update games row (only set fields that are currently NULL — never overwrite good data)
      const { error: gErr } = await supabaseAdmin
        .from('games')
        .update({ venue_id: venueId, venue_name: venueName })
        .eq('game_pk', gamePk)
        .or('venue_id.is.null,venue_name.is.null');
      if (gErr) throw new Error(`update games failed: ${gErr.message}`);

      // Update home_runs rows for this game where either field is NULL
      const { error: hErr, count } = await supabaseAdmin
        .from('home_runs')
        .update({ venue_id: venueId, venue_name: venueName }, { count: 'exact' })
        .eq('game_pk', gamePk)
        .or('venue_id.is.null,venue_name.is.null');
      if (hErr) throw new Error(`update home_runs failed: ${hErr.message}`);

      result.gamesResolved++;
      result.homeRunsUpdated += count ?? 0;
      if (i % 25 === 0) {
        console.log(`  game ${gamePk} → "${venueName}" (id=${venueId}, ${count ?? 0} HRs updated)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ game_pk: gamePk, error: msg });
      console.error(`  game ${gamePk} FAILED: ${msg}`);
    }
    if (i < ids.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  // ---- catalog upsert ----
  if (!dryRun && seenVenues.size > 0) {
    const seeds = Array.from(seenVenues.entries()).map(([venue_id, name]) => ({ venue_id, name }));
    result.venuesCatalogUpserts = await upsertVenues(seeds);
    console.log(`[enrichVenues] upserted ${result.venuesCatalogUpserts} canonical venue rows`);
  }

  // ---- venue summary rebuild ----
  if (!dryRun && !skipSummary) {
    try {
      result.summaryRowsWritten = await rebuildVenueSummary(asOf);
      console.log(`[enrichVenues] rebuilt venue_hr_summary anchored at ${asOf} (${result.summaryRowsWritten} rows)`);
    } catch (err) {
      console.error(`[enrichVenues] summary rebuild FAILED:`, err);
    }
  }

  console.log('[enrichVenues] DONE', {
    gamesScanned: result.gamesScanned,
    gamesResolved: result.gamesResolved,
    homeRunsUpdated: result.homeRunsUpdated,
    venuesCatalogUpserts: result.venuesCatalogUpserts,
    summaryRowsWritten: result.summaryRowsWritten,
    failures: result.failures.length,
  });
  return result;
}

// Public so runRebuildAll-style callers can refresh the summary on demand.
export { rebuildVenueSummary };
