-- Migration: Scraper Agent (Agent #6)
-- Race data collection and backfill system

-- ======================
-- Race Results Tables
-- ======================

-- Main race results table
CREATE TABLE IF NOT EXISTS race_results_master (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_code TEXT NOT NULL,
  track_name TEXT NOT NULL,
  race_date DATE NOT NULL,
  race_number INT NOT NULL,
  distance TEXT,
  surface TEXT CHECK (surface IN ('dirt', 'turf', 'synthetic')),
  track_condition TEXT,
  payouts JSONB,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(track_code, race_date, race_number)
);

-- Individual finishers table
CREATE TABLE IF NOT EXISTS race_finishers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id UUID REFERENCES race_results_master(id) ON DELETE CASCADE,
  finish_position INT NOT NULL,
  post_position INT NOT NULL,
  horse_name TEXT NOT NULL,
  jockey TEXT,
  odds TEXT,
  final_time TEXT,
  -- GPS metrics
  avg_speed_mph DECIMAL(5,2),
  stride_length_ft DECIMAL(5,2),
  cumulative_distance_ft DECIMAL(8,2),
  path_efficiency_pct DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_race_results_date ON race_results_master(race_date DESC);
CREATE INDEX IF NOT EXISTS idx_race_results_track ON race_results_master(track_code);
CREATE INDEX IF NOT EXISTS idx_race_results_track_date ON race_results_master(track_code, race_date);
CREATE INDEX IF NOT EXISTS idx_race_finishers_race ON race_finishers(race_id);
CREATE INDEX IF NOT EXISTS idx_race_finishers_horse ON race_finishers(horse_name);

-- ======================
-- Trigger Rule
-- ======================

-- Create the race backfill trigger
INSERT INTO ops_trigger_rules (
  name,
  trigger_event,
  conditions,
  action_config,
  enabled,
  cooldown_minutes,
  fire_count
) VALUES (
  'Scraper: Race Data Backfill',
  'race_backfill',
  jsonb_build_object(
    'target_tracks', '["AQU", "FG", "GP", "OP", "SA", "TAM", "TP"]'::jsonb,
    'start_date', '2025-11-08',
    'end_date', '2026-02-07',
    'skip_probability', 0.05,
    'max_races_per_trigger', 1
  ),
  jsonb_build_object(
    'target_agent', 'scraper',
    'title_template', 'Scrape race data',
    'step_kind', 'scrape_race_data',
    'daily_limit', 50
  ),
  true,
  120,
  0
)
ON CONFLICT DO NOTHING;
