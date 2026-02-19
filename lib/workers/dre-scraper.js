// lib/workers/dre-scraper.js
// Downloads the CA DRE bulk licensee CSV and imports new brokers into ca_brokers.
// The DRE publishes a daily-updated ZIP at:
//   https://secure.dre.ca.gov/datafile/CurrList.zip
//
// This is far more reliable than screen-scraping the DRE website (which blocks bots).
// We stream the ZIP, parse the CSV, filter to active Brokers/Corporations, and upsert.

import { createClient } from '@supabase/supabase-js';
import { createWriteStream, createReadStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { createUnzip } from 'zlib';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DRE_BULK_URL = 'https://secure.dre.ca.gov/datafile/CurrList.zip';
const BATCH_SIZE = 500;

// Only import these license types
const ALLOWED_LIC_TYPES = new Set(['Broker', 'Corporation']);
const ALLOWED_LIC_STATUSES = new Set(['Licensed']);

/**
 * Main entry point - called by execute-step route
 * payload: { batch_size, source }
 */
export async function executeScrapeDREStep(step) {
  const { payload, id: stepId, mission_id } = step;
  const { batch_size = 200 } = payload;

  console.log(`[DRE-SCRAPER] Starting bulk CSV import from DRE. batch_size=${batch_size}`);

  // Mark step as running
  await supabase
    .from('ops_mission_steps')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', stepId);

  const results = {
    scraped: 0,
    inserted: 0,
    skipped_duplicates: 0,
    skipped_filtered: 0,
    errors: [],
  };

  let tmpZip = null;
  let tmpCsv = null;

  try {
    // 1. Download the ZIP to a temp file
    const tmpDir = tmpdir();
    tmpZip = join(tmpDir, `dre_currlist_${Date.now()}.zip`);
    tmpCsv = join(tmpDir, `dre_currlist_${Date.now()}.csv`);

    console.log(`[DRE-SCRAPER] Downloading ${DRE_BULK_URL} ...`);
    const res = await fetch(DRE_BULK_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RealComply/1.0; +https://real-comply.com)',
      },
    });

    if (!res.ok) {
      throw new Error(`DRE bulk download failed: HTTP ${res.status}`);
    }

    // Save ZIP
    const zipWriter = createWriteStream(tmpZip);
    await pipeline(res.body, zipWriter);
    console.log(`[DRE-SCRAPER] ZIP downloaded.`);

    // 2. Extract the ZIP (it contains a single CurrList.csv)
    await extractZip(tmpZip, tmpCsv);
    console.log(`[DRE-SCRAPER] CSV extracted.`);

    // 3. Parse CSV and upsert in batches
    const { inserted, duplicates, skipped, scraped } = await importCSV(tmpCsv, batch_size);
    results.scraped = scraped;
    results.inserted = inserted;
    results.skipped_duplicates = duplicates;
    results.skipped_filtered = skipped;

    console.log(`[DRE-SCRAPER] Done. Inserted ${inserted} new brokers out of ${scraped} rows processed.`);

    // 4. Log event
    await supabase.from('ops_agent_events').insert({
      agent_id: 'prospector',
      kind: 'dre_scrape_complete',
      title: `DRE bulk import: ${results.inserted} new brokers added`,
      summary: `Processed ${results.scraped} rows, inserted ${results.inserted}, skipped ${results.skipped_duplicates} dupes, filtered ${results.skipped_filtered}`,
      tags: ['dre', 'bulk', 'leads'],
      mission_id,
      metadata: results,
    });

    // 5. Mark step complete
    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'completed',
        result: results,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    // 6. Mark mission complete
    await supabase
      .from('ops_missions')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', mission_id);

    return { success: true, results };

  } catch (error) {
    console.error('[DRE-SCRAPER] Fatal error:', error);

    results.errors.push(error.message);

    await supabase
      .from('ops_mission_steps')
      .update({
        status: 'failed',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', stepId);

    return { success: false, error: error.message };

  } finally {
    // Cleanup temp files
    try { if (tmpZip && existsSync(tmpZip)) unlinkSync(tmpZip); } catch {}
    try { if (tmpCsv && existsSync(tmpCsv)) unlinkSync(tmpCsv); } catch {}
  }
}

/**
 * Extract the first file from a ZIP archive to destPath.
 * Uses Node.js zlib (handles DEFLATE-compressed entries).
 * For the DRE ZIP which contains a single CurrList.csv.
 */
async function extractZip(zipPath, destPath) {
  // The DRE ZIP is a standard ZIP with one DEFLATE-compressed entry.
  // We use a simple streaming approach: find the local file header,
  // skip to the compressed data, and pipe through zlib.Unzip.
  //
  // For robustness, we use the 'unzipper' approach via raw zlib since
  // we can't install new packages. We read the ZIP file and locate
  // the compressed data manually.

  const fs = await import('fs');
  const zipBuffer = fs.readFileSync(zipPath);

  // ZIP local file header signature: PK\x03\x04
  const LOCAL_HEADER_SIG = 0x04034b50;

  let offset = 0;
  while (offset < zipBuffer.length - 4) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig === LOCAL_HEADER_SIG) {
      // Parse local file header
      // Offset  Size  Description
      //  0       4    Local file header signature = 0x04034b50
      //  4       2    Version needed to extract
      //  6       2    General purpose bit flag
      //  8       2    Compression method (0=stored, 8=deflated)
      // 10       2    Last mod file time
      // 12       2    Last mod file date
      // 14       4    CRC-32
      // 18       4    Compressed size
      // 22       4    Uncompressed size
      // 26       2    File name length
      // 28       2    Extra field length
      // 30+      n    File name
      // 30+n+m   m    Extra field
      // data starts after

      const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
      const compressedSize = zipBuffer.readUInt32LE(offset + 18);
      const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
      const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);
      const dataOffset = offset + 30 + fileNameLength + extraFieldLength;

      const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        // Stored (no compression)
        fs.writeFileSync(destPath, compressedData);
      } else if (compressionMethod === 8) {
        // Deflate - decompress using zlib.inflateRaw
        const zlib = await import('zlib');
        const decompressed = await new Promise((resolve, reject) => {
          zlib.inflateRaw(compressedData, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        fs.writeFileSync(destPath, decompressed);
      } else {
        throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
      }

      return; // Got the first entry, done
    }
    offset++;
  }

  throw new Error('No valid ZIP local file header found in downloaded file');
}

