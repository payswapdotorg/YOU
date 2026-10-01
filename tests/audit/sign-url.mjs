// ═══════════════════════════════════════════════════════════════════════════
// W3.C F8 audit battery — storage URL signer (battery-side replica)
// Replicates the EXACT signing algorithm of apps/web/src/lib/you/core/
// storage.ts (urlsafe-b64 HMAC-SHA256 over `${key}.${exp}` with
// YOU_STORAGE_SECRET) so the battery can construct edge-case capabilities:
//   - a correctly-signed but EXPIRED URL (exp in the past)
//   - a correctly-signed but UNSAFE/traversal key
// Both must be rejected by the storage route.
// Usage: bun sign-url.mjs <key> <expOffsetSeconds>
// ═══════════════════════════════════════════════════════════════════════════
import { createHmac } from 'crypto';

const [key, offsetArg] = process.argv.slice(2);
if (!key) { console.error('usage: bun sign-url.mjs <key> <expOffsetSeconds>'); process.exit(1); }
const secret = process.env.YOU_STORAGE_SECRET;
if (!secret) { console.error('YOU_STORAGE_SECRET is not set'); process.exit(1); }

const offset = Number(offsetArg ?? '600');
const exp = Math.floor(Date.now() / 1000) + offset;
const sig = createHmac('sha256', secret).update(`${key}.${exp}`, 'utf8').digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

console.log(`/api/v1/storage/${key}?exp=${exp}&sig=${sig}`);
