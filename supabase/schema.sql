-- =====================================================================
-- HR Tracker — Supabase / Postgres schema
-- Run this once in the Supabase SQL editor (or via psql) on a fresh DB.
-- It is idempotent: safe to re-run.
-- =====================================================================

-- ---------- 1. games ----------
-- One row per MLB game (regardless of HRs). We use this to know which
-- games we still need to process and which are already done.
create table if not exists public.games (
  game_pk        bigint       primary key,            -- MLB's unique game id
  game_date      date         not null,               -- official MLB game date (US/Eastern)
  home_team      text         not null,
  away_team      text         not null,
  status         text         not null,               -- "Final", "In Progress", "Scheduled", etc.
  game_type      text,                                 -- 'R' regular, 'F'/'D'/'L'/'W' postseason, 'S' spring, 'E' exhibition, 'A' all-star, ...
  processed      boolean      not null default false, -- true once we've extracted HRs
  processed_at   timestamptz,

  -- Matchup context (filled by fetchSchedule from the MLB API):
  venue_id                    bigint,
  venue_name                  text,
  home_probable_pitcher_id    bigint,
  home_probable_pitcher_name  text,
  home_probable_pitcher_hand  text,  -- 'L' | 'R'
  away_probable_pitcher_id    bigint,
  away_probable_pitcher_name  text,
  away_probable_pitcher_hand  text,

  -- Weather placeholder (no fetcher wired yet — see HR Heat Score weather slot).
  weather                     jsonb,
  weather_temp_f              numeric(5,2),
  weather_wind_mph            numeric(5,2),
  weather_wind_dir            text,

  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now()
);

create index if not exists games_game_date_idx on public.games (game_date);
create index if not exists games_status_idx    on public.games (status);
create index if not exists games_game_type_idx on public.games (game_type);
create index if not exists games_venue_idx     on public.games (venue_name);
create index if not exists games_venue_id_idx  on public.games (venue_id);
create index if not exists games_unprocessed_idx
  on public.games (game_date)
  where processed = false;

-- ---------- 2. home_runs ----------
-- One row per HR event. Uniqueness is enforced on (game_pk, player_id, inning, sequence-ish)
-- via a generated event_key so re-running an import doesn't duplicate rows.
create table if not exists public.home_runs (
  id              bigserial    primary key,
  game_pk         bigint       not null references public.games(game_pk) on delete cascade,
  game_date       date         not null,
  player_id       bigint       not null,
  player_name     text         not null,
  team            text         not null,
  opponent        text         not null,
  inning          int,
  pitcher_id      bigint,
  pitcher_name    text,
  exit_velocity   numeric(5,2),
  launch_angle    numeric(5,2),
  distance        numeric(6,2),

  -- Matchup context (populated by extractor going forward; backfill via
  -- `npm run enrich:handedness` and `npm run enrich:venues`):
  batter_side     text,        -- 'L' | 'R' | 'S' (per-AB side)
  pitcher_throws  text,        -- 'L' | 'R'
  venue_id        bigint,
  venue_name      text,

  -- Stable per-event dedup key (game + player + inning + at-bat index, when available)
  event_key       text         not null,
  created_at      timestamptz  not null default now()
);

create unique index if not exists home_runs_event_key_uq on public.home_runs (event_key);
create index if not exists home_runs_game_pk_idx       on public.home_runs (game_pk);
create index if not exists home_runs_player_id_idx     on public.home_runs (player_id);
create index if not exists home_runs_game_date_idx     on public.home_runs (game_date);
create index if not exists home_runs_player_date_idx   on public.home_runs (player_id, game_date desc);
create index if not exists home_runs_pitcher_id_idx    on public.home_runs (pitcher_id);
create index if not exists home_runs_pitcher_date_idx  on public.home_runs (pitcher_id, game_date desc);
create index if not exists home_runs_venue_date_idx    on public.home_runs (venue_name, game_date desc);
create index if not exists home_runs_venue_id_idx      on public.home_runs (venue_id);
create index if not exists home_runs_batter_side_idx   on public.home_runs (batter_side);
create index if not exists home_runs_pitcher_throws_idx on public.home_runs (pitcher_throws);

