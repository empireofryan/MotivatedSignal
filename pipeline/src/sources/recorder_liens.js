// pipeline/src/sources/recorder_liens.js
// Maricopa County Recorder lien-type documents — same scraper as NOTS,
// different document codes. Each is a distinct distress signal:
//   LP – Lis Pendens (pending litigation on the property)
//   ML – Material man's / mechanic's lien (unpaid contractor)
//   NL – Non-governmental lien (HOA / private liens live here)

import { createRecorderAdapter } from './recorder_common.js';

export const recorderLisPendens = createRecorderAdapter({
  id: 'recorder_lp',
  signalType: 'lis_pendens',
  code: 'LP',
});

export const recorderMechanicsLien = createRecorderAdapter({
  id: 'recorder_ml',
  signalType: 'mechanics_lien',
  code: 'ML',
});

export const recorderNonGovtLien = createRecorderAdapter({
  id: 'recorder_nl',
  signalType: 'lien',
  code: 'NL',
});
