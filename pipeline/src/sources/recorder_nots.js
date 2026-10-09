// pipeline/src/sources/recorder_nots.js
// Maricopa County Recorder – Notice of Trustee's Sale (NS) records.
// All scraping machinery lives in recorder_common.js (shared with recorder_liens.js);
// parsers are re-exported here for existing tests/imports.

import { createRecorderAdapter, parseRecorderDetail, parseListPage } from './recorder_common.js';

export { parseRecorderDetail, parseListPage };

export default createRecorderAdapter({
  id: 'recorder_nots',
  signalType: 'trustee_sale',
  code: 'NS',
});
