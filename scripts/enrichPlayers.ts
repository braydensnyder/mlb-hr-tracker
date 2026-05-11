/**
 * enrichPlayers — populate / refresh the canonical `players` table.
 *
 * Why this exists:
 *   The `home_runs` table records the team a player was *playing for in
 *   that game*, which can be a non-MLB name like "United States" if a
 *   WBC or exhibition row was ever ingested. The frontend needs each
 *   player's *current MLB team* for display. /v1/people/{id} returns
 *   currentTeam.{id,name}; this script materializes that into `players`.
 *
 * Strategy:
 *   1. Build the universe of player_ids we care about: every distinct
 *      batter player_id in home_runs + every distinct pitcher_id.
 *   2. Subtract any IDs already in `players` whose `updated_at` is newer
 *      than --refresh-days (default 7). The rest are "stale or missing."
 *   3. For each, fetch /v1/people/{id} (with retry) and upsert.
 *
 * Idempotent and resumable. The `players` table is the single source of
 * truth for canonical name + team going forward.
 *
 * CLI flags (via runEnrichPlayers.ts):
 *   --delay N            ms between API calls (default 200)
 *   --limit N            cap how many people to look up this run
 *   --dry-run            no writes
 *   --refresh-days N     re-fetch any players row older than N days (default 7)
 *   --force              ignore the freshness check; refresh every player
 */
import { supabaseAdmin } from './lib/supabaseAdmin.js';
import { getPersonRaw } from './lib/mlb.js';
import { withRetry } from './lib/retry.js';

export interface EnrichPlayersOptions {
  delayMs?: number;
  limit?: number;
  dryRun?: boolean;
  refreshDays?: number;
  force?: boolean;
}

export interface EnrichPlayersResult {
  candidates: number;       // total distinct player_ids we considered
  toFetch: number;          // candidates minus already-fresh
  fetched: number;
  upserted: number;
  failures: { id: number; error: string }[];
}

const PAGE = 1000;

async function listDistinctIdsFromHrs(idCol: 'player_id' | 'pitcher_id'): Promise<number[]> {
  const ids = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('home_runs')
      .select(idCol)
      .not(idCol, 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list ${idCol} failed: ${error.message}`);
    const rows = (data ?? []) as Record<string, number>[];
    for (const r of rows) {
      const v = r[idCol];
      if (typeof v === 'number') ids.add(v);
    }
    if (rows.length < PAGE) break;
  }
  return Array.from(ids);
}

async function listFreshPlayers(refreshDays: number): Promise<Set<number>> {
  // Players whose record is newer than (now - refreshDays). We page to be safe.
  const cutoff = new Date(Date.now() - refreshDays * 86_400_000).toISOString();
  const fresh = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('players')
      .select('player_id, updated_at')
      .gte('updated_at', cutoff)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`list fresh players failed: ${error.message}`);
    const rows = (data ?? []) as { player_id: number }[];
    for (const r of rows) fresh.add(r.player_id);
    if (rows.length < PAGE) break;
  }
  return fresh;
}

interface PlayerSeed {
  player_id: number;
  full_name: string;
  current_team_id: number | null;
  current_team_name: string | null;
  primary_position: string | null;
  bat_side: string | null;
  pitch_hand: string | null;
  birth_country: string | null;
  active: boolean;
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}

function toPlayerSeed(personId: number, person: any): PlayerSeed | null {
  if (!person) return null;
  const fullName: string =
    person.fullName ??
    person.fullFMLName ??
    person.lastFirstName ??
    [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    `Player ${personId}`;

  return {
    player_id: personId,
    full_name: fullName,
    current_team_id: person?.currentTeam?.id ? Number(person.currentTeam.id) : null,
    current_team_name: person?.currentTeam?.name ?? null,
    primary_position: person?.primaryPosition?.abbreviation ?? null,
    bat_side: normHand(person?.batSide?.code),
    pitch_hand: normHand(person?.pitchHand?.code),
    birth_country: person?.birthCountry ?? null,
    active: person?.active === true || person?.active === undefined, // treat unknown as active
  };
}

async function upsertPlayers(seeds: PlayerSeed[]): Promise<number> {
  if (seeds.length === 0) return 0;
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < seeds.length; i += CHUNK) {
    const slice = seeds.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from('players')
      .upsert(slice, { onConflict: 'player_id' });
    if (error) throw new Error(`upsert players failed: ${error.message}`);
    total += slice.length;
  }
  return total;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function enrichPlayers(opts: EnrichPlayersOptions = {}): Promise<EnrichPlayersResult> {
  const delayMs = opts.delayMs ?? 200;
  const refreshDays = opts.refreshDays ?? 7;
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;

  // 1. universe of IDs we want resolved
  const [batters, pitchers] = await Promise.all([
    listDistinctIdsFromHrs('player_id'),
    listDistinctIdsFromHrs('pitcher_id'),
  ]);
  const universe = new Set<number>([...batters, ...pitchers]);
  console.log(`[enrichPlayers] universe = ${universe.size} ids (${batters.length} batters, ${pitchers.length} pitchers)`);

  // 2. subtract already-fresh
  const fresh = force ? new Set<number>() : await listFreshPlayers(refreshDays);
  let pending = Array.from(universe).filter((id) => !fresh.has(id)).sort((a, b) => a - b);
  console.log(`[enrichPlayers] ${fresh.size} already fresh (≤${refreshDays}d) → ${pending.length} to fetch`);

  if (typeof opts.limit === 'number' && opts.limit > 0 && opts.limit < pending.length) {
    console.log(`[enrichPlayers] --limit ${opts.limit} → only fetching first ${opts.limit}`);
    pending = pending.slice(0, opts.limit);
  }

  const result: EnrichPlayersResult = {
    candidates: universe.size,
    toFetch: pending.length,
    fetched: 0,
    upserted: 0,
    failures: [],
  };

  const seeds: PlayerSeed[] = [];

  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    try {
      const data = await withRetry(() => getPersonRaw(id));
      const person = data?.people?.[0];
      const seed = toPlayerSeed(id, person);
      if (!seed) {
        console.log(`  ${id} → no person returned`);
        continue;
      }
      result.fetched++;

      if (dryRun) {
        if (i % 50 === 0) {
          console.log(`  [dry-run] ${id} → ${seed.full_name} / ${seed.current_team_name ?? '(no team)'}`);
        }
        continue;
      }

      seeds.push(seed);
      if (seeds.length >= 250) {
        result.upserted += await upsertPlayers(seeds.splice(0));
      }
      if (i % 50 === 0) {
        console.log(`  ${id} → ${seed.full_name} / ${seed.current_team_name ?? '(no team)'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push({ id, error: msg });
      console.error(`  ${id} FAILED: ${msg}`);
    }
    if (i < pending.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  if (!dryRun && seeds.length > 0) {
    result.upserted += await upsertPlayers(seeds);
  }

  console.log('[enrichPlayers] DONE', result);
  return result;
}