-- ---------- 3. player_daily_summary ----------
-- Rolling stats per (player, date). Rebuilt by rebuildPlayerSummaries().
-- One row per player per date that they had HR activity (or, when called
-- with a target date, every player who had a HR within the relevant window).
create table if not exists public.player_daily_summary (
  player_id          bigint  not null,
  player_name        text    not null,
  date               date    not null,
  team               text    not null,
  hrs_today          int     not null default 0,
  season_total       int     not null default 0,
  hrs_last_3_games   int     not null default 0,
  hrs_last_5_games   int     not null default 0,
  hrs_last_7_days    int     not null default 0,
  last_hr_date       date,
  updated_at         timestamptz not null default now(),
  primary key (player_id, date)
);

create index if not exists pds_date_idx          on public.player_daily_summary (date);
create index if not exists pds_season_total_idx  on public.player_daily_summary (date, season_total desc);
create index if not exists pds_today_idx         on public.player_daily_summary (date, hrs_today desc);

-- ---------- updated_at triggers ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_games_touch on public.games;
create trigger trg_games_touch
  before update on public.games
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_pds_touch on public.player_daily_summary;
create trigger trg_pds_touch
  before update on public.player_daily_summary
  for each row execute function public.touch_updated_at();

-- ---------- Read-only RLS for the anon key ----------
-- The frontend uses the anon key. All writes go through the service-role
-- key in backend scripts, which bypasses RLS.
alter table public.games                  enable row level security;
alter table public.home_runs              enable row level security;
alter table public.player_daily_summary   enable row level security;

drop policy if exists "public read games"             on public.games;
drop policy if exists "public read home_runs"         on public.home_runs;
drop policy if exists "public read summaries"         on public.player_daily_summary;

create policy "public read games"
  on public.games for select using (true);

create policy "public read home_runs"
  on public.home_runs for select using (true);

create policy "public read summaries"
  on public.player_daily_summary for select using (true);

-- ---------- 4. venues (canonical catalog) ----------
-- Populated by enrich:venues from the live game feed and by processDate
-- when the schedule includes venue info.
create table if not exists public.venues (
  venue_id    bigint       primary key,
  name        text         not null,
  city        text,
  state       text,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now()
);

drop trigger if exists trg_venues_touch on public.venues;
create trigger trg_venues_touch
  before update on public.venues
  for each row execute function public.touch_updated_at();

alter table public.venues enable row level security;
drop policy if exists "public read venues" on public.venues;
create policy "public read venues" on public.venues for select using (true);

-- ---------- 5. venue_hr_summary (derived cache) ----------
-- Maintained by enrich:venues. Frontend reads this for fast venue
-- leaderboards but falls back to client-side compute from home_runs if
-- the table is empty / stale. home_runs remains the single source of truth.
create table if not exists public.venue_hr_summary (
  venue_id          bigint       primary key,
  venue_name        text         not null,
  computed_for      date         not null,
  hrs_season        int          not null default 0,
  hrs_l7d           int          not null default 0,
  hrs_l14d          int          not null default 0,
  unique_hitters    int          not null default 0,
  teams_seen        text[]       not null default '{}',
  updated_at        timestamptz  not null default now()
);

create index if not exists venue_hr_summary_l14_idx
  on public.venue_hr_summary (computed_for, hrs_l14d desc);
create index if not exists venue_hr_summary_season_idx
  on public.venue_hr_summary (computed_for, hrs_season desc);

drop trigger if exists trg_venue_summary_touch on public.venue_hr_summary;
create trigger trg_venue_summary_touch
  before update on public.venue_hr_summary
  for each row execute function public.touch_updated_at();

alter table public.venue_hr_summary enable row level security;
drop policy if exists "public read venue_hr_summary" on public.venue_hr_summary;
create policy "public read venue_hr_summary" on public.venue_hr_summary for select using (true);

-- ---------- 6. players (canonical catalog) ----------
-- Resolves a hitter's *current MLB team*. The frontend prefers this over
-- the per-HR `team` field (which can carry a non-MLB name like
-- "United States" for WBC games). Maintained by `npm run enrich:players`
-- from /v1/people/{id}.
create table if not exists public.players (
  player_id          bigint       primary key,
  full_name          text         not null,
  current_team_id    bigint,
  current_team_name  text,
  primary_position   text,
  bat_side           text,        -- 'L' | 'R' | 'S'
  pitch_hand         text,        -- 'L' | 'R'
  birth_country      text,        -- kept for context, NEVER used as team
  active             boolean      not null default true,
  created_at         timestamptz  not null default now(),
  updated_at         timestamptz  not null default now()
);

