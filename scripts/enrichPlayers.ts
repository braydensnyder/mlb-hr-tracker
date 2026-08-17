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
import { getPersonWithSeasonHittingRaw } from './lib/mlb.js';
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
  /** True when we skipped because `players` table doesn't exist (optional). */
  skipped?: boolean;
  skipReason?: string;
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

/**
 * Mig 020 additions to the enrichment universe. Previously enrichPlayers
 * only saw players who had hit an HR OR allowed one this season, which
 * meant every contact hitter / call-up / low-power position player got
 * zero enrichment (and therefore no season slash line). Extending to
 * player_batting_lines and pitcher_starts closes that gap. Missing
 * tables (pre-mig-020 environments) are treated as empty rather than
 * fatal — the HR-only universe still works there.
 */
async function listDistinctBatterIdsFromBattingLines(): Promise<number[]> {
  const ids = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('player_batting_lines')
      .select('player_id')
      .not('player_id', 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return []; // mig 020 not applied yet
      throw new Error(`list batting_lines player_id failed: ${error.message}`);
    }
    const rows = (data ?? []) as { player_id: number }[];
    for (const r of rows) if (typeof r.player_id === 'number') ids.add(r.player_id);
    if (rows.length < PAGE) break;
  }
  return Array.from(ids);
}

async function listDistinctPitcherIdsFromStarts(): Promise<number[]> {
  const ids = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('pitcher_starts')
      .select('pitcher_id')
      .not('pitcher_id', 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`list pitcher_starts pitcher_id failed: ${error.message}`);
    }
    const rows = (data ?? []) as { pitcher_id: number }[];
    for (const r of rows) if (typeof r.pitcher_id === 'number') ids.add(r.pitcher_id);
    if (rows.length < PAGE) break;
  }
  return Array.from(ids);
}

/** Also grab opposing-starter IDs from batting lines — some pitchers
 *  never allowed an HR AND never had a start recorded (rare, but keeps
 *  the universe honest). Anything already covered above dedupes. */
async function listDistinctOpposingStartersFromBattingLines(): Promise<number[]> {
  const ids = new Set<number>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabaseAdmin
      .from('player_batting_lines')
      .select('opposing_starter_id')
      .not('opposing_starter_id', 'is', null)
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return [];
      throw new Error(`list batting_lines opposing_starter_id failed: ${error.message}`);
    }
    const rows = (data ?? []) as { opposing_starter_id: number | null }[];
    for (const r of rows) if (typeof r.opposing_starter_id === 'number') ids.add(r.opposing_starter_id);
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

/**
 * Probe Supabase for the `players` table. Returns true if reachable,
 * false if the schema cache says it doesn't exist. Anything else
 * (network, auth) is propagated as-is so genuine errors aren't masked.
 *
 * The `players` table is OPTIONAL — the rest of the pipeline (snapshots,
 * Heat Score model) derives canonical name/team from `home_runs` directly.
 * Operators who haven't applied migration 003 should see this script
 * cleanly skip rather than fail the orchestrator.
 */
function isMissingTableError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("could not find the table 'public.players'") ||
    m.includes('relation "public.players" does not exist') ||
    // PostgREST schema-cache miss: PGRST205 = table not in cache
    m.includes('pgrst205')
  );
}

async function isPlayersTableAvailable(): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('players')
    .select('player_id', { head: true, count: 'exact' })
    .limit(1);
  if (!error) return true;
  if (isMissingTableError(error.message)) return false;
  // Some other error — propagate it so the operator sees a real problem
  // instead of silently skipping.
  throw new Error(`probe players table failed: ${error.message}`);
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
  // Phase Hits ingestion (mig 020) — season slash filled from the
  // hydrated /v1/people response. Null when the player has no MLB PAs
  // this season or the stats block is missing/malformed.
  season_avg: number | null;
  season_obp: number | null;
  season_slg: number | null;
  season_ops: number | null;
  season_stats_as_of: string | null;
}

function normHand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const u = v.trim().toUpperCase();
  return u === 'L' || u === 'R' || u === 'S' ? u : null;
}

/** Parse a numeric slash-line value ("0.312", ".312", or 0.312) → number
 *  or null. The MLB API returns strings like ".312" (leading dot dropped);
 *  Number(".312") is 0.312 so this works, but we still guard for garbage. */
function parseSlashNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed === '' || trimmed === '.---' || trimmed === '-') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Extract season hitting slash from the hydrated /v1/people response.
 *  Shape: person.stats = [{ group: {displayName: 'hitting'}, type: {displayName: 'season'}, splits: [{stat: {avg, obp, slg, ops, ...}}] }]
 *  Returns nulls when the block is missing or the player has no PAs. */
function parseSeasonHitting(person: any): {
  avg: number | null; obp: number | null; slg: number | null; ops: number | null;
} {
  const empty = { avg: null, obp: null, slg: null, ops: null };
  const groups: any[] = Array.isArray(person?.stats) ? person.stats : [];
  const hitting = groups.find((g) =>
    (g?.group?.displayName?.toLowerCase?.() === 'hitting') &&
    (g?.type?.displayName?.toLowerCase?.() === 'season'),
  );
  if (!hitting) return empty;
  const splits: any[] = Array.isArray(hitting.splits) ? hitting.splits : [];
  // Multiple splits appear when the player was traded mid-season. Use
  // the last one, which MLB normalises to season totals across teams.
  const stat = splits.length > 0 ? splits[splits.length - 1]?.stat : null;
  if (!stat) return empty;
  return {
    avg: parseSlashNum(stat.avg),
    obp: parseSlashNum(stat.obp),
    slg: parseSlashNum(stat.slg),
    ops: parseSlashNum(stat.ops),
  };
}

function toPlayerSeed(personId: number, person: any): PlayerSeed | null {
  if (!person) return null;
  // Parens are required: ES2020 forbids mixing ?? and || at the same level
  // without explicit grouping. The ?? chain walks the API's name aliases;
  // the || at the end catches the empty-string case (which `??` would not).
  const fullName: string =
    (person.fullName ??
      person.fullFMLName ??
      person.lastFirstName ??
      [person.firstName, person.lastName].filter(Boolean).join(' ')) ||
    `Player ${personId}`;

  const slash = parseSeasonHitting(person);
  const anySlash = slash.avg != null || slash.obp != null || slash.slg != null || slash.ops != null;

  return {
    player_id: personId,
    full_name: fullName,
    current_team_id: person?.currentTeam?.id ? Number(person.currentTeam.id) : null,
    current_team_name: person?.currentTeam?.name ?? null,
    primary_position: person?.primaryPosition?.abbreviation ?? null,
    bat_side: normHand(person?.batSide?.code),
    pitch_hand: normHand(person?.pitchHand?.code),
    birth_country: person?.birthCountry ?? null,
    active: person?.active === true || person?.active === undefined,
    season_avg: slash.avg,
    season_obp: slash.obp,
    season_slg: slash.slg,
    season_ops: slash.ops,
    // Only stamp as_of when we actually captured at least one slash number.
    // A NULL as_of tells downstream "we don't have season stats for this
    // player" without collapsing to the ambiguous "asked at date X, got
    // nulls" case.
    season_stats_as_of: anySlash ? new Date().toISOString().slice(0, 10) : null,
  };
}

