-- =====================================================================
-- Migration 020 — Hits-tab ingestion prerequisites
--
-- The codebase was built around HRs. This migration adds the ingestion
-- surface for a parallel Hits tab (1+ hit / 2+ hits ranking), sharing
-- game / lineup / pitcher plumbing but keeping the HR model completely
-- untouched.
--
-- Three tables:
--   1. player_batting_lines       per-player-per-game batter line
--   2. player_daily_hit_summary   rolling per-player summary
--   3. pitcher_form               persisted pitcher rate stats (WHIP/H9/K9/BB9)
--
-- Data source: liveData.boxscore.teams.{home,away}.players[*].stats.batting
-- from the SAME game feed extractPitcherStarts already fetches. Zero
-- extra API calls per game — we just persist a branch of the feed the
-- current extractor drops on the floor.
--
-- Season slash (players.season_avg etc.) is filled by the extended
-- enrichPlayers.ts using ?hydrate=stats(group=[hitting],type=[season])
-- and DOES cost one extra call per rostered player per enrich pass.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. player_batting_lines — one row per (target_date, game_pk, player_id)
-- ---------------------------------------------------------------------

create table if not exists public.player_batting_lines (
  id                       bigserial primary key,

  -- Identity
  target_date              date        not null,
  game_pk                  int         not null,
  player_id                int         not null,
  player_name              text        not null,
  team                     text        not null,
  opponent                 text,

  -- Core batting line (as reported by boxscore.batting)
  at_bats                  int         not null default 0,
  hits                     int         not null default 0,
  plate_appearances        int         not null default 0,
  doubles                  int         not null default 0,
  triples                  int         not null default 0,
  home_runs                int         not null default 0,
  walks                    int         not null default 0,
  strikeouts               int         not null default 0,
  hit_by_pitch             int         not null default 0,
  sac_flies                int         not null default 0,

  -- Context — lineup slot 1..9 (index+1 in the ordered lineup array).
  -- NULL when the player was not in the posted starting lineup (bench
  -- appearance, pinch-hit, defensive sub). Consumers should exclude
  -- NULL-slot rows from expected-PA math but INCLUDE them in raw hit
  -- counts.
  batting_order_slot       smallint,

  -- Starter-hand attribution for platoon context (v1 approximation).
  -- We attribute this row's hits to the OPPOSING starting pitcher's
  -- hand, not the actual pitcher of each individual PA. Slightly
  -- conflates hits off relievers of the other hand — see mig 020
  -- header comment above; kept cheap for v1.
  opposing_starter_id      int,
  opposing_starter_hand    text,       -- 'L' | 'R' | NULL

  -- Batter's own handedness (populated from players catalog when known).
  -- Useful for filtering "L-vs-R platoon edge" downstream.
  batter_side              text,       -- 'L' | 'R' | 'S' | NULL

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (target_date, game_pk, player_id)
);

create index if not exists pbl_date_player_idx
  on public.player_batting_lines (target_date, player_id);
create index if not exists pbl_player_date_idx
  on public.player_batting_lines (player_id, target_date desc);
create index if not exists pbl_game_pk_idx
  on public.player_batting_lines (game_pk);
create index if not exists pbl_team_date_idx
  on public.player_batting_lines (team, target_date);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'player_batting_lines' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.player_batting_lines for select to anon using (true)';
  end if;
end$$;
alter table public.player_batting_lines enable row level security;


-- ---------------------------------------------------------------------
--  2. player_daily_hit_summary — rolling per-player summary
-- ---------------------------------------------------------------------
--
-- Materialized nightly by scripts/rebuildHitSummaries.ts. Each row is
-- an AS-OF snapshot for (summary_date, player_id): every rolling
-- window uses data through summary_date inclusive.
--
-- Consumers (Hit Score v1) should fetch the single latest row per
-- player, or query for a specific date.

