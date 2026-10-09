// pipeline/src/sources/code_tempe.js
// Tempe AZ code complaints via ArcGIS FeatureServer
// Real fields from fixture: OBJECTID, Id (UUID), CaseNo, Address, CaseStatus,
//   CaseStatusDate, CaseOpenDate, Violation, ViolationType — no parcel field
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE =
  'https://services.arcgis.com/lQySeXwbBg53XWDi/arcgis/rest/services/code_complaints/FeatureServer/0';

export function mapTempe(features) {
  return features.map((f) => {
    const a = f.attributes;
    // GRAIN DECISION: externalId = CaseNo (one signal per code case, not per violation).
    // A single case may have multiple violation rows in the ArcGIS layer (e.g., 2,743 rows
    // collapse to ~1,100 case-level signals). This is intentional — multiple violations
    // within the same case represent the same distress event on the same property, so
    // collapsing them into one signal avoids artificial duplication. Do NOT change this to
    // use OBJECTID or Id; that would produce one signal per violation row, not per case.
    return {
      apn: null,
      externalId: String(a.CaseNo ?? a.Id ?? a.OBJECTID),
      sourceUrl: 'https://www.tempe.gov/government/community-development/code-compliance',
      eventDate: a.CaseOpenDate ? new Date(a.CaseOpenDate).toISOString().slice(0, 10) : null,
      status: a.CaseStatus ?? null,
      situsAddress: a.Address ?? null,
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'code_tempe',
  signalType: 'code_violation',
  kind: 'api',
  async fetch() {
    return mapTempe(await fetchArcgisAll(SERVICE));
  },
};
