// pipeline/scripts/probe.js
// Usage: node scripts/probe.js <url> <outfile> [bytes]
import fs from 'node:fs';
const [, , url, out, bytes] = process.argv;
const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MotivatedSellers/1.0)' },
  redirect: 'follow',
});
if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText} from ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const slice = bytes ? buf.subarray(0, Number(bytes)) : buf;
fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(out, slice);
console.log(`wrote ${slice.length} bytes from ${url} -> ${out}`);
