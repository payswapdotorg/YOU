// ═══════════════════════════════════════════════════════════════════════════
// W4.A F-04 evidence — header-capturing request bin (tests/audit/listener.mjs
// pattern, extended to record the signature headers). Records every request
// verbatim as JSONL: { ts, method, url, x-you-timestamp, x-you-signature, body }
// Usage: node header-listener.mjs [port=3232] [out=/tmp/w4a-webhooks.jsonl]
// ═══════════════════════════════════════════════════════════════════════════
import { createServer } from 'http';
import { appendFileSync } from 'fs';

const PORT = Number(process.argv[2] ?? 3232);
const OUT = process.argv[3] ?? '/tmp/w4a-webhooks.jsonl';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      appendFileSync(OUT, JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        url: req.url,
        'x-you-timestamp': req.headers['x-you-timestamp'] ?? null,
        'x-you-signature': req.headers['x-you-signature'] ?? null,
        body,
      }) + '\n');
    } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`w4a header-listener on 127.0.0.1:${PORT} -> ${OUT}`);
});
