// ═══════════════════════════════════════════════════════════════════════════
// F-02 (W4.A) — API-surface envelope for UNMATCHED /api/v1/* paths.
// Next.js resolves concrete/static routes (e.g. /api/v1/templates,
// /api/v1/jobs/[id], /api/v1/storage/[...key]) before this catch-all, so
// matched routes are unaffected. Anything else under /api/v1/* used to fall
// through to the framework's default 404 HTML page; per docs/API_CONTRACTS.md
// §API rules it now returns the documented JSON error envelope:
//   404 { "error": { "code": "not_found", "message": "…" } }
// (content-type application/json — never framework HTML inside the API
// surface). /api/v1 itself (zero segments) is outside the v1 resource space
// and keeps the framework 404 — disclosed in w4a-report.md.
// ═══════════════════════════════════════════════════════════════════════════
import { jsonError } from '@/lib/you/core/errors';
import { ERR } from '@/lib/you/contracts';

function notFoundEnvelope(request: Request): Response {
  const pathname = new URL(request.url).pathname;
  return jsonError(
    ERR.NOT_FOUND,
    `no API route matches ${pathname} — the v1 surface is documented in docs/API_CONTRACTS.md`,
    404,
  );
}

export async function GET(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function POST(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function PUT(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return notFoundEnvelope(request);
}
