-- Migration 008: RealComply CA Broker Pipeline
-- Run this in Supabase SQL editor
-- Creates tables for the broker lead generation pipeline:
--   ca_brokers          - scraped DRE broker listings
--   ops_outreach_emails - generated personalized cold emails

-- ============================================================
-- 1. ca_brokers
-- Stores CA DRE broker records scraped from public license search.
-- Pipeline: pending → research_status=completed → outreach_status=ready
-- ============================================================

CREATE TABLE IF NOT EXISTS ca_brokers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              TIMESTAMPTZ DEFAULT now(),

  -- From DRE scrape
  license_number          TEXT UNIQUE NOT NULL,
  name                    TEXT NOT NULL,
  city                    TEXT,
  county                  TEXT,
  license_type            TEXT,           -- 'broker' | 'corporate_broker'
  status                  TEXT DEFAULT 'active',
  expiration_date         DATE,
  source                  TEXT DEFAULT 'dre_scrape',
  scraped_at              TIMESTAMPTZ,

  -- Research stage (analyst worker)
  research_status         TEXT DEFAULT 'pending', -- pending | running | completed | failed
  researched_at           TIMESTAMPTZ,
  research_notes          TEXT,           -- Claude's summary
  website                 TEXT,
  linkedin_url            TEXT,
  estimated_team_size     TEXT,           -- solo | small | mid-size | large | unknown
  specialties             TEXT[],
  pain_points             TEXT[],
  compliance_risk_score   TEXT,           -- low | medium | high
  personalization_hook    TEXT,           -- Claude's suggested opener

  -- Outreach stage (content-marketer worker)
  outreach_status         TEXT DEFAULT 'pending', -- pending | ready | sent | failed
  outreach_generated_at   TIMESTAMPTZ,
  outreach_email_subject  TEXT,
  outreach_email_body     TEXT,
  outreach_sent_at        TIMESTAMPTZ,
  outreach_notes          TEXT
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ca_brokers_research_status ON ca_brokers(research_status);
CREATE INDEX IF NOT EXISTS idx_ca_brokers_outreach_status ON ca_brokers(outreach_status);
CREATE INDEX IF NOT EXISTS idx_ca_brokers_county ON ca_brokers(county);
CREATE INDEX IF NOT EXISTS idx_ca_brokers_created_at ON ca_brokers(created_at);

-- ============================================================
-- 2. ops_outreach_emails
-- Stores generated cold emails for the dashboard to display.
-- A copy of what's in ca_brokers but easier to query for the UI.
-- ============================================================

CREATE TABLE IF NOT EXISTS ops_outreach_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT now(),
  broker_id       UUID REFERENCES ca_brokers(id),
  license_number  TEXT,
  broker_name     TEXT,
  city            TEXT,
  county          TEXT,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT DEFAULT 'ready',  -- ready | sent | bounced | opened | replied
  mission_id      UUID REFERENCES ops_missions(id),
  sent_at         TIMESTAMPTZ,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_ops_outreach_emails_status ON ops_outreach_emails(status);
CREATE INDEX IF NOT EXISTS idx_ops_outreach_emails_broker_id ON ops_outreach_emails(broker_id);
CREATE INDEX IF NOT EXISTS idx_ops_outreach_emails_created_at ON ops_outreach_emails(created_at);

-- ============================================================
-- 3. Disable/remove old horse racing trigger rules from ops_trigger_rules
-- ============================================================

-- Disable (don't delete, in case you want the IDs for reference)
UPDATE ops_trigger_rules SET enabled = false
WHERE trigger_event IN ('race_backfill')
   OR name ILIKE '%horse racing%'
   OR name ILIKE '%race%'
   OR name ILIKE '%prospector: horse%';

-- ============================================================
-- 4. Insert new trigger rules for the RealComply pipeline
-- ============================================================

-- Trigger: DRE scrape - runs daily, keeps broker pipeline topped up
INSERT INTO ops_trigger_rules (name, trigger_event, conditions, action_config, cooldown_minutes, enabled)
VALUES (
  'DRE Broker Scrape',
  'dre_broker_scrape',
  jsonb_build_object(
    'skip_probability', 0.05,
    'min_pending_brokers', 20,
    'batch_size', 50
  ),
  jsonb_build_object(
    'target_agent', 'prospector',
    'step_kind', 'scrape_dre'
  ),
  1440,  -- once per day cooldown
  true
)
ON CONFLICT DO NOTHING;

-- Trigger: Prospector - picks next unresearched broker and queues research
INSERT INTO ops_trigger_rules (name, trigger_event, conditions, action_config, cooldown_minutes, enabled)
VALUES (
  'Prospector: CA Broker Lead Gen',
  'proactive_prospector_lead_gen',
  jsonb_build_object(
    'skip_probability', 0.1
  ),
  jsonb_build_object(
    'target_agent', 'analyst',
    'step_kind', 'research',
    'title_template', 'Research CA Broker'
  ),
  30,   -- every 30 min
  true
)
ON CONFLICT DO NOTHING;

-- Trigger: Content marketer - picks researched brokers and writes outreach emails
INSERT INTO ops_trigger_rules (name, trigger_event, conditions, action_config, cooldown_minutes, enabled)
VALUES (
  'Content Marketer: Broker Outreach Emails',
  'proactive_content_opportunity',
  jsonb_build_object(
    'skip_probability', 0.05,
    'lookback_hours', 48
  ),
  jsonb_build_object(
    'target_agent', 'content_marketer',
    'step_kind', 'write_content',
    'title_template', 'Write outreach email'
  ),
  15,  -- every 15 min
  true
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 5. Update ops_policy for new agent and step limits
-- ============================================================

-- Enable the prospector agent
INSERT INTO ops_policy (key, value)
VALUES ('agent_prospector', jsonb_build_object('enabled', true, 'max_daily_proposals', 20))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Enable the analyst agent
INSERT INTO ops_policy (key, value)
VALUES ('agent_analyst', jsonb_build_object('enabled', true, 'max_daily_proposals', 20))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Enable the content_marketer agent
INSERT INTO ops_policy (key, value)
VALUES ('agent_content_marketer', jsonb_build_object('enabled', true, 'max_daily_proposals', 20))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Update daily limits to match new step kinds
INSERT INTO ops_policy (key, value)
VALUES ('daily_limits', jsonb_build_object(
  'max_analyze_per_day', 10,
  'max_research_per_day', 20,
  'max_content_per_day', 20,
  'max_dre_scrape_per_day', 3
))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Enable auto-approve for scrape_dre, research, and write_content
-- (these run headlessly, no human review needed)
INSERT INTO ops_policy (key, value)
VALUES ('auto_approve', jsonb_build_object(
  'enabled', true,
  'allowed_step_kinds', ARRAY['scrape_dre', 'research', 'write_content']
))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================
-- 6. Helpful view: pipeline status at a glance
-- ============================================================

CREATE OR REPLACE VIEW v_broker_pipeline AS
SELECT
  COUNT(*) FILTER (WHERE research_status = 'pending')   AS pending_research,
  COUNT(*) FILTER (WHERE research_status = 'running')   AS running_research,
  COUNT(*) FILTER (WHERE research_status = 'completed') AS completed_research,
  COUNT(*) FILTER (WHERE research_status = 'failed')    AS failed_research,
  COUNT(*) FILTER (WHERE outreach_status = 'ready')     AS emails_ready,
  COUNT(*) FILTER (WHERE outreach_status = 'sent')      AS emails_sent,
  COUNT(*)                                               AS total_brokers
FROM ca_brokers;
