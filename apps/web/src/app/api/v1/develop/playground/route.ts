// GET /api/v1/develop/playground — the playground's server surface (P6.B9):
// the sandbox/test-mode resolution (fail-closed, honest reason — never fake
// responses) plus the frozen-inventory count, so the client can trip-wire
// against a stale bundle.
//
// NEW ROUTE, FLAGGED for the TL per the freeze law: this path is not yet in
// contracts/openapi/v1/openapi.yaml — the TL extends the freeze on merge
// (the P6.B6 artifacts-route precedent).
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute } from '@/lib/you/core/errors';
import { PLAYGROUND_OPERATIONS } from '@/lib/you/develop/playground-ops';
import {
  PLAYGROUND_SANDBOX_ENV_VAR,
  playgroundFixturesPresent,
  resolveSandboxMode,
} from '@/lib/you/develop/sandbox';

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    await requireApiAuth(request);
    const sandbox = resolveSandboxMode({ raw: process.env[PLAYGROUND_SANDBOX_ENV_VAR] }, playgroundFixturesPresent());
    return Response.json({
      sandbox,
      envVar: PLAYGROUND_SANDBOX_ENV_VAR,
      inventoryCount: PLAYGROUND_OPERATIONS.length,
    });
  });
}
