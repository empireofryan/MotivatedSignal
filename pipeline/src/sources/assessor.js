// pipeline/src/sources/assessor.js
//
// SOURCE: https://mcassessor.maricopa.gov/page/data_sales/
// DOWNLOAD: https://www.arcgis.com/sharing/rest/content/items/936bbba512bf4c368618cc6e79e64668/data
//
// Secured Master — pipe-delimited (|), NO header row, CRLF line endings.
// File spec: "Secured Master.pdf" (rev 02/02/2023), 39 positional columns:
//
//  Col  Name
//  ---- -----------------------------------------------
//   1   Parcel_Number         (9 chars + optional suffix letter)
//   2   Owner_Name
//   3   Owner_Mail_Address_1
//   4   Owner_Mail_Address_2
//   5   Owner_Mail_City
//   6   Owner_Mail_State
//   7   Owner_Mail_Zip_Code
//   8   Owner_Mail_Country
//   9   Situs_Address
//  10   Situs_Suite
//  11   Situs_City
//  12   Situs_Zip_Code
//  13   Property_Type         (COMMERCIAL, AG, RESIDENTIAL, etc.)
//  14   Deed_Number
//  15   Deed_Date             (MMDDYYYY)
//  16   Deed_Type             (WD, QD, PL, SD, etc.)
//  17   Land_Full_Cash_Value
//  18   Improvement_Full_Cash_Value
//  19   Total_Full_Cash_Value (FCV / assessed value we store)
//  20   Total_Full_Cash_Value_Assessed
//  21   Limited_Property_Value
//  22   Limited_Property_Value_Assessed
//  23   Property_Use_Code
//  24   Lot
//  25   Block
//  26   Tract
//  27   Land_Class            (e.g. "100% 1.3" or "55% 2.R; 45% 1.12")
//  28   Improvement_Class     (e.g. "100% 1.12")
//  29   Rental_Indicator      (Y/N)
//  30   Living_Area
//  31   Total_Square_Feet
//  32   Construction_Year     (YYYY)
//  33   Pool_Size
//  34   Sale_Price
//  35   Sale_Date             (MM YYYY)
//  36   MCR_Number
//  37   Subdivision_Name
//  38   Number_Of_Units
//  39   Tax_Area_Code
//
// Column indices (0-based):
const C = {
  PARCEL:       0,
  OWNER_NAME:   1,
  MAIL_ADDR1:   2,
  MAIL_ADDR2:   3,
  MAIL_CITY:    4,
  MAIL_STATE:   5,
  MAIL_ZIP:     6,
  MAIL_COUNTRY: 7,
  SITUS_ADDR:   8,
  SITUS_SUITE:  9,
  SITUS_CITY:   10,
  SITUS_ZIP:    11,
  PROP_TYPE:    12,
  DEED_NUM:     13,
  DEED_DATE:    14,
  DEED_TYPE:    15,
  LAND_FCV:     16,
  IMPR_FCV:     17,
  TOTAL_FCV:    18,
  TOTAL_FCV_ASSESSED: 19,
  LPV:          20,
  LPV_ASSESSED: 21,
  PROP_USE_CODE: 22,
  LOT:          23,
  BLOCK:        24,
  TRACT:        25,
  LAND_CLASS:   26,
  IMPR_CLASS:   27,
  RENTAL_IND:   28,
  LIVING_AREA:  29,
  TOTAL_SQFT:   30,
  CONST_YEAR:   31,
  POOL_SIZE:    32,
  SALE_PRICE:   33,
  SALE_DATE:    34,
  MCR_NUM:      35,
  SUBDIV_NAME:  36,
  NUM_UNITS:    37,
  TAX_AREA:     38,
};

import { normalizeApn, normalizeOwnerName, sameStreetAddress } from '../normalize.js';
import { query } from '../db.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

const BATCH = 2000;

/**
 * Multi-row batch upsert for the assessor ingest path.
 * Builds a single INSERT ... VALUES (...),(...) statement per batch.
 * 15 columns × 500 rows = 7500 params — well under CockroachDB's 65535 limit.
 */
