// lib/workers/analyst.js
// Researches a CA real estate broker's online presence.
// Given a broker's DRE license info, it searches the web and
// builds a profile: website, LinkedIn, email, team size, specialties, pain points.
// This intelligence feeds directly into the personalized outreach email.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Use Anthropic Claude for the research synthesis
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Main entry point - called by execute-step route
 * payload: {
 *   broker_id, license_number, broker_name, city, county,
 *   license_type, scope, source
 * }
 */
export async function executeResearchStep(step) {
  const { payload, id: stepId, mission_id } = step;
  const {
    broker_id,
    license_number,
    broker_name,
    city,
    county,
    license_type,
  } = payload;

  console.log(`[ANALYST] Researching broker: ${broker_name} (${license_number})`);

  // Mark step as running
  await supabase
    .from('ops_mission_steps')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', stepId);

  try {
    // 1. Gather public signals about this broker
    const signals = await gatherBrokerSignals(broker_name, city, license_number);

    // 2. Synthesize with Claude into a structured profile
    const profile = await synthesizeBrokerProfile(broker_name, city, county, license_type, signals);

    // 3. If we found a website, try to scrape an email from their contact page
    let discoveredEmail = profile.email || null;
    if (!discoveredEmail && profile.website) {
      discoveredEmail = await scrapeEmailFromWebsite(profile.website);
    }


    // NEW: Fall back to Hunter.io if scraping came up empty
    if (!discoveredEmail && process.env.HUNTER_API_KEY) {
      discoveredEmail = await findEmailWithHunter(broker_name, profile.website);
    }

    // 4. Update ca_brokers with research results
    await supabase
      .from('ca_brokers')
      .update({
        research_status: 'completed',
        research_notes: profile.summary,
        website: profile.website || null,
        linkedin_url: profile.linkedin_url || null,
        email: discoveredEmail || null,
        estimated_team_size: profile.estimated_team_size || null,
        specialties: profile.specialties || [],
        pain_points: profile.pain_points || [],
        compliance_risk_score: profile.compliance_risk_score || null,
        personalization_hook: profile.personalization_hook || null,
        researched_at: new Date().toISOString(),
      })
      .eq('id', broker_id);

    // 5. Log event
    await supabase.from('ops_agent_events').insert({
      agent_id: 'analyst',
      kind: 'broker_researched',
      title: `Research complete: ${broker_name}`,
      summary: profile.summary,
      tags: ['research', 'broker', 'realcomply'],
      mission_id,
      metadata: {
        broker_id,
        license_number,
        website: profile.website,
        email: discoveredEmail,
        team_size: profile.estimated_team_size,
      },
    });

    // 6. Mark step and mission complete
    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'completed',
        result: profile,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    await supabase
      .from('ops_missions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', mission_id);

    console.log(`[ANALYST] Research complete for ${broker_name}`);
    return { success: true, profile };

  } catch (error) {
    console.error('[ANALYST] Error:', error);

    // Mark broker as research_failed so we can retry
    await supabase
      .from('ca_brokers')
      .update({ research_status: 'failed' })
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
 * Gather public signals about this broker from multiple sources.
 * Returns raw text snippets for Claude to synthesize.
 */
async function gatherBrokerSignals(brokerName, city, licenseNumber) {
  const signals = [];

  // Search for the broker online using a few different queries
  const queries = [
    `"${brokerName}" real estate broker "${city}" CA`,
    `"${brokerName}" realtor California contact email`,
    `"${licenseNumber}" DRE broker California`,
  ];

  for (const query of queries) {
    try {
      const results = await searchWeb(query);
      if (results) {
        signals.push({ query, results });
      }
    } catch (err) {
      console.warn(`[ANALYST] Search failed for query "${query}":`, err.message);
    }
  }

  return signals;
}

/**
 * Search the web using a simple fetch to a search API.
 * Uses SerpAPI if available, otherwise falls back to Brave Search API,
 * otherwise skips (Claude will work with what it has from DRE data).
 */
async function searchWeb(query) {
  // Try SerpAPI first
  if (process.env.SERPAPI_KEY) {
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', process.env.SERPAPI_KEY);
    url.searchParams.set('num', '5');
    url.searchParams.set('gl', 'us');

    const res = await fetch(url.toString());
    if (res.ok) {
      const data = await res.json();
      const snippets = (data.organic_results || [])
        .slice(0, 5)
        .map(r => `${r.title}: ${r.snippet} (${r.link})`)
        .join('\n');
      return snippets;
    }
  }

  // Try Brave Search API
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '5');

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
      },
    });

    if (res.ok) {
      const data = await res.json();
      const snippets = (data.web?.results || [])
        .slice(0, 5)
        .map(r => `${r.title}: ${r.description} (${r.url})`)
        .join('\n');
      return snippets;
    }
  }

  // No search API configured - return null, Claude will work with DRE data alone
  console.warn('[ANALYST] No search API configured. Set SERPAPI_KEY or BRAVE_SEARCH_API_KEY.');
  return null;
}

