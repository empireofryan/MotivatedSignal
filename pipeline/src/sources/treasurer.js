// pipeline/src/sources/treasurer.js
import { normalizeApn } from '../normalize.js';
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE = 'https://services.arcgis.com/ykpntM6e3tHvzKRJ/arcgis/rest/services/ParcelLienDelinquent/FeatureServer/2';

export function mapTreasurer(features) {
  return features.map((f) => {
    const a = f.attributes;
    // Real keys from fixture: APN (parcel), PropertyFullStreetAddress (situs)
    const apn = normalizeApn(a.APN ?? a.PARCEL ?? a.Parcel ?? a.PARCELNUM);
    return {
      // apn is the normalized APN used as a direct join key (no FK constraint).
      // externalId is also set to apn for deduplication.
      apn: apn,
      externalId: apn,
      sourceUrl: 'https://treasurer.maricopa.gov/',
      situsAddress: a.PropertyFullStreetAddress ?? a.PHYSICAL_ADDRESS ?? a.SITUS_ADDRESS ?? a.SITE_ADDR ?? null,
      status: 'open',
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'treasurer_delinquent',
  signalType: 'tax_delinquent',
  kind: 'api',
  async fetch() {
    const features = await fetchArcgisAll(SERVICE);
    return mapTreasurer(features);
  },
};
