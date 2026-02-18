// lib/workers/dre-scraper.js
// Scrapes the California DRE (Department of Real Estate) public license search
// to find active real estate brokers and load them into ca_brokers for the pipeline.
//
// CA DRE public license lookup:
//   https://www2.dre.ca.gov/PublicASP/pplinfo.asp
// They also have a bulk-style search by license type we can page through.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// CA DRE license type codes we care about
const LICENSE_TYPE_CODES = {
  broker: '02',           // Individual Real Estate Broker
  corporate_broker: '04', // Corporate Real Estate Broker
};

// CA counties to target - prioritize high-value markets
const TARGET_COUNTIES = [
  'Los Angeles',
  'Orange',
  'San Diego',
  'San Francisco',
  'Alameda',
  'Santa Clara',
  'Riverside',
  'San Bernardino',
  'Sacramento',
  'Contra Costa',
  'Fresno',
  'Kern',
  'Ventura',
  'San Mateo',
  'Marin',
];

/**
 * Main entry point - called by execute-step route
 * payload: { batch_size, license_types, source }
 */
export async function executeScrapeDREStep(step) {
  const { payload, id: stepId, mission_id } = step;
  const {
    batch_size = 50,
    license_types = ['broker', 'corporate_broker'],
    county = null, // optional county filter
  } = payload;

  console.log(`[DRE-SCRAPER] Starting scrape. batch_size=${batch_size}`);

  // Mark step as running
  await supabase
    .from('ops_mission_steps')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', stepId);

  try {
    const results = {
      scraped: 0,
      inserted: 0,
      skipped_duplicates: 0,
      errors: [],
    };

    const countiestoScrape = county ? [county] : TARGET_COUNTIES.slice(0, 3); // 3 counties per run

    for (const targetCounty of countiestoScrape) {
      for (const licenseType of license_types) {
        try {
          const brokers = await scrapeDREByCounty(targetCounty, licenseType, batch_size);
          results.scraped += brokers.length;
          console.log(`[DRE-SCRAPER] Got ${brokers.length} ${licenseType} brokers in ${targetCounty}`);

          // Upsert into ca_brokers - skip if license_number already exists
          if (brokers.length > 0) {
            const { data, error } = await supabase
              .from('ca_brokers')
              .upsert(brokers, {
                onConflict: 'license_number',
                ignoreDuplicates: true,
              })
              .select('id');

            if (error) {
              console.error(`[DRE-SCRAPER] Upsert error for ${targetCounty}/${licenseType}:`, error);
              results.errors.push(`${targetCounty}/${licenseType}: ${error.message}`);
            } else {
              results.inserted += (data?.length || 0);
              results.skipped_duplicates += brokers.length - (data?.length || 0);
            }
          }

        } catch (err) {
          console.error(`[DRE-SCRAPER] Error scraping ${targetCounty}/${licenseType}:`, err);
          results.errors.push(`${targetCounty}/${licenseType}: ${err.message}`);
        }
      }
    }

    // Log event
    await supabase.from('ops_agent_events').insert({
      agent_id: 'prospector',
      kind: 'dre_scrape_complete',
      title: `DRE scrape complete: ${results.inserted} new brokers added`,
      summary: `Scraped ${results.scraped} listings, inserted ${results.inserted}, skipped ${results.skipped_duplicates} duplicates`,
      tags: ['dre', 'scrape', 'leads'],
      mission_id,
      metadata: results,
    });

    // Mark step complete
    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'completed',
        result: results,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    // Mark mission complete
    await supabase
      .from('ops_missions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', mission_id);

    console.log(`[DRE-SCRAPER] Done. Inserted ${results.inserted} new brokers.`);
    return { success: true, results };

  } catch (error) {
    console.error('[DRE-SCRAPER] Fatal error:', error);

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
 * Scrape CA DRE public license search for brokers in a given county.
 * Uses the DRE's public-facing ASP search form.
 *
 * Strategy: POST to their search form, parse the HTML table results.
 * The DRE site paginates - we grab the first page (up to ~50 results).
 */
async function scrapeDREByCounty(county, licenseType, batchSize) {
  const licenseCode = LICENSE_TYPE_CODES[licenseType] || '02';

  // CA DRE search endpoint
  const searchUrl = 'https://www2.dre.ca.gov/PublicASP/pplinfo.asp';

  const formData = new URLSearchParams({
    LicTyp: licenseCode,
    county: county.toUpperCase(),
    Status: 'A',         // Active licenses only
    action: 'Search',
  });

  const response = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; RealComply-Bot/1.0; +https://real-comply.com)',
      'Referer': 'https://www2.dre.ca.gov/PublicASP/pplinfo.asp',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    throw new Error(`DRE search returned ${response.status} for ${county}`);
  }

  const html = await response.text();
  return parseDRESearchResults(html, county, licenseType, batchSize);
}

/**
 * Parse the HTML table returned by the DRE search.
 * The DRE site returns an HTML table with columns:
 * License #, Name, City, County, License Type, Status, Expiration Date
 */
function parseDRESearchResults(html, county, licenseType, batchSize) {
  const brokers = [];

  // Find the results table - DRE uses a table with specific structure
  // We extract rows that look like: license number, name, city, etc.
  const tableRowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const tagStripRegex = /<[^>]+>/g;

  const rows = html.match(tableRowRegex) || [];

  for (const row of rows) {
    if (brokers.length >= batchSize) break;

    const cells = [];
    let cellMatch;
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = cellPattern.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(tagStripRegex, '').trim());
    }

    // DRE table row has ~7 columns: License#, Name, City, County, Type, Status, Expiration
    if (cells.length < 5) continue;

    const licenseNumber = cells[0]?.trim();
    const name = cells[1]?.trim();
    const city = cells[2]?.trim();
    const rowCounty = cells[3]?.trim() || county;
    const status = cells[5]?.trim() || 'Active';
    const expirationDate = cells[6]?.trim() || null;

    // Skip header rows and invalid entries
    if (!licenseNumber || !name || licenseNumber.toLowerCase() === 'license' || licenseNumber === '#') {
      continue;
    }

    // Only active licenses
    if (status && !status.toLowerCase().includes('active')) {
      continue;
    }

    brokers.push({
      license_number: licenseNumber,
      name: name,
      city: city,
      county: rowCounty || county,
      license_type: licenseType,
      status: 'active',
      expiration_date: expirationDate ? parseDate(expirationDate) : null,
      research_status: 'pending',
      outreach_status: 'pending',
      source: 'dre_scrape',
      scraped_at: new Date().toISOString(),
    });
  }

  return brokers;
}

function parseDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}
