// ═══════════════════════════════════════════════════════════════════════════
// W4.A F-04 evidence — verify the delivered webhook signature end-to-end:
//   1. read the captured delivery (x-you-timestamp / x-you-signature / body)
//      from the header-listener JSONL;
//   2. read the endpoint's stored secret straight from the database (the API
//      never exposes it — same scaffolding pattern as tests/audit/db-probe.mjs);
//   3. recompute HMAC-SHA256(secret, timestamp + "." + rawBody) and compare;
//   4. prove a tampered body does NOT verify.
// Usage: YOU_APP_DIR=<apps/web> DATABASE_URL=<url> node verify-sig.mjs <jsonl> [endpointId]
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac } from 'crypto';
import { createRequire } from 'module';
import { readFileSync } from 'fs';

const jsonl = process.argv[2] ?? '/tmp/w4a-webhooks.jsonl';
const endpointId = process.argv[3] ?? null;
const appDir = process.env.YOU_APP_DIR;
if (!appDir || !process.env.DATABASE_URL) {
  console.error('YOU_APP_DIR and DATABASE_URL env vars are required');
  process.exit(2);
}

const lines = readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean);
if (lines.length === 0) {
  console.log('VERIFY: FAIL — listener captured no deliveries');
  process.exit(1);
}
const record = JSON.parse(lines[lines.length - 1]);

const requireFromApp = createRequire(`${appDir}/package.json`);
const { PrismaClient } = requireFromApp('@prisma/client');
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const where = endpointId ? { id: endpointId } : { url: { contains: '127.0.0.1:3232' } };
const endpoints = await db.webhookEndpoint.findMany({ where });
await db.$disconnect();

if (endpoints.length === 0) {
  console.log('VERIFY: FAIL — no webhook endpoint found in the database');
  process.exit(1);
}
// the listener is dedicated to this run: the (only) endpoint pointing at it
const endpoint = endpoints[endpoints.length - 1];
const secret = endpoint.secret;

const hmac = (body) => createHmac('sha256', secret).update(`${record['x-you-timestamp']}.${body}`, 'utf8').digest('hex');

const delivered = record['x-you-signature'] ?? '';
const expected = hmac(record.body);
const tamperedBody = JSON.stringify({ ...JSON.parse(record.body), type: 'tampered.event' });
const tamperedSig = hmac(tamperedBody);

const okHeaders = /^sha256=[0-9a-f]{64}$/.test(delivered) && /^\d{10}$/.test(record['x-you-timestamp'] ?? '');
const okSig = delivered === `sha256=${expected}`;
const okTamper = tamperedSig !== expected;

console.log(`captured delivery : ${record.method} ${record.url}`);
console.log(`x-you-timestamp   : ${record['x-you-timestamp']}`);
console.log(`x-you-signature   : ${delivered.slice(0, 24)}… (${delivered.length} chars)`);
console.log(`recomputed HMAC   : sha256=${expected.slice(0, 24)}… (over timestamp + '.' + raw body, with the stored secret)`);
console.log(`format ok         : ${okHeaders ? 'PASS' : 'FAIL'} (sha256=<64 hex> + unix-seconds timestamp)`);
console.log(`signature verifies: ${okSig ? 'PASS' : 'FAIL'} (exact match over the EXACT raw body)`);
console.log(`tampered body     : ${okTamper ? 'PASS — does NOT verify (mismatch, as it must)' : 'FAIL — tampered body verified?!'}`);
console.log(`body type         : ${JSON.parse(record.body).type}`);

if (okHeaders && okSig && okTamper) {
  console.log('VERIFY: PASS — delivery signed, signature verifies, tamper detected');
  process.exit(0);
}
console.log('VERIFY: FAIL');
process.exit(1);
