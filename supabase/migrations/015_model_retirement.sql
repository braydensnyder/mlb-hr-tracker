-- =====================================================================
-- Migration 015 — Manual model retirement (Phase: Champion System)
--
-- Adds a retired flag to model_versions so underperforming models can be
-- removed from comparison views WITHOUT deleting the historical
-- learning_predictions rows they generated.
--
-- We deliberately do NOT add an auto-retirement policy here — that
-- decision is a judgment call (a 3-day cold streak doesn't kill a model).
-- The UI surfaces underperformers via Champion ranking; the operator
-- marks them retired manually:
--
--   update model_versions set retired = true, retired_at = now(),
--          retired_reason = 'consistently below v1 across 30d window'
--   where version = 4;
--
-- Idempotent — IF NOT EXISTS on every change.
-- =====================================================================

alter table public.model_versions
  add column if not exists retired        boolean not null default false,
  add column if not exists retired_at     timestamptz,
  add column if not exists retired_reason text;

create index if not exists model_versions_retired_idx
  on public.model_versions (retired);

-- Helper: model_versions_active_or_kept = "show in comparison views"
-- The frontend filter is `retired = false`; we don't need a view since
-- the column is indexed and queries are simple.