create index if not exists players_team_idx     on public.players (current_team_name);
create index if not exists players_team_id_idx  on public.players (current_team_id);
create index if not exists players_active_idx   on public.players (active);
create index if not exists players_updated_idx  on public.players (updated_at);

drop trigger if exists trg_players_touch on public.players;
create trigger trg_players_touch
  before update on public.players
  for each row execute function public.touch_updated_at();

alter table public.players enable row level security;
drop policy if exists "public read players" on public.players;
create policy "public read players" on public.players for select using (true);

-- ---------- 7. pitcher_starts (canonical shape, see migration 006) ----------
-- One row per (game_id, pitcher_id) for every starting pitcher. Captures HR
-- allowed + full pitching line so the HR Targets page can compute accurate
-- pitcher form (HR allowed L3 starts / L5 starts / L14d / season) — instead
-- of approximating from home_runs (which misses 0-HR starts).
create table if not exists public.pitcher_starts (
  game_id            bigint       not null,
  game_date          date         not null,
  pitcher_id         bigint       not null,
  pitcher_name       text,
  pitcher_hand       text,        -- 'L' | 'R'
  team_id            bigint,
  team_name          text,
  opponent_id        bigint,
  opponent_name      text,
  venue_id           bigint,
  venue_name         text,
  innings_pitched    numeric(4,1),
  hits_allowed       int,
  earned_runs        int,
  home_runs_allowed  int          not null default 0,
  walks              int,
  strikeouts         int,
  pitches            int,
  decision           text,        -- 'W' | 'L' | 'SV' | 'H' | 'BS' | null
  created_at         timestamptz  not null default now(),
  primary key (game_id, pitcher_id)
);

create index if not exists pitcher_starts_pitcher_id_idx       on public.pitcher_starts (pitcher_id);
create index if not exists pitcher_starts_game_date_idx        on public.pitcher_starts (game_date desc);
create index if not exists pitcher_starts_pitcher_date_idx     on public.pitcher_starts (pitcher_id, game_date desc);
create index if not exists pitcher_starts_hr_allowed_idx       on public.pitcher_starts (home_runs_allowed);

alter table public.pitcher_starts enable row level security;
drop policy if exists "public read pitcher_starts" on public.pitcher_starts;
create policy "public read pitcher_starts" on public.pitcher_starts for select using (true);

-- ---------- 8. hr_target_snapshots ----------
-- Persisted Top-N HR target rankings. Surrogate `id` PK + unique constraint
-- on (target_date, player_id, game_pk). `snapshot_date` records when the
-- row was written; `target_date` is the day games are predicted FOR.
-- Drives the Backtest page.
create table if not exists public.hr_target_snapshots (
  id             bigserial    primary key,
  target_date    date         not null,
  snapshot_date  timestamptz  not null default now(),
  player_id      bigint       not null,
  player_name    text         not null,
  team           text         not null,
  opponent       text         not null,
  game_pk        bigint       not null,
  rank           int          not null,
  heat_score     numeric(5,1) not null,
  reason         text,
  -- 'live' = taken before games started for target_date (honest pre-game pick).
  -- 'simulated' = backfilled after the fact via snapshot:range; approximates
  -- what the model would have said using data ≤ asOf=target_date-1.
  snapshot_type  text         not null default 'live'
    check (snapshot_type in ('live', 'simulated')),
  created_at     timestamptz  not null default now(),
  constraint hr_target_snapshots_target_player_game_uq
    unique (target_date, player_id, game_pk)
);

create index if not exists hr_target_snapshots_target_date_idx   on public.hr_target_snapshots (target_date);
create index if not exists hr_target_snapshots_rank_idx          on public.hr_target_snapshots (rank);
create index if not exists hr_target_snapshots_player_id_idx     on public.hr_target_snapshots (player_id);
create index if not exists hr_target_snapshots_heat_score_idx    on public.hr_target_snapshots (heat_score desc);
create index if not exists hr_target_snapshots_snapshot_type_idx on public.hr_target_snapshots (snapshot_type);

alter table public.hr_target_snapshots enable row level security;
drop policy if exists "public read hr_target_snapshots" on public.hr_target_snapshots;
create policy "public read hr_target_snapshots"
  on public.hr_target_snapshots for select using (true);
