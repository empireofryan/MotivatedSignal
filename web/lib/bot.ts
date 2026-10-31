// Known link-scanner / security-gateway user agents that prefetch links from inside an email
// before a human ever opens it. Most sandboxes (e.g. Defender detonation) use a plain Chrome UA
// and slip past this list, which is why trials only start on real input (see TrialActivator).
const BOT_UA_PATTERNS: RegExp[] = [
  /barracuda/i,
  /proofpoint/i,
  /mimecast/i,
  /microsoft.?defender/i,
  /safelinks/i, // Microsoft Defender for Office 365 "Safe Links" prefetcher
  /googleimageproxy/i, // Gmail's image-proxy UA also prefetches plain links in some configs
  /headless/i,
  /bot|crawler|spider|preview/i,
];

export function isBotUserAgent(ua: string | null): boolean {
  if (!ua || ua.trim() === '') return true;
  return BOT_UA_PATTERNS.some((re) => re.test(ua));
}
