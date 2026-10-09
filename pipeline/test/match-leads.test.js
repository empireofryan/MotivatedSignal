import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  labelSignalTypes,
  normalizeZips,
  normalizeCities,
  compareLeads,
  leadKey,
  hasSignalType,
  lenderPriority,
  compareLeadsForSegment,
  buildPitchLine,
  matchLeadsToProspects,
  buildProspectMatch,
  toMatchRow,
} from '../src/match-leads.js';

function lead(overrides = {}) {
  return {
    apn: '123-45-678',
    signal_type: 'probate',
    signal_types: 'probate',
    event_date: '2026-09-20',
    owner_name: 'JOHN SMITH',
    situs_address: '4412 W Glenrosa Ave',
    situs_city: 'Phoenix',
    situs_zip: '85019',
    score: 90,
    is_hot: true,
    stacked_types: 1,
    mailing_address: 'PO BOX 1, Tucson, AZ 85701',
    absentee: true,
    years_owned: 23,
    assessed_value: 210000,
    ...overrides,
  };
}

function prospect(overrides = {}) {
  return {
    id: 1,
    rank: 1,
    company: 'Test Co',
    contact_name: 'Jane Doe',
    email: 'jane@test.co',
    segment: 'wholesaler',
    zips: null,
    cities: null,
    ...overrides,
  };
}

describe('labelSignalTypes()', () => {
  it('maps known codes to plain words and joins with " + "', () => {
    assert.equal(labelSignalTypes('probate,tax_delinquent'), 'Probate + tax delinquent');
  });

  it('dedupes repeated codes', () => {
    assert.equal(labelSignalTypes('probate,probate'), 'Probate');
  });

  it('falls back to underscore→space for unknown codes', () => {
    assert.equal(labelSignalTypes('some_new_code'), 'Some new code');
  });

  it('returns empty string for null/empty input', () => {
    assert.equal(labelSignalTypes(null), '');
    assert.equal(labelSignalTypes(''), '');
  });

  it('covers every mapped code', () => {
    const codes = [
      'trustee_sale',
      'code_violation',
      'tax_delinquent',
      'probate',
      'divorce',
      'lis_pendens',
      'mechanics_lien',
      'lien',
    ];
    for (const c of codes) {
      assert.notEqual(labelSignalTypes(c), c, `${c} should map to a plain-word label`);
    }
  });
});

describe('normalizeZips() / normalizeCities()', () => {
  it('splits comma-separated values and trims', () => {
    assert.deepEqual(normalizeZips(' 85016, 85013 '), ['85016', '85013']);
  });

  it('lowercases cities', () => {
    assert.deepEqual(normalizeCities('Phoenix, Mesa'), ['phoenix', 'mesa']);
  });

  it('returns [] for null/empty', () => {
    assert.deepEqual(normalizeZips(null), []);
    assert.deepEqual(normalizeCities(''), []);
  });
});

describe('compareLeads()', () => {
  it('ranks higher stacked_types first', () => {
    const a = lead({ stacked_types: 2 });
    const b = lead({ stacked_types: 1 });
    assert.ok(compareLeads(a, b) < 0);
  });

  it('ranks higher score first when stacked_types tie', () => {
    const a = lead({ stacked_types: 1, score: 95 });
    const b = lead({ stacked_types: 1, score: 50 });
    assert.ok(compareLeads(a, b) < 0);
  });

  it('ranks more recent event_date first when stacked_types/score tie', () => {
    const a = lead({ stacked_types: 1, score: 90, event_date: '2026-09-25' });
    const b = lead({ stacked_types: 1, score: 90, event_date: '2026-09-01' });
    assert.ok(compareLeads(a, b) < 0);
  });

  it('treats null score/event_date as lowest', () => {
    const a = lead({ score: 10, event_date: '2026-01-01' });
    const b = lead({ score: null, event_date: null, stacked_types: a.stacked_types });
    assert.ok(compareLeads(a, b) < 0);
  });
});