/**
 * Try to find an email address by fetching the broker's website contact page.
 * Looks for mailto: links and email patterns in the page HTML.
 * Returns the first valid-looking email found, or null.
 */
async function scrapeEmailFromWebsite(websiteUrl) {
  try {
    // Normalize URL
    const base = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;

    // Try the contact page first, then the homepage
    const pagesToTry = [
      base.replace(/\/$/, '') + '/contact',
      base.replace(/\/$/, '') + '/contact-us',
      base.replace(/\/$/, '') + '/about',
      base,
    ];

    const emailRegex = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

    // Skip obviously generic/spam-bait domains
    const skipDomains = ['example.com', 'sentry.io', 'wixpress.com', 'squarespace.com',
      'godaddy.com', 'amazonaws.com', 'cloudflare.com'];

    for (const pageUrl of pagesToTry) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout per page

        const res = await fetch(pageUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; RealComply/1.0; +https://real-comply.com)',
          },
        });
        clearTimeout(timeout);

        if (!res.ok) continue;

        const html = await res.text();

        // Find mailto: links first (most reliable)
        const mailtoMatches = html.match(/mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/gi) || [];
        for (const m of mailtoMatches) {
          const email = m.replace(/^mailto:/i, '').split('?')[0].toLowerCase();
          const domain = email.split('@')[1];
          if (!skipDomains.some(d => domain.includes(d)) && isRealEmail(email)) {
            return email;
          }
        }

        // Fall back to plain email regex in HTML
        const allMatches = html.match(emailRegex) || [];
        for (const email of allMatches) {
          const lower = email.toLowerCase();
          const domain = lower.split('@')[1];
          if (!skipDomains.some(d => domain.includes(d)) && isRealEmail(lower)) {
            return lower;
          }
        }
      } catch {
        // Timeout or fetch error - try next page
      }
    }
  } catch (err) {
    console.warn(`[ANALYST] Email scrape failed for ${websiteUrl}:`, err.message);
  }
  return null;
}

/**
 * Basic sanity check: skip obvious placeholder / transactional emails.
 */
function isRealEmail(email) {
  const lower = email.toLowerCase();
  const skipPatterns = ['noreply', 'no-reply', 'donotreply', 'example', 'test@', 'info@info',
    '@sentry', '@wix', 'wordpress', 'schema.org', '.png', '.jpg', '.gif'];
  return !skipPatterns.some(p => lower.includes(p)) && email.length < 100;
}

/**
 * Use Hunter.io API to find a broker's email address.
 * Tries name + domain (Email Finder), falls back to name + company.
 * Requires HUNTER_API_KEY env var.
 */
