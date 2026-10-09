export function normalizeApn(s) {
  return String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const OWNER_NOISE = /\b(LLC|L L C|INC|CORP|CO|TRUST|TR|REVOCABLE|LP|LLP|LTD|ESTATE|ET AL)\b/g;

export function normalizeOwnerName(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(OWNER_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAddress(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cities sorted longest-first so multi-word names match before single-word fragments
const CITIES = [
  'PARADISE VALLEY',
  'FOUNTAIN HILLS',
  'CAVE CREEK',
  'QUEEN CREEK',
  'SUN CITY',
  'EL MIRAGE',
  'GLENDALE',
  'TEMPE',
  'PHOENIX',
  'MESA',
  'SCOTTSDALE',
  'CHANDLER',
  'AVONDALE',
  'PEORIA',
  'SURPRISE',
  'GILBERT',
  'BUCKEYE',
  'GOODYEAR',
  'TOLLESON',
  'LAVEEN',
  'YOUNGTOWN',
  'GUADALUPE',
  'ANTHEM',
].sort((a, b) => b.length - a.length);

/**
 * Strip a trailing city name then normalizeAddress the result.
 * "5932 W PASADENA AVE GLENDALE" → "5932 W PASADENA AVE"
 * "9405 W GLENDALE AVE"          → "9405 W GLENDALE AVE"  (city not last token)
 */
export function streetOnly(address) {
  let s = String(address ?? '').toUpperCase().trim();
  for (const city of CITIES) {
    if (s.endsWith(' ' + city)) {
      s = s.slice(0, s.length - city.length - 1).trim();
      break;
    }
  }
  return normalizeAddress(s);
}

/**
 * Order-independent owner-name key for fuzzy matching.
 * sortedNameKey('Robert L Stark') === sortedNameKey('STARK ROBERT L')
 */
export function sortedNameKey(name) {
  return normalizeOwnerName(name)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// ── Street-level address matching (for absentee-owner detection) ──────────
//
// The assessor's mailing vs. situs address fields are both "street line"
// strings, but they're entered inconsistently: one side may drop the
// directional prefix, abbreviate the street-type suffix differently (WY vs
// WAY), or abbreviate a word that's actually part of the street NAME (VW vs
// VIEW — "Valley Vw" vs "Valley View"). A naive string/punctuation compare
// (normalizeAddress above) flags all of these as "absentee" even though
// they're the same address. addressMatchKey() strips the noise so only the
// house number + core street name remain, for an apples-to-apples compare.

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

const STREET_TYPES = new Set([
  'AVE', 'AV', 'ST', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'WY', 'CIR',
  'BLVD', 'PKWY', 'TRL', 'TER', 'HWY',
]);

// A unit marker and everything after it (the unit number/letter) is dropped —
// units don't affect whether two mailing/situs addresses are the same street.
const UNIT_MARKERS = new Set(['APT', 'UNIT', 'STE', 'LOT', '#']);

// Common street-NAME word abbreviations that collide with how the assessor
// enters the "other" side of the same address (not suffixes — "View" is part
// of the name, e.g. "Valley View Rd" vs "Valley Vw"). Expand BEFORE
// suffix-stripping so both sides compare on the same spelled-out word.
const NAME_WORD_ALIASES = { VW: 'VIEW' };

/**
 * Canonical "house number + street name" key: uppercase, strip punctuation,
 * drop directionals, drop unit markers (and anything after one), expand known
 * street-name abbreviations, then drop street-type suffixes.
 *
 * @param {string|null} raw
 * @returns {string}
 */
export function addressMatchKey(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/#/g, ' # ');
  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = [];
  for (const rawTok of tokens) {
    if (UNIT_MARKERS.has(rawTok)) break; // unit marker + unit id: stop here
    if (DIRECTIONALS.has(rawTok)) continue;
    const tok = NAME_WORD_ALIASES[rawTok] ?? rawTok;
    if (STREET_TYPES.has(tok)) continue;
    kept.push(tok);
  }
  return kept.join(' ');
}

/** First 5-digit run found in a zip string ("85201-1234" → "85201"). */
export function zip5(raw) {
  const m = String(raw ?? '').match(/\d{5}/);
  return m ? m[0] : null;
}

/** Uppercase/trim a city name for comparison; empty → null. */
function normalizeCity(raw) {
  const s = String(raw ?? '').toUpperCase().trim();
  return s || null;
}

/**
 * Two street addresses are "the same" when their addressMatchKey()s match
 * AND the cities agree.
 *
 * City is the primary tie-breaker: when both sides have a city, they must
 * match case-insensitively (the assessor's mailing ZIP is frequently a typo
 * — e.g. "85205" vs "85201" — while the street address and city are entered
 * correctly; ZIP alone would wrongly flag these as absentee). ZIP is only
 * consulted as a fallback when a city is missing on either side, and then
 * only ZIP5 equality (or a missing ZIP) counts as a match.
 *
 * @param {string|null} addrA
 * @param {string|null} cityA
 * @param {string|null} zipA
 * @param {string|null} addrB
 * @param {string|null} cityB
 * @param {string|null} zipB
 * @returns {boolean}
 */
export function sameStreetAddress(addrA, cityA, zipA, addrB, cityB, zipB) {
  const a = addressMatchKey(addrA);
  const b = addressMatchKey(addrB);
  if (!a || !b || a !== b) return false;

  const ca = normalizeCity(cityA);
  const cb = normalizeCity(cityB);
  if (ca && cb) return ca === cb;

  const za = zip5(zipA);
  const zb = zip5(zipB);
  if (za && zb && za !== zb) return false;
  return true;
}