describe('buildPitchLine()', () => {
  it('matches the spec example format', () => {
    const line = buildPitchLine(
      lead({ signal_types: 'probate,tax_delinquent', years_owned: 23, absentee: true })
    );
    assert.equal(
      line,
      'Probate + tax delinquent · 4412 W Glenrosa Ave, Phoenix 85019 · owned 23 yrs · absentee'
    );
  });

  it('says owner-occupied when not absentee', () => {
    const line = buildPitchLine(lead({ absentee: false }));
    assert.ok(line.endsWith('owner-occupied'));
  });

  it('omits years_owned when null', () => {
    const line = buildPitchLine(lead({ years_owned: null }));
    assert.ok(!line.includes('owned'));
  });

  it('falls back gracefully when address is unresolved', () => {
    const line = buildPitchLine(lead({ situs_address: null, situs_city: null, situs_zip: null }));
    assert.ok(line.includes('(address unresolved)'));
  });

  it('dedupes a doubled trailing unit token and title-cases the address', () => {
    const line = buildPitchLine(
      lead({ situs_address: '1024 E FRYE RD 1100 1100', situs_city: 'PHOENIX', situs_zip: '85048' })
    );
    assert.ok(line.includes('1024 E Frye Rd #1100, Phoenix 85048'), line);
    assert.ok(!line.includes('1100 1100'));
  });
});

describe('hasSignalType() / lenderPriority() / compareLeadsForSegment()', () => {
  it('hasSignalType() checks the comma-joined signal_types list', () => {
    assert.ok(hasSignalType(lead({ signal_types: 'probate,trustee_sale' }), 'trustee_sale'));
    assert.ok(!hasSignalType(lead({ signal_types: 'probate' }), 'trustee_sale'));
  });

  it('lenderPriority() ranks trustee_sale + 10yrs+ ahead of trustee_sale ahead of other signals', () => {
    const tenYr = lead({ signal_types: 'trustee_sale', years_owned: 12 });
    const shortTenure = lead({ signal_types: 'trustee_sale', years_owned: 3 });
    const other = lead({ signal_types: 'code_violation', years_owned: 20 });
    assert.equal(lenderPriority(tenYr), 0);
    assert.equal(lenderPriority(shortTenure), 1);
    assert.equal(lenderPriority(other), 2);
  });

  it('compareLeadsForSegment() prefers trustee_sale+10yrs for lender segment even when it ranks worse otherwise', () => {
    const codeViolation = lead({
      apn: 'cv', signal_types: 'code_violation', years_owned: 7, stacked_types: 2, score: 95,
    });
    const trusteeTenYr = lead({
      apn: 'ts10', signal_types: 'trustee_sale', years_owned: 11, stacked_types: 1, score: 10,
    });
    assert.ok(compareLeadsForSegment(trusteeTenYr, codeViolation, 'lender') < 0);
    // Non-lender segments ignore the lender tier and fall straight through to compareLeads.
    assert.ok(compareLeadsForSegment(trusteeTenYr, codeViolation, 'wholesaler') > 0);
  });

  it('matchLeadsToProspects() picks trustee_sale+10yrs leads first for a lender prospect', () => {
    const codeViolation = lead({
      apn: 'cv', signal_types: 'code_violation', years_owned: 7, stacked_types: 2, score: 95,
    });
    const trusteeShort = lead({
      apn: 'ts-short', signal_types: 'trustee_sale', years_owned: 2, stacked_types: 0, score: 5,
    });
    const trusteeTenYr = lead({
      apn: 'ts10', signal_types: 'trustee_sale', years_owned: 15, stacked_types: 0, score: 5,
    });
    const lenderProspect = prospect({ segment: 'lender' });
    const [{ matches }] = matchLeadsToProspects(
      [lenderProspect],
      [codeViolation, trusteeShort, trusteeTenYr]
    );
    assert.deepEqual(matches.map((m) => m.lead.apn), ['ts10', 'ts-short']);
  });
});