create table if not exists public.player_daily_hit_summary (
  id                        bigserial primary key,

  summary_date              date not null,
  player_id                 int  not null,
  player_name               text,
  team                      text,

  -- Raw rolling counts (calendar-day windows keyed on game_date).
  hits_l3g                  int,        -- hits in last 3 games player appeared in
  hits_l5g                  int,        -- last 5 games appeared
  hits_l7d                  int,        -- last 7 calendar days
  hits_l14d                 int,        -- last 14 calendar days
  ab_l3g                    int,
  ab_l5g                    int,
  ab_l7d                    int,
  pa_l7d                    int,

  -- Rate stats derived from raw counts (NULL when denominator is 0).
  hit_rate_l3g              numeric,    -- hits_l3g / ab_l3g
  hit_rate_l5g              numeric,
  hit_rate_l7d              numeric,

  -- Multi-hit events over last-N-games windows.
  multi_hit_games_l5g       int,        -- count of games with hits >= 2 in last 5 appearances
  multi_hit_games_l10g      int,        -- last 10 appearances

  -- Recent extra-base + K/BB context.
  doubles_l7d               int,
  triples_l14d              int,
  strikeout_rate_l7d        numeric,    -- strikeouts_l7d / pa_l7d
  walks_l7d                 int,

  -- Platoon splits (starter-hand attribution — see player_batting_lines).
  hits_vs_lhp_starters      int,        -- season-to-date; window configurable in code
  hits_vs_rhp_starters      int,
  ab_vs_lhp_starters        int,
  ab_vs_rhp_starters        int,

  -- Season slash (mirrored from players table when available).
  season_avg                numeric,
  season_obp                numeric,
  season_slg                numeric,
  season_ops                numeric,

  -- Flags — set when a field is missing from underlying data so
  -- downstream consumers (rank-conditioned analysis, Hit Score v1)
  -- can filter cleanly without treating missing as zero.
  flags                     text[] not null default '{}',

  last_updated              timestamptz not null default now(),

  unique (summary_date, player_id)
);

create index if not exists pdhs_date_idx
  on public.player_daily_hit_summary (summary_date);
create index if not exists pdhs_player_date_idx
  on public.player_daily_hit_summary (player_id, summary_date desc);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'player_daily_hit_summary' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.player_daily_hit_summary for select to anon using (true)';
  end if;
end$$;
alter table public.player_daily_hit_summary enable row level security;


-- ---------------------------------------------------------------------
--  3. pitcher_form — persisted pitcher rate stats
-- ---------------------------------------------------------------------
--
-- One row per pitcher, refreshed nightly. Consumers (Hit Score v1)
-- read directly from this table rather than recomputing rates on
-- every snapshot. The HR pipeline continues to compute K/9 and BB/9
-- on the fly inside snapshotHrTargets and is NOT changed to read
-- from here (isolation contract).
--
-- All computed from public.pitcher_starts, which the current
-- extractPitcherStarts.ts already populates.

create table if not exists public.pitcher_form (
  pitcher_id            int primary key,
  pitcher_name          text,
  pitcher_throws        text,           -- 'L' | 'R' | NULL

  as_of                 date not null,  -- date the rates reflect (inclusive)
  starts_known          int  not null default 0,

  -- Season-to-date raw totals (rates below derive from these).
  total_ip              numeric not null default 0,
  total_hits_allowed    int     not null default 0,
  total_walks           int     not null default 0,
  total_strikeouts      int     not null default 0,
  total_hr_allowed      int     not null default 0,

  -- Rate stats (per 9 IP). NULL when starts_known < 3 or total_ip < 18
  -- (matches the ratesValid guard in snapshotHrTargets.ts).
  h_per_9               numeric,
  k_per_9               numeric,
  bb_per_9              numeric,
  hr_per_9              numeric,
  whip                  numeric,        -- (walks + hits) / IP

  -- Recent-start rollups.
  hits_l3_starts        int,
  hits_l5_starts        int,
  ip_l3_starts          numeric,
  ip_l5_starts          numeric,

  last_start_date       date,
  updated_at            timestamptz not null default now()
);

create index if not exists pf_as_of_idx on public.pitcher_form (as_of);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pitcher_form' and policyname = 'allow_anon_read'
  ) then
    execute 'create policy allow_anon_read on public.pitcher_form for select to anon using (true)';
  end if;
end$$;
alter table public.pitcher_form enable row level security;


-- ---------------------------------------------------------------------
--  4. Season slash on players (from enrichPlayers hydrate)
-- ---------------------------------------------------------------------
--
-- Existing players catalog gets four nullable numeric columns so the
-- enrichPlayers pass can persist season slash retrieved via
-- ?hydrate=stats(group=[hitting],type=[season]).
--
-- Older callers that select * on players are unaffected — nullable
-- columns default to NULL.

alter table public.players
  add column if not exists season_avg      numeric,
  add column if not exists season_obp      numeric,
  add column if not exists season_slg      numeric,
  add column if not exists season_ops      numeric,
  add column if not exists season_stats_as_of date;

comment on column public.players.season_avg is
  'Season-to-date batting average, hydrated by enrichPlayers via '
  '/v1/people/{id}?hydrate=stats(group=[hitting],type=[season]). NULL when '
  'the player has no MLB PAs yet this season or hydrate call failed.';
