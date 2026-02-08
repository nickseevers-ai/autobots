// heartbeat.js
// The system's pulse - runs every 5 minutes
// Evaluates triggers, recovers stuck tasks, logs health

import { createClient } from '@supabase/supabase-js';
import { createProposalAndMaybeAutoApprove } from './proposal-service.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Trigger checkers - evaluate conditions and return proposals
const TRIGGER_CHECKERS = {
  proactive_coordinator_plan: checkProactiveCoordinator,
  proactive_analyst_research: checkProactiveAnalyst,
  proactive_observer_health: checkProactiveObserver,
  mission_failed: checkMissionFailed,
  high_task_backlog: checkHighTaskBacklog,
};

async function checkProactiveCoordinator(sb, conditions, actionConfig) {
  const { interval_hours, topics, skip_probability } = conditions;

  // Random skip (agents don't always feel like working!)
  if (Math.random() < (skip_probability || 0.1)) {
    return { fired: false, reason: 'Skipped (random)' };
  }

  // Pick random topic
  const topic = topics[Math.floor(Math.random() * topics.length)];

  return {
    fired: true,
    proposal: {
      agent_id: actionConfig.target_agent,
      title: `${actionConfig.title_template}: ${topic}`,
      description: `Proactive analysis of ${topic}`,
      proposed_steps: [
        {
          kind: actionConfig.step_kind,
          payload: { topic, source: 'proactive' },
        },
      ],
    },
  };
}

async function checkProactiveAnalyst(sb, conditions, actionConfig) {
  const { interval_hours, topics, skip_probability } = conditions;

  if (Math.random() < (skip_probability || 0.15)) {
    return { fired: false, reason: 'Skipped (random)' };
  }

  const topic = topics[Math.floor(Math.random() * topics.length)];

  return {
    fired: true,
    proposal: {
      agent_id: actionConfig.target_agent,
      title: `${actionConfig.title_template}: ${topic}`,
      description: `Deep research on ${topic}`,
      proposed_steps: [
        {
          kind: actionConfig.step_kind,
          payload: { topic, depth: 'comprehensive', source: 'proactive' },
        },
      ],
    },
  };
}

async function checkProactiveObserver(sb, conditions, actionConfig) {
  const { interval_hours, topics, skip_probability } = conditions;

  if (Math.random() < (skip_probability || 0.05)) {
    return { fired: false, reason: 'Skipped (random)' };
  }

  const topic = topics[Math.floor(Math.random() * topics.length)];

  return {
    fired: true,
    proposal: {
      agent_id: actionConfig.target_agent,
      title: `${actionConfig.title_template}: ${topic}`,
      description: `System health check on ${topic}`,
      proposed_steps: [
        {
          kind: actionConfig.step_kind,
          payload: { topic, scope: 'system_wide', source: 'proactive' },
        },
      ],
    },
  };
}

async function checkMissionFailed(sb, conditions, actionConfig) {
  // Check for failed missions in last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: failed } = await sb
    .from('ops_missions')
    .select('id, title, created_by')
    .eq('status', 'failed')
    .gte('completed_at', oneHourAgo)
    .order('completed_at', { ascending: false })
    .limit(1);

  if (!failed || failed.length === 0) {
    return { fired: false, reason: 'No recent failures' };
  }

  const mission = failed[0];

  return {
    fired: true,
    proposal: {
      agent_id: actionConfig.target_agent,
      title: `Diagnose failure: ${mission.title}`,
      description: `Analyze why mission ${mission.id} failed`,
      proposed_steps: [
        {
          kind: actionConfig.step_kind,
          payload: {
            mission_id: mission.id,
            focus: 'root_cause_analysis',
            source: 'reactive',
          },
        },
      ],
    },
  };
}

async function checkHighTaskBacklog(sb, conditions, actionConfig) {
  const { threshold, lookback_hours } = conditions;

  const lookbackTime = new Date(Date.now() - lookback_hours * 60 * 60 * 1000).toISOString();

  const { count } = await sb
    .from('ops_mission_steps')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'queued')
    .gte('created_at', lookbackTime);

  if ((count || 0) < threshold) {
    return { fired: false, reason: `Backlog ${count} < threshold ${threshold}` };
  }

  return {
    fired: true,
    proposal: {
      agent_id: actionConfig.target_agent,
      title: `Address task backlog (${count} queued)`,
      description: `High number of queued tasks detected`,
      proposed_steps: [
        {
          kind: actionConfig.step_kind,
          payload: {
            backlog_count: count,
            action: 'prioritize_and_optimize',
            source: 'reactive',
          },
        },
      ],
    },
  };
}

