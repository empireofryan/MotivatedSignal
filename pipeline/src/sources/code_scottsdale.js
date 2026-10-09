// pipeline/src/sources/code_scottsdale.js
// Scottsdale AZ Planning & Development Code Violations via ArcGIS MapServer table
// Real fields from fixture: ViolationID, ComplaintID, DateComplaintReceived,
//   DateComplaintClosed, ComplaintStatus, ViolationCategory, ViolationCode,
//   StreetNumber, StreetDirection, StreetName, StreetType, ZipCode, ParcelCode
// Note: this is a Table layer (no geometry); uses fetchArcgisAll which works for tables too.
// Dataset covers rolling history; ~18k records as of 2026-06.
import { normalizeApn } from '../normalize.js';
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE =
  'https://maps.scottsdaleaz.gov/arcgis/rest/services/OpenData_Tabular/MapServer/10';

export function mapScottsdale(features) {
  return features.map((f) => {
    const a = f.attributes;
    const addrParts = [
      a.StreetNumber,
      a.StreetDirection,
      a.StreetName,
      a.StreetType,
    ].filter(Boolean);
    const addr = addrParts.length > 0 ? addrParts.join(' ') : null;
    return {
      apn: a.ParcelCode ? normalizeApn(a.ParcelCode) : null,
      externalId: String(a.ViolationID ?? a.ComplaintID),
      sourceUrl: 'https://www.scottsdaleaz.gov/codes/code-enforcement',
      eventDate: a.DateComplaintReceived
        ? new Date(a.DateComplaintReceived).toISOString().slice(0, 10)
        : null,
      status: a.ComplaintStatus ?? null,
      situsAddress: addr,
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'code_scottsdale',
  signalType: 'code_violation',
  kind: 'api',
  async fetch() {
    return mapScottsdale(await fetchArcgisAll(SERVICE));
  },
};