/**
 * Parse the DRE CSV and upsert into ca_brokers.
 * Streams the file line by line to handle large files (400k+ rows) without OOM.
 */
async function importCSV(csvPath, maxRows) {
  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let headers = null;
  let batch = [];
  let totalRead = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalSkipped = 0;
  let rowsProcessed = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const { data, error } = await supabase
      .from('ca_brokers')
      .upsert(batch, { onConflict: 'license_number', ignoreDuplicates: true })
      .select('id');
    if (error) {
      console.error('[DRE-SCRAPER] Upsert error:', error.message);
    } else {
      const inserted = data?.length || 0;
      const dupes = batch.length - inserted;
      totalInserted += inserted;
      totalDuplicates += dupes;
    }
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (!headers) {
      headers = line.split(',').map(h => h.trim());
      continue;
    }

    if (rowsProcessed >= maxRows) break;

    totalRead++;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });

    // Filter to brokers/corps only
    if (!ALLOWED_LIC_TYPES.has(row.lic_type?.trim())) {
      totalSkipped++;
      continue;
    }
    if (!ALLOWED_LIC_STATUSES.has(row.lic_status?.trim())) {
      totalSkipped++;
      continue;
    }
    if (row.state?.trim() !== 'CA') {
      totalSkipped++;
      continue;
    }

    batch.push(mapRow(row));
    rowsProcessed++;

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  await flushBatch();

  return {
    scraped: rowsProcessed,
    inserted: totalInserted,
    duplicates: totalDuplicates,
    skipped: totalSkipped,
  };
}

// ---------------------------------------------------------------------------
// CSV / row helpers (same logic as import-dre-csv.mjs)
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseDate(val) {
  if (!val || val.length !== 8) return null;
  return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
}

function mapRow(row) {
  const name = row.firstname_secondary
    ? `${row.firstname_secondary} ${row.lastname_primary}`.trim()
    : row.lastname_primary.trim();

  return {
    license_number: row.lic_number.trim(),
    name,
    city: row.city?.trim() || null,
    county: row.county_name?.trim() || null,
    license_type: row.lic_type?.trim().toLowerCase().replace(' ', '_') || 'broker',
    status: 'active',
    expiration_date: parseDate(row.lic_expiration_date),
    research_status: 'pending',
    outreach_status: 'pending',
    source: 'dre_bulk',
    scraped_at: new Date().toISOString(),
  };
}
