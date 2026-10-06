// POST /api/v1/lab/failures/:id/evidence-request — the Capture Scientist
// (P6.C10): the Lab creates a TARGETED EvidenceRequest from a benchmark
// failure, scoped to the missing region/action, with capture instructions
// derived from the REAL failure data (suspected cause + recorded remediation)
// and the F1 capability mapping (the same capabilities B5's guided
// fulfillment maps to focused capture steps).
//
// Honest law: recommendations derive from real failure data only — no
// fabricated guidance. A failure without a region, or a region no capture
// protocol maps to, is an honest 400 refusal.
//
// The request is created in the CALLER's tenant (fulfillment is a real
// capture there); source='lab' + originFailureId record the derivation.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, notFound, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { evidenceRequestView } from '@/lib/you/core/views';
import { buildScientistRequest, isScientistRefusal } from '@/lib/you/lab/capture-scientist';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    await readJsonBody(request); // tolerate an empty JSON body

    const failure = await db.failureCase.findUnique({ where: { id } });
    if (!failure) throw notFound(`failure case "${id}" not found`);

    let inputConditions: Record<string, unknown> = {};
    try {
      inputConditions = JSON.parse(failure.inputConditions || '{}') as Record<string, unknown>;
    } catch {
      inputConditions = {};
    }

    const draft = buildScientistRequest({
      id: failure.id,
      benchmarkRunId: failure.benchmarkRunId,
      inputConditions,
      suspectedCause: failure.suspectedCause,
      remediation: failure.remediation,
      confidence: failure.confidence,
    });
    if (isScientistRefusal(draft)) {
      throw badRequest(`the Capture Scientist cannot build a request for this failure — ${draft.refusal}`);
    }

    const evidenceRequest = await db.evidenceRequest.create({
      data: {
        tenantId: auth.tenantId,
        twinVersionId: null,
        reason: draft.reason,
        capability: draft.capability,
        instructions: draft.instructions,
        expectedSignal: draft.expectedSignal,
        scope: draft.scope,
        status: 'open',
        source: 'lab',
        originFailureId: failure.id,
      },
    });

    await emitEvent(auth.tenantId, 'evidence.requested', 'evidence_request', evidenceRequest.id, {
      requestId: evidenceRequest.id,
      capability: draft.capability,
      reason: draft.reason,
      source: 'lab',
      originFailureId: failure.id,
    });

    return Response.json(evidenceRequestView(evidenceRequest), { status: 201 });
  });
}
