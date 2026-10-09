/**
 * Name-key generation for owner-name → parcel resolution.
 *
 * Properties (assessor) use "LAST FIRST M" with couples as "LAST FIRST M/FIRST2"
 * or "LAST FIRST/LAST2 FIRST2" or "LAST FIRST & FIRST2". Court/recorder names
 * arrive as either "LAST FIRST M" or "First M Last". A key is "LAST|FIRST";
 * signals emit keys for both orderings, properties emit one per person.
 */

const ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|BANK|N\.?A|ASSOCIATION|ASSN|HOA|CONDOMINIUM|PROPERTIES|HOLDINGS|INVESTMENTS|ENTERPRISES|GROUP|PARTNERS|PARTNERSHIP|VENTURES|CAPITAL|FUND|MORTGAGE|LOAN|LENDING|SERVICES|CHURCH|MINISTRIES|CITY OF|COUNTY OF|STATE OF|UNITED STATES|USA|DEPT|DEPARTMENT|SCHOOL|DISTRICT|HOSPITAL|UNIVERSITY|REALTY|HOMES|DEVELOPMENT|CONSTRUCTION|BUILDERS|TRUSTEE FOR|AS TRUSTEE|COM)\b/;

// Words that carry no identity; dropped before keying.
const NOISE = new Set([
  'JR', 'SR', 'II', 'III', 'IV', 'TR', 'TRS', 'TRUST', 'TRUSTEE', 'TRUSTEES', 'LIVING', 'FAMILY',
  'REVOCABLE', 'IRREVOCABLE', 'REV', 'ESTATE', 'OF', 'THE', 'ETAL', 'ET', 'AL', 'DECEASED', 'DEC',
  'HUSBAND', 'WIFE', 'H/W', 'JT', 'JTWROS', 'ETUX', 'UX', 'SURVIVING', 'SUCCESSOR', 'DATED', 'DTD',
  'AKA', 'FKA', 'NKA', 'MR', 'MRS', 'MS', 'DR',
]);

export function normalizeName(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\bAND\b/g, '&')
    .replace(/[.,'"()\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isEntity(raw) {
  const n = normalizeName(raw);
  if (!n) return true;
  if (ENTITY_RE.test(n)) return true;
  // "SMITH FAMILY TRUST" is a trust but still names a family — keep as person keys
  // via the noise filter; pure entity names have no person tokens left.
  return false;
}

function personTokens(part) {
  return part
    .split(' ')
    .filter(Boolean)
    .filter((t) => !NOISE.has(t))
    .filter((t) => !/^\d+$/.test(t));
}

/**
 * Parse an assessor owner_name into persons [{last, first, middle}].
 * Handles "LAST FIRST M/FIRST2", "LAST FIRST/LAST2 FIRST2", "&" couples, suffixes.
 */
export function personsFromOwnerName(raw) {
  const n = normalizeName(raw);
  if (!n || isEntity(n)) return [];
  const parts = n.split(/\s*[/&]\s*/).filter(Boolean);
  const persons = [];
  let lastName = null;
  for (const part of parts) {
    const toks = personTokens(part);
    const full = toks.filter((t) => t.length > 1);
    const initials = toks.filter((t) => t.length === 1);
    if (full.length === 0) continue;
    if (full.length === 1) {
      // "FIRST" only → shares previous last name (couple/family listing)
      if (!lastName) { lastName = full[0]; continue; }
      persons.push({ last: lastName, first: full[0], middle: initials[0] ?? null });
    } else {
      lastName = full[0];
      persons.push({ last: full[0], first: full[1], middle: full[2] ?? initials[0] ?? null });
    }
  }
  return persons;
}

export function keyOf(last, first) {
  return `${last}|${first}`;
}

/** Keys for a property owner_name (assessor format, one ordering). */
export function propertyKeys(raw) {
  return [...new Set(personsFromOwnerName(raw).map((p) => keyOf(p.last, p.first)))];
}

/**
 * Keys for a signal's owner name — order unknown, so emit both interpretations
 * for each person. Also returns middle tokens for tie-breaking.
 */
export function signalKeys(raw) {
  const n = normalizeName(raw);
  if (!n || isEntity(n)) return { keys: [], middles: [] };
  const keys = new Set();
  const middles = new Set();
  for (const part of n.split(/\s*[/&]\s*/).filter(Boolean)) {
    const toks = personTokens(part);
    const full = toks.filter((t) => t.length > 1);
    const initials = toks.filter((t) => t.length === 1);
    if (full.length < 2) continue;
    const a = full[0], b = full[1], z = full[full.length - 1];
    keys.add(keyOf(a, b));          // LAST FIRST ...
    keys.add(keyOf(z, a));          // FIRST ... LAST
    if (full.length >= 3) {
      keys.add(keyOf(a, b));        // LAST FIRST MIDDLE (dup-safe)
      middles.add(full[2]);         // possible middle name
      middles.add(full[1]);         // if FIRST MIDDLE LAST, tok[1] is middle
    }
    for (const i of initials) middles.add(i);
  }
  return { keys: [...keys], middles: [...middles] };
}

/** Exact-normalized key for entities (LLCs, trusts-as-entities) so LLC-owned parcels match LLC docs. */
export function entityKey(raw) {
  const n = normalizeName(raw).replace(/\b(THE)\b/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 4 ? `=${n}` : null;
}
