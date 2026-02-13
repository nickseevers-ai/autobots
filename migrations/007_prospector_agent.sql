-- Migration: Prospector Agent
-- Horse racing lead generation and research system

-- ======================
-- Trigger Rule
-- ======================

INSERT INTO ops_trigger_rules (
  name,
  trigger_event,
  conditions,
  action_config,
  enabled,
  cooldown_minutes,
  fire_count
) VALUES (
  'Prospector: Horse Racing Lead Gen',
  'proactive_prospector_lead_gen',
  jsonb_build_object(
    'topics', '["track bias analysis", "trainer patterns", "jockey statistics", "pace analysis", "surface performance trends", "class level movement", "distance preference profiling", "post position impact"]'::jsonb,
    'skip_probability', 0.05,
    'interval_hours', 4
  ),
  jsonb_build_object(
    'target_agent', 'prospector',
    'title_template', 'Prospect lead',
    'step_kind', 'research'
  ),
  true,
  60,
  0
)
ON CONFLICT DO NOTHING;

-- ======================
-- Agent Policy
-- ======================

INSERT INTO ops_policy (key, value)
VALUES (
  'agent_prospector',
  '{"enabled": true, "max_daily_proposals": 10}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
