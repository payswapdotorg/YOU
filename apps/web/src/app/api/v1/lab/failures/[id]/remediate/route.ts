// POST /api/v1/lab/failures/:id/remediate — P6.C11 remediation lifecycle:
// open --mitigate--> mitigated --verify--> verified (terminal). Every action
// is evidence-driven (evidence REQUIRED) and appends an audit entry
// (who / when / evidence) to remediationLog. Invalid transitions are honest
// 409s; unknown cases are 404s. Enforcement order exactly as the
// decideRemediate fold: 401 → 403 (write scope) → 404 → 400 → 409 → proceed.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, jsonError, readJsonBody } from '@/lib/you/core/errors';
import { emitEvent } from '@/lib/you/core/events';
import { applyRemediationTransition, decideRemediate, type RemediationLogEntry } from '@/lib/you/lab/failure-codes';
import { failureCaseView, parseJson } from '@/lib/you/core/views';
import { ERR } from '@/lib/you/contracts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;
    const body = await readJsonBody(request);

    const failure = await db.failureCase.findUnique({ where: { id } });
    const decision = decideRemediate({
      auth: {
        tenantId: auth.tenantId,
        actorType: auth.actorType,
        actorId: auth.actorId,
        scopes: auth.scopes,
      },
      failureId: id,
      failure: failure
        ? {
            id: failure.id,
            status: failure.status ?? 'open',
            remediationLog: parseJson<RemediationLogEntry[]>(failure.remediationLog ?? '[]', []),
          }
        : null,
      body,
      now: new Date().toISOString(),
    });

    if (decision.kind === 'error') {
      return jsonError(decision.code, decision.message, decision.status);
    }

    const transition = applyRemediationTransition({
      currentStatus: failure!.status ?? 'open',
      log: parseJson<RemediationLogEntry[]>(failure!.remediationLog ?? '[]', []),
      action: decision.action,
      evidence: decision.evidence,
      actor: {
        actorType: auth.actorType,
        actorId: auth.actorId,
        tenantId: auth.tenantId,
      },
      ...(decision.note !== undefined ? { note: decision.note } : {}),
      now: new Date().toISOString(),
    });

    if (!transition.ok) {
      return jsonError(transition.code, transition.message, transition.status);
    }

    const updated = await db.failureCase.update({
      where: { id: failure!.id },
      data: {
        status: transition.status,
        remediationLog: JSON.stringify(transition.log),
      },
    });

    await emitEvent(auth.tenantId, 'lab.failure.remediated', 'failure_case', updated.id, {
      failureCaseId: updated.id,
      code: updated.code,
      action: decision.action,
      from: failure!.status ?? 'open',
      to: transition.status,
      evidence: decision.evidence,
      actorType: auth.actorType,
      actorId: auth.actorId,
    });

    return Response.json(failureCaseView(updated));
  });
}
