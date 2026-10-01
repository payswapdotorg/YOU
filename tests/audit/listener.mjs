// ═══════════════════════════════════════════════════════════════════════════
// W3.C F8 audit battery — webhook request-bin listener (port 3231)
// Records every request verbatim (method, path, headers, body) as JSONL to
// the file given as argv[2] (default /tmp/w3c-webhooks.jsonl). Used to
// verify webhook fan-out end-to-end from a registered endpoint.
// ═══════════════════════════════════════════════════════════════════════════
import { createServer } from 'http';
import { appendFileSync } from 'fs';

const PORT = 3231;
const OUT = process.argv[2] ?? '/tmp/w3c-webhooks.jsonl';

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const record = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'] ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      body,
    };
    try { appendFileSync(OUT, JSON.stringify(record) + '\n'); } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
});

server.listen(PORT, () => {
  console.log(`w3c-audit listener on :${PORT} -> ${OUT}`);
});
