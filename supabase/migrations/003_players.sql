-- =====================================================================
-- Migration 003 — canonical players table
--
-- Adds a players catalog so we can resolve a hitter's *current MLB team*
-- (e.g., "New York Yankees") instead of falling back to whatever team
-- string was on their last home_runs row (which can be a non-MLB name like
-- "United States" if a WBC / exhibition game was ever ingested).
--
-- Maintained by `npm run enrich:players` from /v1/people/{id}.
-- Idempotent.
-- =====================================================================

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

-- updated_at trigger (touch_updated_at() lives in the original schema)
drop trigger if exists trg_players_touch on public.players;
create trigger trg_players_touch
  before update on public.players
  for each row execute function public.touch_updated_at();

alter table public.players enable row level security;
drop policy if exists "public read players" on public.players;
create policy "public read players" on public.players for select using (true);
