// POST /api/v1/feedback — FeedbackRequest (references an artifact/TwinVersion;
// never mutates immutable evidence). Audit + event.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute, notFound, readJsonBody, reqString, optString } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { feedbackRequestView } from '@/lib/you/core/views';
import type { FeedbackVerdict } from '@/lib/you/contracts';

const VERDICTS: FeedbackVerdict[] = [
  'correct', 'incorrect', 'uncertain', 'missing-detail',
  'wrong-motion', 'wrong-identity', 'wrong-style',
];

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const body = await readJsonBody(request);

    if (typeof body.twinVersionId !== 'string' || !body.twinVersionId.trim()) {
      throw badRequest('twinVersionId is required');
    }
    const twinVersion = await db.twinVersion.findFirst({
      where: { id: body.twinVersionId, twin: { tenantId: auth.tenantId } },
    });
    if (!twinVersion) throw notFound(`twin version "${body.twinVersionId}" not found`);

    if (typeof body.verdict !== 'string' || !VERDICTS.includes(body.verdict as FeedbackVerdict)) {
      throw badRequest(`verdict must be one of: ${VERDICTS.join(', ')}`);
    }

    let solutionArtifactId: string | null = null;
    if (body.solutionArtifactId !== undefined && body.solutionArtifactId !== null) {
      if (typeof body.solutionArtifactId !== 'string') throw badRequest('solutionArtifactId must be a string');
      const solution = await db.solutionArtifact.findFirst({
        where: { id: body.solutionArtifactId, tenantId: auth.tenantId },
      });
      if (!solution) throw notFound(`solution artifact "${body.solutionArtifactId}" not found`);
      solutionArtifactId = solution.id;
    }

    const region = optString(body, 'region', { max: 80 }) ?? null;
    const note = optString(body, 'note', { max: 4000 }) ?? null;

    const feedback = await db.feedbackRequest.create({
      data: {
        tenantId: auth.tenantId,
        solutionArtifactId,
        twinVersionId: twinVersion.id,
        region,
        verdict: body.verdict,
        note,
        status: 'open',
      },
    });

    await audit(auth.tenantId, auth, 'feedback.created', 'feedback_request', feedback.id, {
      twinVersionId: twinVersion.id,
      verdict: body.verdict,
      region,
    });
    await emitEvent(auth.tenantId, 'feedback.created', 'feedback_request', feedback.id, {
      feedbackId: feedback.id,
      twinVersionId: twinVersion.id,
      verdict: body.verdict,
      region,
    });

    return Response.json(feedbackRequestView(feedback), { status: 201 });
  });
}
