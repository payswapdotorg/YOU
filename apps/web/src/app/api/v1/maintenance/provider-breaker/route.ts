// GET  /api/v1/maintenance/provider-breaker — circuit-breaker inspection (P6.A6-FULL)
// POST /api/v1/maintenance/provider-breaker — { provider, action: 'reset' | 'trip' }
//
// OPERATOR SESSION ONLY (maintenance law: api keys are refused).
//
// The manual control path for the per-provider circuit breakers:
//   reset — force-close + clear the failure window (after an incident is
//           fixed and you want traffic flowing again immediately, without
//           waiting out the cooldown / half-open probe)
//   trip  — force-open (drain a misbehaving provider deliberately; routes
//           that depend on it will return honest 503s with retry guidance)
//
// Breaker state is process-local (single-instance truth; multi-instance
// deployments must reset per instance — disclosed in the snapshot).
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, forbidden, handleRoute, readJsonBody } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { breakerSnapshot, resetBreaker, tripBreaker } from '@/lib/you/core/circuit-breaker';

const KNOWN_PROVIDERS = new Set(['zai', 'openrouter']);

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      throw forbidden('breaker inspection requires an operator session (api keys are not permitted)');
    }
    return Response.json(
      { breakers: breakerSnapshot(), note: 'state is process-local — reset per instance in multi-instance deployments' },
      { headers: { 'cache-control': 'no-store' } },
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      throw forbidden('breaker control requires an operator session (api keys are not permitted)');
    }
    const body = await readJsonBody(request);
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (!KNOWN_PROVIDERS.has(provider)) {
      throw badRequest(`provider must be one of: ${[...KNOWN_PROVIDERS].join(', ')} (got "${provider || '(none)'}")`);
    }
    if (action !== 'reset' && action !== 'trip') {
      throw badRequest('action must be "reset" or "trip"');
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 200) : `operator ${action}`;
    if (action === 'reset') resetBreaker(provider);
    else tripBreaker(provider, reason);

    await audit(auth.tenantId, auth, `breaker.${action}`, 'provider', null, { provider, reason });
    await emitEvent(auth.tenantId, `breaker.${action}`, 'provider', null, { provider, reason });

    return Response.json({ provider, action, breakers: breakerSnapshot() });
  });
}
