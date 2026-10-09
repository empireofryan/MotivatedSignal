// pipeline/src/sources/code_county.js
// Maricopa County unincorporated code case violations via ArcGIS FeatureServer
// Real fields from fixture: OBJECTID, PermitCenterID (UUID), Address, APN,
//   Opened (epoch ms), Closed (epoch ms, nullable), Status, CodeCaseNumber, Type
import { normalizeApn } from '../normalize.js';
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE =
  'https://services.arcgis.com/ykpntM6e3tHvzKRJ/arcgis/rest/services/Code_Case_Violations/FeatureServer/0';

export function mapCounty(features) {
  return features.map((f) => {
    const a = f.attributes;
    return {
      apn: a.APN ? normalizeApn(a.APN) : null,
      externalId: String(a.CodeCaseNumber ?? a.PermitCenterID ?? a.OBJECTID),
      sourceUrl: 'https://www.maricopa.gov/1603/Code-Enforcement',
      eventDate: a.Opened ? new Date(a.Opened).toISOString().slice(0, 10) : null,
      status: a.Status ?? null,
      situsAddress: a.Address ?? null,
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'code_county',
  signalType: 'code_violation',
  kind: 'api',
  async fetch() {
    return mapCounty(await fetchArcgisAll(SERVICE));
  },
};
