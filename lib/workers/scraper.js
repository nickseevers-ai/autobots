// scraper.js
// Race Data Scraper Worker
// Handles extraction of GPS charts and PDF results from Equibase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Track codes to full names
const TRACK_NAMES = {
  AQU: 'Aqueduct',
  FG: 'Fair Grounds',
  GP: 'Gulfstream Park',
  OP: 'Oaklawn Park',
  SA: 'Santa Anita',
  TAM: 'Tampa Bay Downs',
  TP: 'Turfway Park',
};

/**
 * Main scraper execution function
 * Called when a scrape_race_data step is picked up for execution
 */
export async function executeScrapeStep(stepId) {
  console.log(`[Scraper] Starting execution for step ${stepId}`);

  try {
    // Fetch step details
    const { data: step, error: stepError } = await supabase
      .from('ops_mission_steps')
      .select('*, mission:ops_missions(*)')
      .eq('id', stepId)
      .single();

    if (stepError || !step) {
      throw new Error(`Failed to fetch step: ${stepError?.message}`);
    }

    const { payload } = step;
    const {
      track_code,
      race_date,
      url_type,
      data_sources,
      timeout_minutes = 30,
    } = payload;

    const timeoutMs = timeout_minutes * 60 * 1000;
    const startTime = Date.now();

    // Mark step as running
    await updateStep(stepId, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    // Scrape GPS chart data
    let gpsData = null;
    if (data_sources.includes('gps_chart')) {
      console.log(`[Scraper] Fetching GPS chart for ${track_code} on ${race_date}`);
      gpsData = await scrapeGPSChart(track_code, race_date, url_type);

      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Timeout exceeded during GPS scrape');
      }
    }

    // Scrape PDF result chart
    let pdfData = null;
    if (data_sources.includes('pdf_result')) {
      console.log(`[Scraper] Fetching PDF results for ${track_code} on ${race_date}`);
      pdfData = await scrapePDFResults(track_code, race_date, url_type);

      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Timeout exceeded during PDF scrape');
      }
    }

    // Combine and structure data
    const raceResults = mergeRaceData(track_code, race_date, gpsData, pdfData);

    // Insert into database
    await insertRaceResults(raceResults);

    // Mark step complete
    await updateStep(stepId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: {
        success: true,
        races_scraped: raceResults.length,
        track_code,
        race_date,
      },
    });

    console.log(`[Scraper] Successfully scraped ${raceResults.length} races for ${track_code} on ${race_date}`);

    return { success: true, races_scraped: raceResults.length };
  } catch (error) {
    console.error('[Scraper] Error:', error);

    await updateStep(stepId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: error.message,
    });

    return { success: false, error: error.message };
  }
}

/**
 * Scrape GPS Chart data via fetch + HTML parsing
 */
async function scrapeGPSChart(trackCode, raceDate, urlType) {
  const baseUrl =
    urlType === 'premium'
      ? 'https://www.equibase.com/premium/eqbPDFChartPlus.cfm'
      : 'https://www.equibase.com/static/chart';

  const url = buildEquibaseURL(baseUrl, trackCode, raceDate);

  console.log(`[GPS] Fetching ${url}`);

  await randomDelay(2000, 5000);

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`GPS chart fetch failed: ${response.status}`);
  }

  const html = await response.text();

  // Parse GPS data from HTML response
  const races = parseGPSChartHTML(html);

  await randomDelay(1000, 2000);

  return races;
}

/**
 * Parse GPS chart HTML into structured data
 */
