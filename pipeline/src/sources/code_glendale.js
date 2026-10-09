// pipeline/src/sources/code_glendale.js
// Glendale AZ code compliance cases via ArcGIS FeatureServer
// Real fields from fixture: ObjectID, CodeCaseNumber, RequestDate, RequestStatus,
//   StreetNum, StreetName, CityName — no parcel field available
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE =
  'https://services1.arcgis.com/9fVTQQSiODPjLUTa/arcgis/rest/services/GlendaleOne_Code_Compliance_Cases/FeatureServer/0';

export function mapGlendale(features) {
  return features.map((f) => {
    const a = f.attributes;
    // No parcel field in this layer — build address from components
    const addr =
      [a.StreetNum, a.StreetName, a.CityName].filter(Boolean).join(' ') || null;
    return {
      apn: null,
      externalId: String(a.CodeCaseNumber ?? a.ObjectID),
      sourceUrl: 'https://glendaleone.glendaleaz.com/',
      eventDate: a.RequestDate ? new Date(a.RequestDate).toISOString().slice(0, 10) : null,
      status: a.RequestStatus ?? null,
      situsAddress: addr,
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'code_glendale',
  signalType: 'code_violation',
  kind: 'api',
  async fetch() {
    return mapGlendale(await fetchArcgisAll(SERVICE));
  },
};
