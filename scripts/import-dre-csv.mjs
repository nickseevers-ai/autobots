// scripts/import-dre-csv.mjs
// One-time import of CA DRE CurrList.csv into ca_brokers table.
//
// Usage:
//   node scripts/import-dre-csv.mjs
//
// Requires .env.local in the project root with:
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
//
// Or set env vars directly:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-dre-csv.mjs

import { createClient } from '@supabase/supabase-js';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Load .env.local if present
// ---------------------------------------------------------------------------
const envPath = resolve(PROJECT_ROOT, '.env.local');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('Loaded .env.local');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('Create a .env.local file in the project root or set them as env vars.');
  process.exit(1);
}

// Path to the CSV - update if yours is in a different location
const CSV_PATH = resolve('C:/Users/nick/Downloads/CurrListbrokers/CurrList.csv');

if (!existsSync(CSV_PATH)) {
  console.error(`ERROR: CSV file not found at: ${CSV_PATH}`);
  console.error('Update CSV_PATH in this script to point to your CurrList.csv');
  process.exit(1);
}

const BATCH_SIZE = 500;    // rows per Supabase upsert
const MAX_ROWS = Infinity; // set to e.g. 1000 for a test run, Infinity for all

// Only import these license types (skip Salesperson, Officer, etc.)
const ALLOWED_LIC_TYPES = new Set(['Broker', 'Corporation']);
const ALLOWED_LIC_STATUSES = new Set(['Licensed']);

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// CSV parser (no external deps - pure Node.js readline)
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

// Parse YYYYMMDD → 'YYYY-MM-DD' or null
function parseDate(val) {
  if (!val || val.length !== 8) return null;
  return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
}

// Map a CSV row object to a ca_brokers row
function mapRow(row) {
  // For corporations: lastname_primary is the company name, firstname is empty
  // For individual brokers: lastname_primary + firstname_secondary = full name
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

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nDRE CSV Import`);
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Filter: lic_type in [${[...ALLOWED_LIC_TYPES].join(', ')}], status = Licensed\n`);

  const rl = createInterface({
    input: createReadStream(CSV_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let headers = null;
  let batch = [];
  let totalRead = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalDuplicates = 0;
  let rowsProcessed = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const { data, error } = await supabase
      .from('ca_brokers')
      .upsert(batch, { onConflict: 'license_number', ignoreDuplicates: true })
      .select('id');
    if (error) {
      console.error('Supabase upsert error:', error.message);
    } else {
      const inserted = data?.length || 0;
      const dupes = batch.length - inserted;
      totalInserted += inserted;
      totalDuplicates += dupes;
      process.stdout.write(`\r  Processed: ${rowsProcessed.toLocaleString()} | Inserted: ${totalInserted.toLocaleString()} | Dupes skipped: ${totalDuplicates.toLocaleString()}`);
    }
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (!headers) {
      headers = line.split(',').map(h => h.trim());
      console.log(`Headers found: ${headers.length} columns`);
      continue;
    }

    if (rowsProcessed >= MAX_ROWS) break;

    totalRead++;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });

    // Filter
    if (!ALLOWED_LIC_TYPES.has(row.lic_type?.trim())) {
      totalSkipped++;
      continue;
    }
    if (!ALLOWED_LIC_STATUSES.has(row.lic_status?.trim())) {
      totalSkipped++;
      continue;
    }
    // Skip non-CA
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

  // Final batch
  await flushBatch();

  console.log(`\n\n✅ Import complete!`);
  console.log(`   Total rows read:      ${totalRead.toLocaleString()}`);
  console.log(`   Filtered out:         ${totalSkipped.toLocaleString()}`);
  console.log(`   Broker rows processed:${rowsProcessed.toLocaleString()}`);
  console.log(`   New rows inserted:    ${totalInserted.toLocaleString()}`);
  console.log(`   Duplicates skipped:   ${totalDuplicates.toLocaleString()}`);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
