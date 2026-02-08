// proposal-service.js
// THE HEART OF THE SYSTEM - Single entry point for all proposals
// No matter where a proposal comes from, it goes through here

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cap gates - Check quotas before allowing proposals
const STEP_KIND_GATES = {
  analyze: checkAnalyzeGate,
  research: checkResearchGate,
  write_content: checkWriteContentGate,
};

async function checkAnalyzeGate(sb) {
  // Check daily limit for analysis tasks
  const policy = await getPolicy(sb, 'daily_limits');
  const todayCount = await countTodaySteps(sb, 'analyze');

  if (todayCount >= (policy.max_analyze_per_day || 10)) {
    return { ok: false, reason: `Daily analyze quota reached (${todayCount}/10)` };
  }
  return { ok: true };
}

async function checkResearchGate(sb) {
  const policy = await getPolicy(sb, 'daily_limits');
  const todayCount = await countTodaySteps(sb, 'research');

  if (todayCount >= (policy.max_research_per_day || 8)) {
    return { ok: false, reason: `Daily research quota reached (${todayCount}/8)` };
  }
  return { ok: true };
}

async function checkWriteContentGate(sb) {
  const policy = await getPolicy(sb, 'daily_limits');
  const todayCount = await countTodaySteps(sb, 'write_content');

  if (todayCount >= (policy.max_content_per_day || 5)) {
    return { ok: false, reason: `Daily content quota reached (${todayCount}/5)` };
  }
  return { ok: true };
}

async function countTodaySteps(sb, stepKind) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count } = await sb
    .from('ops_mission_steps')
    .select('*', { count: 'exact', head: true })
    .eq('kind', stepKind)
    .gte('created_at', today.toISOString());

  return count || 0;
}

async function getPolicy(sb, key) {
  const { data } = await sb
    .from('ops_policy')
    .select('value')
    .eq('key', key)
    .single();

  return data?.value || {};
}

async function checkAgentDailyLimit(sb, agentId) {
  const policy = await getPolicy(sb, `agent_${agentId}`);
  if (!policy.enabled) {
    return { ok: false, reason: `Agent ${agentId} is disabled` };
  }

  const maxDaily = policy.max_daily_proposals || 10;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count } = await sb
    .from('ops_mission_proposals')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .gte('created_at', today.toISOString());

  if ((count || 0) >= maxDaily) {
    return { ok: false, reason: `Agent ${agentId} hit daily limit (${count}/${maxDaily})` };
  }

  return { ok: true };
}

async function shouldAutoApprove(sb, stepKind) {
  const policy = await getPolicy(sb, 'auto_approve');
  if (!policy.enabled) return false;

  const allowed = policy.allowed_step_kinds || [];
  return allowed.includes(stepKind);
}

// THE MAIN FUNCTION - Single entry point for proposal creation
export async function createProposalAndMaybeAutoApprove(sb, input) {
  const {
    agent_id,
    title,
    description,
    proposed_steps = [],
    source = 'manual',
  } = input;

  try {
    // 1. Check agent daily limit
    const agentCheck = await checkAgentDailyLimit(sb, agent_id);
    if (!agentCheck.ok) {
      console.log(`[PROPOSAL] Rejected - ${agentCheck.reason}`);

      // Still log the rejection
      await sb.from('ops_mission_proposals').insert({
        agent_id,
        title,
        description,
        status: 'rejected',
        rejection_reason: agentCheck.reason,
        proposed_steps,
      });

      return { success: false, reason: agentCheck.reason };
    }

    // 2. Check cap gates for each proposed step
    for (const step of proposed_steps) {
      const gateCheck = STEP_KIND_GATES[step.kind];
      if (gateCheck) {
        const result = await gateCheck(sb);
        if (!result.ok) {
          console.log(`[PROPOSAL] Rejected - ${result.reason}`);

          await sb.from('ops_mission_proposals').insert({
            agent_id,
            title,
            description,
            status: 'rejected',
            rejection_reason: result.reason,
            proposed_steps,
          });

          return { success: false, reason: result.reason };
        }
      }
    }

    // 3. Insert the proposal
    const { data: proposal, error: proposalError } = await sb
      .from('ops_mission_proposals')
      .insert({
        agent_id,
        title,
        description,
        status: 'pending',
        proposed_steps,
      })
      .select()
      .single();

    if (proposalError) throw proposalError;

    console.log(`[PROPOSAL] Created: ${proposal.id} by ${agent_id} - "${title}"`);

    // 4. Fire event
    await sb.from('ops_agent_events').insert({
      agent_id,
      kind: 'proposal_created',
      title: `Proposed: ${title}`,
      summary: description,
      tags: ['proposal', source],
      metadata: { proposal_id: proposal.id },
    });

    // 5. Check auto-approve
    let autoApproved = false;
    if (proposed_steps.length > 0) {
      const firstStep = proposed_steps[0];
      autoApproved = await shouldAutoApprove(sb, firstStep.kind);
    }

    if (autoApproved) {
      console.log(`[PROPOSAL] Auto-approving ${proposal.id}`);
      return await approveProposal(sb, proposal.id);
    }

    return { success: true, proposal_id: proposal.id, auto_approved: false };

  } catch (error) {
    console.error('[PROPOSAL] Error:', error);
    return { success: false, error: error.message };
  }
}

// Approve a proposal and create mission + steps
async function approveProposal(sb, proposalId) {
  try {
    // Get the proposal
    const { data: proposal } = await sb
      .from('ops_mission_proposals')
      .select('*')
      .eq('id', proposalId)
      .single();

    if (!proposal || proposal.status !== 'pending') {
      return { success: false, reason: 'Proposal not pending' };
    }

    // Update proposal status
    await sb
      .from('ops_mission_proposals')
      .update({
        status: 'accepted',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'system',
      })
      .eq('id', proposalId);

    // Create mission
    const { data: mission, error: missionError } = await sb
      .from('ops_missions')
      .insert({
        title: proposal.title,
        description: proposal.description,
        created_by: proposal.agent_id,
        proposal_id: proposalId,
        status: 'approved',
      })
      .select()
      .single();

    if (missionError) throw missionError;

    console.log(`[MISSION] Created: ${mission.id} - "${mission.title}"`);

    // Create steps
    const steps = proposal.proposed_steps.map((step, index) => ({
      mission_id: mission.id,
      kind: step.kind,
      payload: step.payload || {},
      status: 'queued',
      step_order: index,
    }));

    const { error: stepsError } = await sb
      .from('ops_mission_steps')
      .insert(steps);

    if (stepsError) throw stepsError;

    console.log(`[STEPS] Created ${steps.length} steps for mission ${mission.id}`);

    // Fire event
    await sb.from('ops_agent_events').insert({
      agent_id: proposal.agent_id,
      kind: 'mission_started',
      title: `Mission started: ${mission.title}`,
      summary: proposal.description,
      tags: ['mission', 'started'],
      mission_id: mission.id,
      metadata: { proposal_id: proposalId },
    });

    return {
      success: true,
      proposal_id: proposalId,
      mission_id: mission.id,
      auto_approved: true,
    };

  } catch (error) {
    console.error('[APPROVE] Error:', error);
    return { success: false, error: error.message };
  }
}

export { approveProposal };