function parseGPSChartHTML(html) {
  const races = [];

  // Match race sections containing GPS metrics
  const raceSections = html.split(/race[-_]gps[-_]data/i);

  for (let i = 1; i < raceSections.length; i++) {
    const section = raceSections[i];
    const horses = [];

    // Extract horse GPS rows via regex patterns
    const horsePattern =
      /horse[-_]name[^>]*>([^<]+)<.*?avg[-_]speed[^>]*>([\d.]+)<.*?stride[-_]length[^>]*>([\d.]+)<.*?cum[-_]distance[^>]*>([\d.]+)<.*?path[-_]efficiency[^>]*>([\d.]+)</gs;

    let match;
    while ((match = horsePattern.exec(section)) !== null) {
      horses.push({
        horse_name: match[1].trim(),
        avg_speed_mph: parseFloat(match[2]) || null,
        stride_length_ft: parseFloat(match[3]) || null,
        cumulative_distance_ft: parseFloat(match[4]) || null,
        path_efficiency_pct: parseFloat(match[5]) || null,
      });
    }

    if (horses.length > 0) {
      races.push({ race_number: i, horses });
    }
  }

  return races;
}

/**
 * Scrape PDF Results via fetch + text extraction
 */
async function scrapePDFResults(trackCode, raceDate, urlType) {
  const pdfUrl = buildEquibasePDFURL(trackCode, raceDate, urlType);

  console.log(`[PDF] Downloading ${pdfUrl}`);

  await randomDelay(2000, 4000);

  const response = await fetch(pdfUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`PDF download failed: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Dynamic import for pdf-parse (optional dependency)
  const pdfParse = (await import('pdf-parse')).default;
  const pdfData = await pdfParse(buffer);

  const races = parsePDFRaceResults(pdfData.text, trackCode, raceDate);

  return races;
}

/**
 * Parse PDF text into structured race results
 */
function parsePDFRaceResults(pdfText) {
  const races = [];

  // Split PDF into race sections (Equibase format)
  const raceSections = pdfText.split(/RACE\s+(\d+)/i);

  for (let i = 1; i < raceSections.length; i += 2) {
    const raceNumber = parseInt(raceSections[i]);
    const raceText = raceSections[i + 1];

    if (!raceText) continue;

    const distanceMatch = raceText.match(/(\d+)\s+(furlongs?|miles?)/i);
    const surfaceMatch = raceText.match(/(dirt|turf|synthetic)/i);
    const conditionsMatch = raceText.match(
      /(fast|good|firm|sloppy|muddy|yielding)/i
    );

    const finishers = extractFinishTable(raceText);
    const payouts = extractPayouts(raceText);

    races.push({
      race_number: raceNumber,
      distance: distanceMatch ? distanceMatch[1] : null,
      surface: surfaceMatch ? surfaceMatch[1].toLowerCase() : null,
      track_condition: conditionsMatch
        ? conditionsMatch[1].toLowerCase()
        : null,
      finishers,
      payouts,
    });
  }

  return races;
}

/**
 * Extract finish table from PDF race text
 */
function extractFinishTable(raceText) {
  const finishers = [];

  // Equibase format: "Fin  PP  Horse  Jockey  Odds  Time"
  const finishLines = raceText.match(/^\s*\d+\s+\d+\s+.+$/gm) || [];

  finishLines.forEach((line) => {
    const parts = line.trim().split(/\s{2,}/);

    if (parts.length >= 5) {
      finishers.push({
        finish_position: parseInt(parts[0]),
        post_position: parseInt(parts[1]),
        horse_name: parts[2],
        jockey: parts[3],
        odds: parts[4],
        final_time: parts[5] || null,
      });
    }
  });

  return finishers;
}

/**
 * Extract payouts from PDF race text
 */
function extractPayouts(raceText) {
  const payouts = {};

  const wpsMatch = raceText.match(
    /Win\s+(\d+\.\d+)\s+Place\s+(\d+\.\d+)\s+Show\s+(\d+\.\d+)/i
  );
  if (wpsMatch) {
    payouts.win = parseFloat(wpsMatch[1]);
    payouts.place = parseFloat(wpsMatch[2]);
    payouts.show = parseFloat(wpsMatch[3]);
  }

  const exactaMatch = raceText.match(/Exacta.*?\$(\d+\.\d+)/i);
  if (exactaMatch) payouts.exacta = parseFloat(exactaMatch[1]);

  const trifectaMatch = raceText.match(/Trifecta.*?\$(\d+\.\d+)/i);
  if (trifectaMatch) payouts.trifecta = parseFloat(trifectaMatch[1]);

  return payouts;
}

/**
 * Merge GPS and PDF data into unified structure
 */
function mergeRaceData(trackCode, raceDate, gpsData, pdfData) {
  const mergedRaces = [];
  const baseRaces = pdfData || [];

  baseRaces.forEach((pdfRace) => {
    const gpsRace = gpsData?.find(
      (g) => g.race_number === pdfRace.race_number
    );

    const mergedFinishers = pdfRace.finishers.map((finisher) => {
      const gpsHorse = gpsRace?.horses?.find(
        (h) => h.horse_name.toLowerCase() === finisher.horse_name.toLowerCase()
      );

      return {
        ...finisher,
        ...(gpsHorse || {}),
      };
    });

    mergedRaces.push({
      track_code: trackCode,
      track_name: TRACK_NAMES[trackCode] || trackCode,
      race_date: raceDate,
      race_number: pdfRace.race_number,
      distance: pdfRace.distance,
      surface: pdfRace.surface,
      track_condition: pdfRace.track_condition,
      payouts: pdfRace.payouts,
      finishers: mergedFinishers,
    });
  });

  return mergedRaces;
}

/**
 * Insert race results into Supabase
 */
async function insertRaceResults(races) {
  for (const race of races) {
    const { data: raceRecord, error: raceError } = await supabase
      .from('race_results_master')
      .upsert(
        {
          track_code: race.track_code,
          track_name: race.track_name,
          race_date: race.race_date,
          race_number: race.race_number,
          distance: race.distance,
          surface: race.surface,
          track_condition: race.track_condition,
          payouts: race.payouts,
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'track_code,race_date,race_number' }
      )
      .select()
      .single();

    if (raceError) {
      console.error('[DB] Error inserting race:', raceError);
      continue;
    }

    // Insert finishers
    const finisherRecords = race.finishers.map((f) => ({
      race_id: raceRecord.id,
      finish_position: f.finish_position,
      post_position: f.post_position,
      horse_name: f.horse_name,
      jockey: f.jockey,
      odds: f.odds,
      final_time: f.final_time,
      avg_speed_mph: f.avg_speed_mph || null,
      stride_length_ft: f.stride_length_ft || null,
      cumulative_distance_ft: f.cumulative_distance_ft || null,
      path_efficiency_pct: f.path_efficiency_pct || null,
    }));

    if (finisherRecords.length > 0) {
      const { error: finishersError } = await supabase
        .from('race_finishers')
        .insert(finisherRecords);

      if (finishersError) {
        console.error('[DB] Error inserting finishers:', finishersError);
      }
    }
  }

  console.log(`[DB] Inserted ${races.length} races into database`);
}

/**
 * Update step record in ops_mission_steps
 */
async function updateStep(stepId, updates) {
  const { error } = await supabase
    .from('ops_mission_steps')
    .update(updates)
    .eq('id', stepId);

  if (error) {
    console.error('[Scraper] Error updating step:', error);
  }
}

/**
 * Build Equibase chart URL
 */
function buildEquibaseURL(baseUrl, trackCode, raceDate) {
  const dateStr = raceDate.replace(/-/g, '');
  return `${baseUrl}?track=${trackCode}&date=${dateStr}`;
}

/**
 * Build Equibase PDF URL
 */
function buildEquibasePDFURL(trackCode, raceDate, urlType) {
  const dateStr = raceDate.replace(/-/g, '');

  if (urlType === 'premium') {
    return `https://www.equibase.com/premium/eqbPDFChartPlus.cfm?track=${trackCode}&date=${dateStr}&type=pdf`;
  }
  return `https://www.equibase.com/static/chart/${trackCode}${dateStr}.pdf`;
}

/**
 * Random delay to mimic human browsing behavior
 */
function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, delay));
}
