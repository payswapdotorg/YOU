// ═══════════════════════════════════════════════════════════════════════════
// W3.C F8 audit battery — database probe (test scaffolding ONLY)
// Read/write DB fixtures the public API cannot create directly (second
// tenant, expired grants, published TwinVersion). This NEVER modifies
// application source; it exists so the battery can exercise isolation and
// TTL paths without waiting real hours.
// Run with YOU_APP_DIR pointing at apps/web and DATABASE_URL set explicitly, e.g.:
//   YOU_APP_DIR=$PWD DATABASE_URL="file:$PWD/db/custom.db" bun ../../tests/audit/db-probe.mjs <cmd> [args]
// YOU_APP_DIR is REQUIRED: this script lives outside apps/web, and module
// resolution from here would otherwise find a foreign @prisma/client.
// ═══════════════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { randomBytes } from 'crypto';

const appDir = process.env.YOU_APP_DIR;
if (!appDir) {
  console.error('YOU_APP_DIR env var is required (absolute path to apps/web)');
  process.exit(1);
}
const requireFromApp = createRequire(`${appDir}/package.json`);
const { PrismaClient } = requireFromApp('@prisma/client');

const db = new PrismaClient();
const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'expire-grant': {
      const [id] = args;
      const g = await db.consentGrant.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 3600 * 1000) },
      });
      console.log(JSON.stringify({ id: g.id, expiresAt: g.expiresAt.toISOString(), revokedAt: g.revokedAt }));
      break;
    }
    case 'restore-grant': {
      // extends expiry only; revokedAt is never cleared (revocation is permanent by design)
      const [id, hours = '2'] = args;
      const g = await db.consentGrant.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() + Number(hours) * 3600 * 1000) },
      });
      console.log(JSON.stringify({ id: g.id, expiresAt: g.expiresAt.toISOString(), revokedAt: g.revokedAt }));
      break;
    }
    case 'grant-info': {
      const [id] = args;
      const g = await db.consentGrant.findUniqueOrThrow({ where: { id } });
      console.log(JSON.stringify({
        id: g.id, subjectId: g.subjectId, scopes: g.scopes,
        expiresAt: g.expiresAt.toISOString(), revokedAt: g.revokedAt?.toISOString() ?? null,
      }));
      break;
    }
    case 'create-tenant-b': {
      // second tenant + user + session — the API only bootstraps the demo
      // tenant (ensureDemoContext), so the battery creates tenant B directly.
      const tenant = await db.tenant.upsert({
        where: { slug: 'audit-tenant-b' },
        create: { slug: 'audit-tenant-b', name: 'W3.C Audit Tenant B' },
        update: {},
      });
      const user = await db.user.upsert({
        where: { email: 'w3c-audit-b@you.dev' },
        create: { tenantId: tenant.id, email: 'w3c-audit-b@you.dev', name: 'Audit Tenant B', role: 'owner' },
        update: {},
      });
      const token = `w3cAuditTenantB${randomBytes(24).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      const session = await db.session.create({ data: { userId: user.id, token, expiresAt } });
      console.log(JSON.stringify({
        tenantId: tenant.id, userId: user.id, sessionId: session.id, token,
      }));
      break;
    }
    case 'count-templates': {
      const [idemKey] = args;
      console.log(JSON.stringify({ idempotencyKey: idemKey, count: await db.template.count({ where: { idempotencyKey: idemKey } }) }));
      break;
    }
    case 'count-jobs': {
      const [idemKey] = args;
      console.log(JSON.stringify({ idempotencyKey: idemKey, count: await db.job.count({ where: { idempotencyKey: idemKey } }) }));
      break;
    }
    case 'create-twinversion': {
      // minimal published TwinVersion fixture (the render route requires one)
      const [twinId] = args;
      const twin = await db.twin.findUniqueOrThrow({ where: { id: twinId } });
      const v = await db.twinVersion.create({
        data: {
          twinId: twin.id,
          version: 1,
          status: 'published',
          htir: JSON.stringify({ format: 'htir/v1', subject: twin.subjectId, note: 'w3c-audit-fixture' }),
          evidenceAssetIds: '[]',
        },
      });
      console.log(JSON.stringify({ id: v.id, twinId: v.twinId, version: v.version, status: v.status }));
      break;
    }
    case 'webhook-deliveries': {
      const [endpointId] = args;
      const rows = await db.webhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'asc' },
      });
      console.log(JSON.stringify(rows.map((d) => ({
        id: d.id, eventId: d.eventId, status: d.status, attempts: d.attempts, lastError: d.lastError,
      }))));
      break;
    }
    case 'expire-session': {
      const [token] = args;
      const s = await db.session.updateMany({
        where: { token },
        data: { expiresAt: new Date(Date.now() - 60 * 1000) },
      });
      console.log(JSON.stringify({ matched: s.count }));
      break;
    }
    default:
      console.error(`unknown command "${cmd}"`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`db-probe ${cmd} failed:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