describe('matchLeadsToProspects()', () => {
  it('prefers a zip match over a city or anyone match', () => {
    const zipLead = lead({ apn: 'zip-lead', situs_zip: '85201', situs_city: 'Mesa', score: 1 });
    const cityLead = lead({ apn: 'city-lead', situs_zip: '85202', situs_city: 'Mesa', score: 99 });
    const anyLead = lead({ apn: 'any-lead', situs_zip: '99999', situs_city: 'Somewhere', score: 99 });

    const p = prospect({ zips: '85201', cities: 'mesa' });
    const [{ matches }] = matchLeadsToProspects([p], [zipLead, cityLead, anyLead]);

    assert.equal(matches[0].lead.apn, 'zip-lead');
    assert.equal(matches[0].tier, 'zip');
  });

  it('falls back to city match (case-insensitive) when no zip match exists', () => {
    const cityLead = lead({ apn: 'city-lead', situs_zip: '85202', situs_city: 'MESA' });
    const anyLead = lead({ apn: 'any-lead', situs_zip: '99999', situs_city: 'Somewhere' });

    const p = prospect({ zips: '85201', cities: 'mesa' });
    const [{ matches }] = matchLeadsToProspects([p], [cityLead, anyLead]);

    assert.ok(matches.some((m) => m.lead.apn === 'city-lead' && m.tier === 'city'));
  });

  it('falls back to anyone when prospect has no zips/cities', () => {
    const l1 = lead({ apn: 'l1' });
    const l2 = lead({ apn: 'l2' });
    const p = prospect({ zips: null, cities: null });
    const [{ matches }] = matchLeadsToProspects([p], [l1, l2]);
    assert.equal(matches.length, 2);
    assert.ok(matches.every((m) => m.tier === 'any'));
  });

  it('ranks within a tier by stacked_types desc, score desc, event_date desc', () => {
    const low = lead({ apn: 'low', stacked_types: 1, score: 10, event_date: '2026-01-01' });
    const high = lead({ apn: 'high', stacked_types: 3, score: 10, event_date: '2026-01-01' });
    const mid = lead({ apn: 'mid', stacked_types: 2, score: 10, event_date: '2026-01-01' });
    const p = prospect();
    const [{ matches }] = matchLeadsToProspects([p], [low, high, mid]);
    assert.deepEqual(matches.map((m) => m.lead.apn), ['high', 'mid']);
  });

  it('caps a lead at perLeadCap uses across prospects', () => {
    const onlyLead = lead({ apn: 'only' });
    const prospects = [1, 2, 3, 4].map((id) => prospect({ id, rank: id }));
    const results = matchLeadsToProspects(prospects, [onlyLead], { perLeadCap: 3 });
    const usedBy = results.filter((r) => r.matches.some((m) => m.lead.apn === 'only'));
    assert.equal(usedBy.length, 3);
    assert.equal(results[3].matches.length, 0); // 4th prospect gets nothing left to assign
  });

  it('prefers an unused lead over a higher-scored already-used one', () => {
    const popular = lead({ apn: 'popular', stacked_types: 1, score: 100 });
    const other1 = lead({ apn: 'other1', stacked_types: 1, score: 50 });
    const other2 = lead({ apn: 'other2', stacked_types: 1, score: 1 });
    const p1 = prospect({ id: 1, rank: 1 });
    const p2 = prospect({ id: 2, rank: 2 });

    const results = matchLeadsToProspects([p1, p2], [popular, other1, other2]);

    // p1 takes the top 2 by quality: popular, other1.
    assert.deepEqual(results[0].matches.map((m) => m.lead.apn), ['popular', 'other1']);

    // p2: other2 is still unused (count 0) so it's picked ahead of popular/other1
    // (count 1 each) even though it has the lowest score of the three.
    const p2Apns = results[1].matches.map((m) => m.lead.apn);
    assert.ok(p2Apns.includes('other2'), 'expected the unused lead to be preferred');
    // the second slot goes to the better-scored of the two already-used leads
    assert.ok(p2Apns.includes('popular'), 'expected quality tiebreak among equally-used leads');
  });

  it('is deterministic given the same input', () => {
    const leads = [
      lead({ apn: 'a', stacked_types: 2, score: 50, event_date: '2026-05-01' }),
      lead({ apn: 'b', stacked_types: 1, score: 90, event_date: '2026-06-01' }),
      lead({ apn: 'c', stacked_types: 3, score: 10, event_date: '2026-01-01' }),
    ];
    const prospects = [prospect({ id: 1, rank: 1 }), prospect({ id: 2, rank: 2 })];
    const r1 = matchLeadsToProspects(prospects, leads);
    const r2 = matchLeadsToProspects(prospects, leads);
    assert.deepEqual(
      r1.map((r) => r.matches.map((m) => m.lead.apn)),
      r2.map((r) => r.matches.map((m) => m.lead.apn))
    );
  });
});