async function findEmailWithHunter(brokerName, websiteUrl) {
  try {
    const apiKey = process.env.HUNTER_API_KEY;
    const nameParts = brokerName.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || nameParts[0];

    if (websiteUrl) {
      try {
        const rawDomain = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
        const domain = new URL(rawDomain).hostname.replace('www.', '');
        const url = new URL('https://api.hunter.io/v2/email-finder');
        url.searchParams.set('domain', domain);
        url.searchParams.set('first_name', firstName);
        url.searchParams.set('last_name', lastName);
        url.searchParams.set('api_key', apiKey);
        const res = await fetch(url.toString());
        if (res.ok) {
          const data = await res.json();
          const email = data.data?.email;
          const confidence = data.data?.confidence || 0;
          if (email && confidence >= 50 && isRealEmail(email)) {
            console.log(`[ANALYST] Hunter found: ${email} (${confidence}% confidence)`);
            return email;
          }
        }
      } catch (urlErr) {
        console.warn('[ANALYST] Hunter domain lookup error:', urlErr.message);
      }
    }

    const url2 = new URL('https://api.hunter.io/v2/email-finder');
    url2.searchParams.set('company', `${brokerName} Real Estate`);
    url2.searchParams.set('first_name', firstName);
    url2.searchParams.set('last_name', lastName);
    url2.searchParams.set('api_key', apiKey);
    const res2 = await fetch(url2.toString());
    if (res2.ok) {
      const data2 = await res2.json();
      const email = data2.data?.email;
      const confidence = data2.data?.confidence || 0;
      if (email && confidence >= 50 && isRealEmail(email)) {
        console.log(`[ANALYST] Hunter found via company: ${email} (${confidence}% confidence)`);
        return email;
      }
    }
  } catch (err) {
    console.warn(`[ANALYST] Hunter.io lookup failed for ${brokerName}:`, err.message);
  }
  return null;
}

/**
 * Use Claude to synthesize broker profile from search signals + DRE data.
 */
async function synthesizeBrokerProfile(brokerName, city, county, licenseType, signals) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const signalsText = signals.length > 0
    ? signals.map(s => `Query: ${s.query}\nResults:\n${s.results}`).join('\n\n---\n\n')
    : 'No web search results available. Work with DRE data only.';

  const prompt = `You are a sales research analyst for RealComply (https://real-comply.com), a compliance software platform built specifically for California real estate brokers. RealComply helps brokers manage DRE compliance requirements, supervision obligations, document retention, and audit readiness.

You are researching a potential customer to help write a personalized cold outreach email.

BROKER INFO (from CA DRE public records):
- Name: ${brokerName}
- City: ${city}
- County: ${county}
- License Type: ${licenseType}

WEB SEARCH SIGNALS:
${signalsText}

Based on this information, produce a JSON object with the following fields:
{
  "summary": "2-3 sentence profile of this broker for a sales rep to read before reaching out",
  "website": "broker's website URL if found, or null",
  "linkedin_url": "LinkedIn profile URL if found, or null",
  "email": "broker's direct contact email address if clearly visible in search results, or null. Only include if confident it is a real email for this specific broker.",
  "estimated_team_size": "solo | small (2-10) | mid-size (11-50) | large (50+) | unknown",
  "specialties": ["list", "of", "real estate specialties if found"],
  "pain_points": ["likely compliance pain points for this type of broker"],
  "compliance_risk_score": "low | medium | high (based on team size and license type)",
  "personalization_hook": "1-2 sentences of specific, personalized context to use in the cold email opener"
}

Return ONLY the raw JSON object, no markdown fences, no explanation.`;

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
    return JSON.parse(text);
  } catch {
    console.error('[ANALYST] Failed to parse Claude response:', text);
    // Return a minimal profile so we don't fail the whole step
    return {
      summary: `${brokerName} is a ${licenseType} in ${city}, CA.`,
      website: null,
      linkedin_url: null,
      estimated_team_size: 'unknown',
      specialties: [],
      pain_points: ['DRE compliance tracking', 'supervision requirements', 'document retention'],
      compliance_risk_score: 'medium',
      personalization_hook: `As a ${licenseType} in ${city}, you likely have DRE compliance responsibilities that RealComply can streamline.`,
    };
  }
}