// Evaluate all trigger rules
async function evaluateTriggers(sb, budgetMs = 4000) {
  const startTime = Date.now();
  const results = { evaluated: 0, fired: 0, errors: [] };

  try {
    // Get enabled triggers
    const { data: triggers } = await sb
      .from('ops_trigger_rules')
      .select('*')
      .eq('enabled', true)
      .order('last_fired_at', { ascending: true, nullsFirst: true });

    if (!triggers || triggers.length === 0) {
      return results;
    }

    for (const trigger of triggers) {
      // Budget check
      if (Date.now() - startTime > budgetMs) {
        console.log(`[HEARTBEAT] Budget exhausted, stopping at ${results.evaluated}/${triggers.length}`);
        break;
      }

      try {
        // Check cooldown
        if (trigger.last_fired_at) {
          const cooldownEnd = new Date(trigger.last_fired_at);
          cooldownEnd.setMinutes(cooldownEnd.getMinutes() + trigger.cooldown_minutes);

          if (new Date() < cooldownEnd) {
            console.log(`[TRIGGER] ${trigger.name} - on cooldown`);
            results.evaluated++;
            continue;
          }
        }

        // Get checker function
        const checker = TRIGGER_CHECKERS[trigger.trigger_event];
        if (!checker) {
          console.log(`[TRIGGER] ${trigger.name} - no checker for ${trigger.trigger_event}`);
          results.evaluated++;
          continue;
        }

        // Run checker
        const outcome = await checker(sb, trigger.conditions, trigger.action_config);
        results.evaluated++;

        if (outcome.fired) {
          console.log(`[TRIGGER] ${trigger.name} - FIRED`);

          // Create proposal through service
          await createProposalAndMaybeAutoApprove(sb, {
            ...outcome.proposal,
            source: 'trigger',
          });

          // Update trigger
          await sb
            .from('ops_trigger_rules')
            .update({
              fire_count: trigger.fire_count + 1,
              last_fired_at: new Date().toISOString(),
            })
            .eq('id', trigger.id);

          results.fired++;
        } else {
          console.log(`[TRIGGER] ${trigger.name} - not fired: ${outcome.reason}`);
        }

      } catch (error) {
        console.error(`[TRIGGER] ${trigger.name} - error:`, error);
        results.errors.push({ trigger: trigger.name, error: error.message });
      }
    }

  } catch (error) {
    console.error('[HEARTBEAT] evaluateTriggers error:', error);
    results.errors.push({ step: 'evaluateTriggers', error: error.message });
  }

  return results;
}

// Recover stuck steps (running > 30 min with no progress)
async function recoverStaleSteps(sb) {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: stale } = await sb
    .from('ops_mission_steps')
    .select('id, mission_id, kind')
    .eq('status', 'running')
    .lt('started_at', thirtyMinAgo);

  if (!stale || stale.length === 0) {
    return { recovered: 0 };
  }

  console.log(`[HEARTBEAT] Recovering ${stale.length} stale steps`);

  for (const step of stale) {
    await sb
      .from('ops_mission_steps')
      .update({
        status: 'failed',
        error_message: 'Timed out - no progress for 30+ minutes',
        completed_at: new Date().toISOString(),
      })
      .eq('id', step.id);

    await sb.from('ops_agent_events').insert({
      agent_id: 'system',
      kind: 'step_recovered',
      title: `Recovered stale step: ${step.kind}`,
      tags: ['recovery', 'timeout'],
      step_id: step.id,
      mission_id: step.mission_id,
    });
  }

  return { recovered: stale.length };
}

// Main heartbeat function
export async function runHeartbeat() {
  const startTime = Date.now();
  const summary = {
    triggers: null,
    recovery: null,
    status: 'success',
    errors: [],
  };

  try {
    console.log('\n[HEARTBEAT] Starting...');

    // 1. Evaluate triggers
    try {
      summary.triggers = await evaluateTriggers(supabase, 4000);
    } catch (error) {
      console.error('[HEARTBEAT] Trigger evaluation failed:', error);
      summary.errors.push({ step: 'triggers', error: error.message });
    }

    // 2. Recover stale steps
    try {
      summary.recovery = await recoverStaleSteps(supabase);
    } catch (error) {
      console.error('[HEARTBEAT] Recovery failed:', error);
      summary.errors.push({ step: 'recovery', error: error.message });
    }

    const duration = Date.now() - startTime;
    console.log(`[HEARTBEAT] Completed in ${duration}ms`);

    // Log to audit table
    await supabase.from('ops_action_runs').insert({
      action_type: 'heartbeat',
      status: summary.errors.length > 0 ? 'partial' : 'success',
      summary: summary,
      duration_ms: duration,
    });

    return summary;

  } catch (error) {
    console.error('[HEARTBEAT] Fatal error:', error);
    summary.status = 'failed';
    summary.errors.push({ step: 'heartbeat', error: error.message });

    await supabase.from('ops_action_runs').insert({
      action_type: 'heartbeat',
      status: 'failed',
      error_message: error.message,
      duration_ms: Date.now() - startTime,
    });

    return summary;
  }
}
