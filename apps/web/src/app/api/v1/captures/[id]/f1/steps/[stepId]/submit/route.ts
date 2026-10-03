// POST /api/v1/captures/:id/f1/steps/:stepId/submit — submit one guided-step
// evidence file (P6.B3). The ADVANCE consent gate is SERVER-ENFORCED here:
// the F1-statement-covered capture grant is re-verified before any byte is
// accepted (403 consent_required with machine-readable details on refusal).
//
// Flow: validate step + mime → store bytes content-addressed (putObject) →
// create the EvidenceAsset row → run the per-step heuristic quality/liveness
// checkpoint over the actual bytes (f1LivenessCheckpoint taxonomy + size
// bounds + declared-region coverage) → persist the report ON the step.
// A PASSING checkpoint marks the step done and advances the current pointer;
// a FAILING checkpoint leaves the step current with the refusal persisted
// and answered as an honest 400 carrying the checkpoint verbatim (the asset
// row stays — failed evidence is disclosed in the manifest, never dropped).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { parseF1Protocol, requireF1CaptureConsent, assessF1StepCheckpoint, F1_STEP_MIMES } from '@/lib/you/core/f1-flow';
import { badRequest, conflict, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent, recordUsage } from '@/lib/you/core/events';
import { putObject } from '@/lib/you/core/storage';
import { enforceRateLimit } from '@/lib/you/core/ratelimit';
import { captureSessionView } from '@/lib/you/core/views';
import type { F1GuidedStep, F1ProtocolState } from '@/lib/you/contracts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id, stepId } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);
    if (session.status === 'complete' || session.status === 'failed') {
      throw conflict(`capture session "${id}" is already ${session.status}`);
    }

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session (no persisted protocol) — use the legacy asset upload`);
    }
    const step = protocol.steps.find((s) => s.id === stepId);
    if (!step) throw notFound(`protocol step "${stepId}" not found on session "${id}"`);
    if (step.state === 'done' || step.state === 'skipped') {
      throw conflict(`step "${stepId}" is already ${step.state}${step.state === 'skipped' ? ` (${step.skipReason ?? 'no reason recorded'})` : ''}`);
    }

    // ── ADVANCE GATE: server-enforced, re-verified on EVERY submit ──────────
    const { grant, statements } = await requireF1CaptureConsent(auth.tenantId, session.twin.subjectId);

    enforceRateLimit('asset-upload', auth.tenantId);

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      throw badRequest('submit must be multipart/form-data with a "file" field');
    }
    const form = await request.formData().catch(() => {
      throw badRequest('malformed multipart/form-data body');
    });
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('multipart field "file" is required');

    const mime = file.type.toLowerCase();
    const allowed = F1_STEP_MIMES[stepId] ?? [];
    if (!allowed.includes(mime)) {
      throw badRequest(`step "${stepId}" accepts ${allowed.join(', ')} — received "${mime || '(none)'}"`);
    }
    if (file.size <= 0) throw badRequest('file is empty');

    const buf = Buffer.from(await file.arrayBuffer());

    // content-addressed storage (sha256 key) — identical to the legacy seam
    const stored = await putObject(buf, { kind: 'evidence', mime });
    const family = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';

    const asset = await db.evidenceAsset.create({
      data: {
        tenantId: auth.tenantId,
        captureSessionId: session.id,
        kind: family,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        bytes: stored.bytes,
        mime,
        regions: JSON.stringify(step.regions),
      },
    });

    // ── per-step quality + liveness checkpoint over the ACTUAL bytes ────────
    const checkpoint = assessF1StepCheckpoint(
      step,
      { id: asset.id, kind: family, mime, declaredBytes: stored.bytes, regions: step.regions },
      buf,
    );

    // the checkpoint is persisted PER ASSET (EvidenceAsset.quality — the same
    // column the legacy VLM analysis uses) so a failed submission's report is
    // never overwritten by a later retry, AND on the protocol step (the
    // CURRENT evidence's report drives the guided UX).
    await db.evidenceAsset.update({
      where: { id: asset.id },
      data: { quality: JSON.stringify(checkpoint) },
    });

    // advance: a PASSING checkpoint marks the step done and moves the current
    // pointer to the next pending step; a FAILING one keeps the step current
    const updatedSteps: F1GuidedStep[] = protocol.steps.map((s) =>
      s.id === stepId
        ? {
            ...s,
            state: checkpoint.passed ? ('done' as const) : ('current' as const),
            assetId: asset.id,
            contentHash: stored.contentHash,
            checkpoint,
            submittedAt: new Date().toISOString(),
          }
        : s,
    );
    let currentStepId = protocol.currentStepId;
    if (checkpoint.passed) {
      const nextPending = updatedSteps.find((s) => s.state === 'pending');
      currentStepId = nextPending?.id ?? null;
      if (nextPending) {
        const idx = updatedSteps.findIndex((s) => s.id === nextPending.id);
        updatedSteps[idx] = { ...updatedSteps[idx], state: 'current' };
      }
    } else {
      currentStepId = stepId;
    }
    const updatedProtocol: F1ProtocolState = { ...protocol, steps: updatedSteps, currentStepId };

    await db.captureSession.update({
      where: { id: session.id },
      data: {
        protocol: JSON.stringify(updatedProtocol),
        consentGrantId: grant.id,
        ...(session.status === 'pending' ? { status: 'uploading' } : {}),
      },
    });

    await audit(auth.tenantId, auth, 'capture.f1_step_submitted', 'capture_session', session.id, {
      stepId,
      assetId: asset.id,
      contentHash: stored.contentHash,
      bytes: stored.bytes,
      mime,
      checkpointPassed: checkpoint.passed,
      checkpointScore: checkpoint.score,
      refusal: checkpoint.refusal ?? null,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'capture.f1_step_submitted', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      stepId,
      assetId: asset.id,
      contentHash: stored.contentHash,
      checkpointPassed: checkpoint.passed,
    });
    await recordUsage(auth.tenantId, 'evidence.bytes', stored.bytes, { assetId: asset.id, stepId });

    // honest answer for a failing checkpoint: the report verbatim
    if (!checkpoint.passed) {
      throw badRequest(
        `step "${stepId}" evidence failed the liveness/quality checkpoint — ${checkpoint.issues.join('; ')}`,
        { captureSessionId: session.id, stepId, assetId: asset.id, checkpoint },
      );
    }

    const refreshed = await db.captureSession.findUnique({
      where: { id: session.id },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json(
      {
        ...captureSessionView(refreshed ?? session, refreshed?.assets ?? []),
        submitted: { stepId, assetId: asset.id, contentHash: stored.contentHash, checkpoint },
        consent: { grantId: grant.id, trainingPermitted: statements.training.permitted },
      },
      { status: 201 },
    );
  });
}