describe('buildProspectMatch()', () => {
  it('shapes a prospect + matches into the documented output fields', () => {
    const p = prospect();
    const l = lead();
    const out = buildProspectMatch({ prospect: p, matches: [{ lead: l, tier: 'zip' }] });
    assert.equal(out.id, p.id);
    assert.equal(out.rank, p.rank);
    assert.equal(out.company, p.company);
    assert.equal(out.contact_name, p.contact_name);
    assert.equal(out.email, p.email);
    assert.equal(out.segment, p.segment);
    assert.equal(out.leads.length, 1);
    const lo = out.leads[0];
    for (const key of [
      'owner_name',
      'situs_address',
      'situs_city',
      'situs_zip',
      'signal_types',
      'event_date',
      'years_owned',
      'assessed_value',
      'absentee',
      'mailing_address',
      'score',
      'apn',
      'est_auction_date',
      'pitch_line',
    ]) {
      assert.ok(key in lo, `missing key: ${key}`);
    }
  });
});

describe('toMatchRow()', () => {
  it('shapes a buildProspectMatch() lead entry into a prospect_matches row', () => {
    const p = prospect({ id: 7 });
    const l = lead({ est_auction_date: '2026-10-20' });
    const matched = buildProspectMatch({ prospect: p, matches: [{ lead: l, tier: 'zip' }] });
    const row = toMatchRow(p.id, '2026-10-04', 1, matched.leads[0]);

    assert.equal(row.prospect_id, 7);
    assert.equal(row.match_date, '2026-10-04');
    assert.equal(row.rank, 1);
    assert.equal(row.apn, '123-45-678');
    assert.equal(row.match_tier, 'zip');
    assert.equal(row.owner_name, 'JOHN SMITH');
    assert.equal(row.situs_address, '4412 W Glenrosa Ave');
    assert.equal(row.event_date, '2026-09-20');
    assert.equal(row.est_auction_date, '2026-10-20');
    assert.equal(row.absentee, 1);
    assert.equal(row.pitch_line, matched.leads[0].pitch_line);
  });

  it('normalizes Date objects to YYYY-MM-DD strings', () => {
    const p = prospect();
    const l = lead({ event_date: new Date('2026-09-20T07:00:00Z'), est_auction_date: null });
    const matched = buildProspectMatch({ prospect: p, matches: [{ lead: l, tier: 'any' }] });
    const row = toMatchRow(p.id, '2026-10-04', 2, matched.leads[0]);

    assert.equal(row.event_date, '2026-09-20');
    assert.equal(row.est_auction_date, null);
  });

  it('maps absentee false → 0 and null → null (never boolean)', () => {
    const p = prospect();
    const matchedFalse = buildProspectMatch({
      prospect: p,
      matches: [{ lead: lead({ absentee: false }), tier: 'any' }],
    });
    const matchedNull = buildProspectMatch({
      prospect: p,
      matches: [{ lead: lead({ absentee: null }), tier: 'any' }],
    });
    assert.equal(toMatchRow(p.id, '2026-10-04', 1, matchedFalse.leads[0]).absentee, 0);
    assert.equal(toMatchRow(p.id, '2026-10-04', 1, matchedNull.leads[0]).absentee, null);
  });
});
