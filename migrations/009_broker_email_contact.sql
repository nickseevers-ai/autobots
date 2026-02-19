-- Migration 009: Add email and personalization_hook columns to ca_brokers
-- Run this in Supabase SQL editor
--
-- The analyst worker now discovers broker email addresses by:
--   1. Asking Claude to extract emails visible in web search results
--   2. Scraping the broker's website contact page for mailto links
-- This migration adds the column to store those discovered emails.

-- Add email column (contact email discovered by research worker)
ALTER TABLE ca_brokers ADD COLUMN IF NOT EXISTS email TEXT;

-- Add personalization_hook column (Claude's suggested cold email opener)
-- This was in the analyst's Claude output but never persisted to the DB before
ALTER TABLE ca_brokers ADD COLUMN IF NOT EXISTS personalization_hook TEXT;

-- Index for quickly finding brokers that have emails (for send queue)
CREATE INDEX IF NOT EXISTS idx_ca_brokers_email ON ca_brokers(email) WHERE email IS NOT NULL;

-- Helpful view: brokers ready to send with email addresses
CREATE OR REPLACE VIEW v_outreach_ready AS
SELECT
  b.id,
  b.name,
  b.city,
  b.county,
  b.license_type,
  b.email,
  b.website,
  b.estimated_team_size,
  b.outreach_email_subject AS subject,
  b.outreach_email_body AS body,
  b.outreach_generated_at,
  e.id AS email_record_id
FROM ca_brokers b
LEFT JOIN ops_outreach_emails e ON e.broker_id = b.id
WHERE b.outreach_status = 'ready'
ORDER BY b.outreach_generated_at DESC;

-- Update the pipeline stats view to include email discovery stats
CREATE OR REPLACE VIEW v_broker_pipeline AS
SELECT
  COUNT(*) FILTER (WHERE research_status = 'pending')   AS pending_research,
  COUNT(*) FILTER (WHERE research_status = 'running')   AS running_research,
  COUNT(*) FILTER (WHERE research_status = 'completed') AS completed_research,
  COUNT(*) FILTER (WHERE research_status = 'failed')    AS failed_research,
  COUNT(*) FILTER (WHERE outreach_status = 'ready')     AS emails_ready,
  COUNT(*) FILTER (WHERE outreach_status = 'sent')      AS emails_sent,
  COUNT(*) FILTER (WHERE email IS NOT NULL)             AS emails_with_contact,
  COUNT(*)                                               AS total_brokers
FROM ca_brokers;

-- RLS policy so anon key can read the new view
-- (v_outreach_ready inherits from ca_brokers which already has a public read policy)
