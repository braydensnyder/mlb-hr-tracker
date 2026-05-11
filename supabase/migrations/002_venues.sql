-- =====================================================================
-- Migration 002 — venues
-- Adds venue_id columns and a canonical venues table + a derived
-- venue_hr_summary cache. Idempotent; apply on top of an existing DB.
-- Fresh installs already include these (see ../schema.sql).
-- =====================================================================

-- ---- venue_id columns on existing tables ----
alter table public.home_runs
  add column if not exists venue_id bigint;

alter table public.games
  add column if not exists venue_id bigint;

create index if not exists home_runs_venue_id_idx on public.home_runs (venue_id);
create index if not exists games_venue_id_idx     on public.games (venue_id);

-- ---- canonical venues catalog ----
-- One row per stadium/venue, identified by MLB's venue_id. Populated
-- by enrich:venues (which reads it from the live game feed) and by
-- processDate when the schedule includes a venue.
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

-- ---- derived: venue HR summary ----
-- Maintained by enrich:venues. Frontend can read this for fast venue
-- leaderboards instead of recomputing from raw home_runs every load.
-- The frontend still falls back to client-side compute if this table is
-- empty / stale, so home_runs remains the single source of truth.
create table if not exists public.venue_hr_summary (
  venue_id          bigint       primary key,
  venue_name        text         not null,
  computed_for      date         not null,        -- the as-of date these counts were anchored at
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
