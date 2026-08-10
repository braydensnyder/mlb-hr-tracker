-- =====================================================================
-- Migration 016 — Snapshot state baseline + change log (Priority 2)
--
-- We want to distinguish "the model was wrong" from "information
-- changed after the pick was locked in." That requires TWO pieces:
--
--   1. game_state_at_snapshot — a frozen copy of the pre-game context
--      (lineup confirmation, probable pitcher, weather) at the moment
--      snapshotHrTargets ran. This is the baseline everything else diffs
--      against.
--
--   2. snapshot_changes — a delta log written after the fact when the
--      afternoon cron notices the game state has moved (lineup posted,
--      pitcher swapped, weather worsened, odds moved sharply).
--
-- We do NOT re-derive the "changed after snapshot" flag every page load;
-- the change log is the source of truth and the frontend just reads it.
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- ---------- 1) game_state_at_snapshot ----------
create table if not exists public.game_state_at_snapshot (
  target_date               date not null,
  game_pk                   int  not null,
  captured_at               timestamptz not null default now(),
  -- Frozen fields as they were when the snapshot was taken:
  lineups_confirmed         boolean,
  home_probable_pitcher_id  int,
  away_probable_pitcher_id  int,
  weather_temp_f            numeric,
  weather_wind_mph          numeric,
  weather_wind_dir          text,
  primary key (target_date, game_pk)
);

create index if not exists gsas_target_date_idx on public.game_state_at_snapshot (target_date);

-- ---------- 2) snapshot_changes ----------
create table if not exists public.snapshot_changes (
  id           bigserial primary key,
  target_date  date not null,
  game_pk      int,               -- may be null for player-level odds changes
  player_id    int,               -- null for game-wide changes
  change_type  text not null,     -- 'lineup_confirmed','probable_pitcher','weather_temp','weather_wind','odds_move'
  from_value   jsonb,
  to_value     jsonb,
  delta_note   text,              -- short human summary ('+7°F', 'RHP → LHP', etc.)
  detected_at  timestamptz not null default now()
);

create index if not exists snapshot_changes_date_idx    on public.snapshot_changes (target_date);
create index if not exists snapshot_changes_type_idx    on public.snapshot_changes (target_date, change_type);
create index if not exists snapshot_changes_player_idx  on public.snapshot_changes (target_date, player_id) where player_id is not null;
create index if not exists snapshot_changes_game_idx    on public.snapshot_changes (target_date, game_pk)   where game_pk is not null;

-- ---------- Anon read policies ----------
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'game_state_at_snapshot' and policyname = 'allow_anon_read') then
    execute 'create policy allow_anon_read on public.game_state_at_snapshot for select to anon using (true)';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'snapshot_changes' and policyname = 'allow_anon_read') then
    execute 'create policy allow_anon_read on public.snapshot_changes for select to anon using (true)';
  end if;
end$$;

alter table public.game_state_at_snapshot enable row level security;
alter table public.snapshot_changes       enable row level security;
