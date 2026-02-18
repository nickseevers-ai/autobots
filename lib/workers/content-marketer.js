// lib/workers/content-marketer.js
// Writes personalized cold outreach emails for CA real estate brokers.
// Uses the analyst's research profile to craft emails that feel like they
// came from a human who actually knows the broker's situation.
//
// Output is stored in ca_brokers.outreach_email and a copy in ops_outreach_emails.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// RealComply product context - what we're selling and why brokers care
const REALCOMPLY_CONTEXT = `
RealComply (https://real-comply.com) is a compliance management platform built exclusively for California real estate brokers.

KEY VALUE PROPS:
1. DRE Audit Readiness: Organizes all required records so brokers pass DRE audits without scrambling
2. Supervision Compliance: Tracks salesperson supervision logs to meet DRE requirements
3. Document Retention: Automated 3-year retention for transaction records per CA law
4. License Expiration Alerts: Never miss a renewal for agents on your team
5. Transaction Checklists: Ensures every deal has the required DRE documentation

TARGET CUSTOMER PAIN: Brokers with agents under them face personal liability for compliance failures. One missed supervision log or improper document retention can trigger a DRE audit, fines, or license suspension.

TONE: Professional, peer-to-peer, not salesy. We're fellow real estate professionals who built this because we lived the pain ourselves.
`;

/**
 * Main entry point - called by execute-step route
 * payload: {
 *   broker_id, license_number, broker_name, city, county,
 *   research_notes, content_type, product, product_url, source
 * }
 */
export async function executeWriteContentStep(step) {
  const { payload, id: stepId, mission_id } = step;
  const {
    broker_id,
    license_number,
    broker_name,
    city,
    county,
    research_notes,
    content_type = 'cold_outreach_email',
  } = payload;

  console.log(`[CONTENT-MARKETER] Writing ${content_type} for: ${broker_name}`);

  // Mark step as running
  await supabase
    .from('ops_mission_steps')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', stepId);

  try {
    // Fetch the full broker profile for context
    const { data: broker, error: brokerError } = await supabase
      .from('ca_brokers')
      .select('*')
      .eq('id', broker_id)
      .single();

    if (brokerError || !broker) {
      throw new Error(`Broker ${broker_id} not found: ${brokerError?.message}`);
    }

    let result;
    if (content_type === 'cold_outreach_email') {
      result = await writeColdEmail(broker);
    } else {
      throw new Error(`Unknown content_type: ${content_type}`);
    }

    // Update broker record with the outreach email
    await supabase
      .from('ca_brokers')
      .update({
        outreach_status: 'ready',
        outreach_email_subject: result.subject,
        outreach_email_body: result.body,
        outreach_generated_at: new Date().toISOString(),
      })
      .eq('id', broker_id);

    // Also store in ops_outreach_emails for the dashboard to display
    await supabase.from('ops_outreach_emails').insert({
      broker_id,
      license_number,
      broker_name,
      city,
      county,
      subject: result.subject,
      body: result.body,
      status: 'ready',
      mission_id,
    });

    // Log event
    await supabase.from('ops_agent_events').insert({
      agent_id: 'content_marketer',
      kind: 'outreach_email_written',
      title: `Email ready: ${broker_name}`,
      summary: `Subject: ${result.subject}`,
      tags: ['email', 'outreach', 'realcomply', 'broker'],
      mission_id,
      metadata: {
        broker_id,
        license_number,
        subject: result.subject,
        word_count: result.body.split(' ').length,
      },
    });

    // Mark step and mission complete
    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'completed',
        result: { subject: result.subject, preview: result.body.substring(0, 200) + '...' },
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    await supabase
      .from('ops_missions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', mission_id);

    console.log(`[CONTENT-MARKETER] Email written for ${broker_name}: "${result.subject}"`);
    return { success: true, subject: result.subject };

  } catch (error) {
    console.error('[CONTENT-MARKETER] Error:', error);

    // Reset broker outreach status so we can retry
    await supabase
      .from('ca_brokers')
      .update({ outreach_status: 'failed' })
      .eq('id', broker_id);

    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    return { success: false, error: error.message };
  }
}

/**
 * Write a personalized cold outreach email for this broker.
 * Uses Claude to craft a short, human-sounding email.
 */
async function writeColdEmail(broker) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const {
    name,
    city,
    county,
    license_type,
    estimated_team_size,
    specialties = [],
    pain_points = [],
    personalization_hook,
    website,
  } = broker;

  const specializationsText = specialties.length > 0
    ? `Known specialties: ${specialties.join(', ')}`
    : 'Specialties unknown';

  const teamContext = estimated_team_size && estimated_team_size !== 'unknown'
    ? `Estimated team size: ${estimated_team_size}`
    : '';

  const hookText = personalization_hook
    ? `Personalization hook from research: ${personalization_hook}`
    : '';

  const websiteText = website ? `Website: ${website}` : '';

  const prompt = `${REALCOMPLY_CONTEXT}

You are writing a cold outreach email on behalf of Nick Seevers, founder of RealComply, to a California real estate broker.

BROKER PROFILE:
- Name: ${name}
- Location: ${city}, ${county} County, California
- License Type: ${license_type}
- ${teamContext}
- ${specializationsText}
- ${websiteText}
- ${hookText}
- Known pain points: ${pain_points.join(', ') || 'DRE compliance, document management'}

EMAIL REQUIREMENTS:
- Subject line: Short, specific, not spammy (no "I noticed...", no "Quick question")
- Body: 4-6 sentences max. Opening line references something specific about them (city, team, specialty). Second sentence states the problem we solve. Third: brief what we do. Fourth: soft call to action (15 min call, or just reply). Sign off from Nick.
- NO: "I hope this email finds you well", "synergy", "leverage", "reach out", generic compliments
- YES: Specific, confident, peer-to-peer, respects their time
- Tone: Fellow real estate professional talking to another, not a SaaS salesperson

Return a JSON object:
{
  "subject": "the email subject line",
  "body": "the full email body with line breaks as \\n"
}

Return ONLY the raw JSON, no markdown fences.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  const text = data.content[0]?.text || '{}';

  try {
    const parsed = JSON.parse(text);
    if (!parsed.subject || !parsed.body) {
      throw new Error('Missing subject or body in response');
    }
    return parsed;
  } catch (err) {
    console.error('[CONTENT-MARKETER] Failed to parse Claude response:', text);
    // Fallback email if parsing fails
    return {
      subject: `DRE compliance tool for ${name}`,
      body: `Hi ${name.split(' ')[0]},\n\nRunning a brokerage in ${city} means staying on top of DRE compliance, and I wanted to introduce RealComply - software built specifically for CA brokers to manage supervision logs, document retention, and audit readiness.\n\nWould a 15-minute call make sense to see if it's a fit?\n\nNick Seevers\nFounder, RealComply\nhttps://real-comply.com`,
    };
  }
}