async function batchUpsertProperties(rows) {
  if (rows.length === 0) return 0;
  const COLS = 15;
  const CHUNK = 500; // 500 × 15 = 7500 params
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map((_, j) => {
        const b = j * COLS;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},now())`;
      })
      .join(',');
    const params = chunk.flatMap((r) => [
      r.apn, r.situsAddress, r.situsCity, r.situsZip,
      r.ownerName, r.ownerNameNorm, r.mailingAddress, r.absentee,
      r.yearBuilt, r.livingSqft, r.buildingType,
      r.lastSaleDate, r.lastSalePrice, r.assessedValue, r.legalClass,
    ]);
    await query(
      `INSERT INTO properties
        (apn, situs_address, situs_city, situs_zip, owner_name, owner_name_norm,
         mailing_address, absentee, year_built, living_sqft, building_type,
         last_sale_date, last_sale_price, assessed_value, legal_class, updated_at)
       VALUES ${placeholders}
       ON CONFLICT (apn) DO UPDATE SET
         situs_address=excluded.situs_address, situs_city=excluded.situs_city,
         situs_zip=excluded.situs_zip, owner_name=excluded.owner_name,
         owner_name_norm=excluded.owner_name_norm, mailing_address=excluded.mailing_address,
         absentee=excluded.absentee, year_built=excluded.year_built,
         living_sqft=excluded.living_sqft, building_type=excluded.building_type,
         last_sale_date=excluded.last_sale_date, last_sale_price=excluded.last_sale_price,
         assessed_value=excluded.assessed_value, legal_class=excluded.legal_class,
         updated_at=now()`,
      params
    );
    total += chunk.length;
  }
  return total;
}

/**
 * Parse a single pipe-split cells array into a PropertyRow object.
 * Returns null if the row should be skipped (too short, no parcel, bad apn).
 *
 * @param {string[]} cells - array from line.split('|')
 * @returns {object|null} PropertyRow or null
 */
export function parseOneLine(cells) {
  if (cells.length < 39) return null;

  const rawParcel = (cells[C.PARCEL] || '').trim();
  if (!rawParcel) return null;

  const apn = normalizeApn(rawParcel);
  if (!apn) return null;

  const ownerName = (cells[C.OWNER_NAME] || '').trim();

  // Build mailing address from components
  const mailAddr1 = (cells[C.MAIL_ADDR1] || '').trim();
  const mailAddr2 = (cells[C.MAIL_ADDR2] || '').trim();
  const mailCity  = (cells[C.MAIL_CITY]  || '').trim();
  const mailState = (cells[C.MAIL_STATE] || '').trim();
  const mailZip   = (cells[C.MAIL_ZIP]   || '').trim();
  const mailingParts = [mailAddr1, mailAddr2].filter(Boolean).join(', ');
  const mailingCityLine = [mailCity, mailState, mailZip].filter(Boolean).join(', ');
  const mailingAddress = [mailingParts, mailingCityLine].filter(Boolean).join(', ');

  const situsAddr  = (cells[C.SITUS_ADDR] || '').trim();
  const suiteStr   = (cells[C.SITUS_SUITE] || '').trim();
  // Situs_Address sometimes already ends with the unit number (the assessor's
  // own export duplicates it into Situs_Suite too) — only append the suite
  // when it isn't already the trailing token, else we get "... AVE 2026 2026".
  const situsAddrTokens = situsAddr.split(/\s+/).filter(Boolean);
  const situsAddrLastToken = situsAddrTokens[situsAddrTokens.length - 1] || '';
  const suiteAlreadyIncluded =
    !!suiteStr && situsAddrLastToken.toUpperCase() === suiteStr.toUpperCase();
  const situsAddress = suiteStr && !suiteAlreadyIncluded ? `${situsAddr} ${suiteStr}` : situsAddr;
  const situsCity  = (cells[C.SITUS_CITY] || '').trim() || null;
  const situsZip   = (cells[C.SITUS_ZIP]  || '').trim() || null;

  // Absentee: compare street-level fields with addressMatchKey, which strips
  // directionals, street-type suffix abbreviation differences (WY vs WAY),
  // unit numbers, and known street-name abbreviations (VW vs VIEW) — a plain
  // punctuation/whitespace normalize (normalizeAddress) flags all of those as
  // false-positive absentee owners. City is the primary tie-breaker (a typo'd
  // mailing ZIP with an otherwise-identical street+city is NOT absentee); ZIP
  // is only consulted when a city is missing on either side.
  const absentee = !!(mailAddr1 && situsAddr &&
    !sameStreetAddress(mailAddr1, mailCity, mailZip, situsAddr, situsCity, situsZip));

  // Total Full Cash Value as assessedValue
  const fcvRaw = (cells[C.TOTAL_FCV] || '').trim();
  const assessedValue = fcvRaw ? (Number(fcvRaw) || null) : null;

  // Legal class — extract from Land_Class field (e.g. "100% 1.3" → "1.3")
  const landClassRaw = (cells[C.LAND_CLASS] || '').trim();
  const legalClass = parseLegalClass(landClassRaw) || null;

  // buildingType from Property_Type
  const buildingType = (cells[C.PROP_TYPE] || '').trim() || null;

  // yearBuilt from Construction_Year
  const yearStr = (cells[C.CONST_YEAR] || '').trim();
  const yearBuilt = yearStr && /^\d{4}$/.test(yearStr) ? Number(yearStr) : null;

  // livingSqft from Living_Area
  const sqftRaw = (cells[C.LIVING_AREA] || '').trim();
  const livingSqft = sqftRaw ? (Number(sqftRaw) || null) : null;

  // lastSaleDate from Sale_Date ("MM YYYY" format) — store as ISO date string
  // Sale_Date is empty in the current extract; Deed_Date (MMDDYYYY) is populated — use it as fallback.
  const saleDateRaw = (cells[C.SALE_DATE] || '').trim();
  const lastSaleDate = parseSaleDate(saleDateRaw) ?? parseDeedDate((cells[C.DEED_DATE] || '').trim());

  // lastSalePrice from Sale_Price
  const salePriceRaw = (cells[C.SALE_PRICE] || '').trim();
  const lastSalePrice = salePriceRaw ? (Number(salePriceRaw) || null) : null;

  return {
    apn,
    situsAddress: situsAddress || null,
    situsCity,
    situsZip,
    ownerName,
    ownerNameNorm: normalizeOwnerName(ownerName),
    mailingAddress: mailingAddress || null,
    absentee,
    yearBuilt,
    livingSqft,
    buildingType,
    lastSaleDate,
    lastSalePrice,
    assessedValue,
    legalClass,
  };
}

/**
 * Extract the primary legal class code from a Land_Class string.
 * Examples:
 *   "100% 1.3"      → "1.3"
 *   "55% 2.R; 45% 1.12" → "2.R"  (takes the dominant/first class)
 *   "100% 2.R"      → "2.R"
 */
function parseLegalClass(raw) {
  if (!raw) return null;
  // Match the first "percentage% code" pattern
  const m = raw.match(/\d+%\s*([^\s;,]+)/);
  return m ? m[1].trim() : null;
}

/**
 * Parse "MM YYYY" sale date into "YYYY-MM-DD" (day=01).
 * Returns null if not parseable.
 */
/** "03092005" (MMDDYYYY) → "2005-03-09" */
export function parseDeedDate(raw) {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw || '');
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31 || Number(yyyy) < 1900) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function parseSaleDate(raw) {
  if (!raw || raw.trim() === '') return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2) {
    const mm = parts[0].padStart(2, '0');
    const yyyy = parts[1];
    if (/^\d{2}$/.test(mm) && /^\d{4}$/.test(yyyy)) {
      return `${yyyy}-${mm}-01`;
    }
  }
  return null;
}

/**
 * Parse pipe-delimited Secured Master text (no header row) into PropertyRow[].
 * Pure function — safe to test without DB.
 *
 * @param {string} csvText - raw file contents (pipe-delimited, CRLF or LF)
 * @returns {Array<object>} PropertyRow[]
 */
export function parseAssessorRows(csvText) {
  const lines = csvText.split(/\r?\n/);
  const rows = [];
  let skippedTotal = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split('|');
    const row = parseOneLine(c);
    if (!row) { skippedTotal++; continue; }
    rows.push(row);
  }

  if (skippedTotal > 0) {
    console.warn(`[assessor] skipped ${skippedTotal} unparseable rows`);
  }

  return rows;
}

/**
 * Ingest the Secured Master CSV text into the properties table.
 * Parses all rows and upserts in a single batch call.
 *
 * @param {string} csvText
 * @returns {Promise<{count: number}>}
 */
export async function ingestAssessor(csvText) {
  const rows = parseAssessorRows(csvText);
  const count = await batchUpsertProperties(rows);
  return { count };
}

/**
 * Full ingest: download all 5 Secured Master book files and stream each through
 * the parser+upsert pipeline.
 *
 * Files are too large to load into memory as one string (~483 MB uncompressed),
 * so this function reads each file in chunks, assembling complete lines.
 *
 * @param {string} dataDir - path to the directory containing Secured_Master_BK*.txt files
 * @returns {Promise<{count: number, files: string[]}>}
 */
export async function ingestAssessorFromDir(dataDir) {
  const files = (await readdir(dataDir))
    .filter((f) => /^Secured_Master_BK\d+\.txt$/i.test(f))
    .sort();

  let total = 0;

  for (const file of files) {
    const filePath = join(dataDir, file);
    console.log(`[assessor] ingesting ${file}...`);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    let batch = [];
    let fileRows = 0;
    let skippedTotal = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      const c = line.split('|');

      const row = parseOneLine(c);
      if (!row) { skippedTotal++; continue; }

      batch.push(row);

      if (batch.length >= BATCH) {
        const n = await batchUpsertProperties(batch);
        total += n;
        fileRows += batch.length;
        batch = [];
        if (fileRows % 50000 === 0) {
          console.log(`  [assessor] ${file}: ${fileRows.toLocaleString()} rows processed, ${total.toLocaleString()} total upserted`);
        }
      }
    }

    // flush remainder
    if (batch.length > 0) {
      const n = await batchUpsertProperties(batch);
      total += n;
      fileRows += batch.length;
      batch = [];
    }

    if (skippedTotal > 0) {
      console.warn(`[assessor] skipped ${skippedTotal} unparseable rows`);
    }
    console.log(`  [assessor] ${file}: done, ${fileRows.toLocaleString()} rows → ${total.toLocaleString()} total`);
  }

  return { count: total, files };
}