async function upsertPlayers(seeds: PlayerSeed[]): Promise<number> {
  if (seeds.length === 0) return 0;
  const CHUNK = 500;
  let total = 0;
  let stripSlash = false; // set true if mig 020 hasn't been applied
  for (let i = 0; i < seeds.length; i += CHUNK) {
    const slice = seeds.slice(i, i + CHUNK);
    const payload = stripSlash
      ? slice.map(({ season_avg, season_obp, season_slg, season_ops, season_stats_as_of, ...rest }) => rest)
      : slice;
    const { error } = await supabaseAdmin
      .from('players')
      .upsert(payload, { onConflict: 'player_id' });
    if (error) {
      // Graceful fallback: pre-mig-020 environments won't have the
      // season_* columns. Retry this chunk without those fields and
      // remember to strip on future chunks in the same run.
      if (!stripSlash && /column .* does not exist|schema cache/i.test(error.message)) {
        console.warn(`  ⚠ players.season_* columns missing — apply migration 020 to persist season slash. Continuing without.`);
        stripSlash = true;
        i -= CHUNK; // retry this chunk
        continue;
      }
      throw new Error(`upsert players failed: ${error.message}`);
    }
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

  // 0. Soft-skip when the optional `players` table doesn't exist.
  //    The rest of the pipeline doesn't depend on it — snapshots derive
  //    name/team from home_runs directly. Apply migration 003 to enable.
  const tableExists = await isPlayersTableAvailable();
  if (!tableExists) {
    const msg =
      "skipped: 'public.players' table not found. " +
      'This table is optional. To enable canonical player metadata, apply ' +
      'supabase/migrations/003_players.sql, then re-run enrich:players.';
    console.log(`[enrichPlayers] ${msg}`);
    return {
      candidates: 0,
      toFetch: 0,
      fetched: 0,
      upserted: 0,
      failures: [],
      skipped: true,
      skipReason: msg,
    };
  }

  // 1. universe of IDs we want resolved
  //
  //    Previously this was HR-hitters + HR-allowing pitchers only,
  //    which meant every position player without an HR this season
  //    (contact hitters, call-ups, low-power bench) got zero
  //    enrichment — no season slash line, no persisted metadata.
  //
  //    Mig 020 extends the universe with:
  //      - every batter that ever appeared in player_batting_lines
  //      - every pitcher that ever appeared in pitcher_starts
  //      - every opposing_starter_id from player_batting_lines
  //        (catches pitchers who neither allowed an HR nor had a
  //        pitcher_starts row — rare but possible)
  //    Sources that don't yet exist (pre-mig-020) return []; the
  //    HR-only universe still works there.
  const [
    hrBatters, hrPitchers,
    blBatters, psStarts, blOppStarters,
  ] = await Promise.all([
    listDistinctIdsFromHrs('player_id'),
    listDistinctIdsFromHrs('pitcher_id'),
    listDistinctBatterIdsFromBattingLines(),
    listDistinctPitcherIdsFromStarts(),
    listDistinctOpposingStartersFromBattingLines(),
  ]);
  const universe = new Set<number>([
    ...hrBatters, ...hrPitchers,
    ...blBatters, ...psStarts, ...blOppStarters,
  ]);
  const hrOnly = new Set<number>([...hrBatters, ...hrPitchers]);
  const addedByHits = [...universe].filter((id) => !hrOnly.has(id)).length;
  console.log(
    `[enrichPlayers] universe = ${universe.size} ids ` +
      `(hr_batters=${hrBatters.length} hr_pitchers=${hrPitchers.length} ` +
      `bl_batters=${blBatters.length} pitcher_starts=${psStarts.length} ` +
      `bl_opp_starters=${blOppStarters.length}) · ` +
      `+${addedByHits} new via mig 020 sources`,
  );

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

  // Track slash-line coverage for diagnostic at end. When the MLB API
  // returns no hitting stats for a player (pitcher / injured / no MLB
  // PAs this year), slash values legitimately land as null.
  let slashPopulated = 0;
  let slashNull = 0;

  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    try {
      const data = await withRetry(() => getPersonWithSeasonHittingRaw(id));
      const person = data?.people?.[0];
      const seed = toPlayerSeed(id, person);
      if (!seed) {
        console.log(`  ${id} → no person returned`);
        continue;
      }
      result.fetched++;
      if (seed.season_avg != null || seed.season_obp != null || seed.season_slg != null || seed.season_ops != null) {
        slashPopulated++;
      } else {
        slashNull++;
      }

      if (dryRun) {
        if (i % 50 === 0) {
          const slashPart = seed.season_avg != null ? ` avg=${seed.season_avg}` : ' (no season slash)';
          console.log(`  [dry-run] ${id} → ${seed.full_name} / ${seed.current_team_name ?? '(no team)'}${slashPart}`);
        }
        continue;
      }

      seeds.push(seed);
      if (seeds.length >= 250) {
        result.upserted += await upsertPlayers(seeds.splice(0));
      }
      if (i % 50 === 0) {
        const slashPart = seed.season_avg != null ? ` avg=${seed.season_avg}` : ' (no season slash)';
        console.log(`  ${id} → ${seed.full_name} / ${seed.current_team_name ?? '(no team)'}${slashPart}`);
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

  const slashPct = result.fetched > 0 ? (slashPopulated / result.fetched * 100).toFixed(1) : '0.0';
  console.log(
    `[enrichPlayers] season slash coverage: ${slashPopulated}/${result.fetched} fetched had slash (${slashPct}%). ` +
      `${slashNull} legitimately had no MLB hitting stats this season (pitchers, injured, unpromoted).`,
  );
  console.log('[enrichPlayers] DONE', result);
  return result;
}
