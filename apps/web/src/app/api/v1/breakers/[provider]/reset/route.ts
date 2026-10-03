// POST /api/v1/breakers/:provider/reset — P6.A6 manual circuit-breaker reset
// (admin-gated). Known providers: zai, openrouter.
//
// The breaker also heals on its own (open → half-open after the cooldown, a
// successful probe closes it) — this route is the operator override for
// "I know the provider is back; skip the cooldown".
//
// Admin gate = the maintenance precedent: operator SESSION only; API keys
// are refused (403).
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, forbidden, handleRoute } from '@/lib/you/core/errors';
import { PROVIDER_NAMES, resetProviderBreaker } from '@/lib/you/core/breaker';
import { audit } from '@/lib/you/core/events';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    if (auth.actorType !== 'user') {
      // breaker reset is an operator action — session auth only
      throw forbidden('circuit-breaker reset requires an operator session (api keys are not permitted)');
    }
    const { provider } = await params;

    if (!(PROVIDER_NAMES as readonly string[]).includes(provider)) {
      throw badRequest(`unknown provider "${provider}" — known providers: ${PROVIDER_NAMES.join(', ')}`);
    }

    const snapshot = resetProviderBreaker(provider);

    await audit(auth.tenantId, auth, 'breaker.reset', 'provider', null, { provider, state: snapshot.state });

    return Response.json({ provider, state: snapshot.state });
  });
}
