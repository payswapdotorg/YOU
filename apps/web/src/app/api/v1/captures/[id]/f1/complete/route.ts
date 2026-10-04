// POST /api/v1/captures/:id/f1/complete — complete a guided F1 capture
// session (P6.B3). Deterministic, synchronous, NO provider calls: this leg
// builds the CONTENT-ADDRESSED EVIDENCE MANIFEST (every asset's stored bytes
// re-hashed with sha256 and compared against the recorded contentHash —
// `verified` is the honest comparison result), aggregates the overall
// liveness/quality checkpoint summary from the persisted per-step reports,
// and snapshots the effective deletion policy. The consent gate is
// re-enforced (advance-class server check) before anything is written.
//
// Honest completion law: every REQUIRED step (1–7) must be terminal (done or
// skipped-with-reason) — pending required steps are refused with the exact
// list; the optional step 8 may remain pending (it is optional by the F1
// protocol). Skipped REQUIRED steps do NOT block completion — they are
// disclosed in the checkpoint summary, the manifest, the review chain and
// the export (never silently waived).
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import {
  buildF1Manifest, parseF1Protocol, parseF1Review, requireF1CaptureConsent,
} from '@/lib/you/core/f1-flow';
import { badRequest, conflict, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent, recordUsage } from '@/lib/you/core/events';
import { captureSessionView, parseJson } from '@/lib/you/core/views';
import type { CaptureRegion } from '@/lib/you/contracts';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, assets: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);
    if (session.status === 'complete' || session.status === 'failed') {
      throw conflict(`capture session "${id}" is already ${session.status}`);
    }

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session (no persisted protocol) — use POST /api/v1/captures/${id}/complete`);
    }

    // ── ADVANCE GATE (completion class): server-enforced ───────────────────
    const { grant, statements } = await requireF1CaptureConsent(auth.tenantId, session.twin.subjectId);

    // a required step must be TERMINAL (done or skipped-with-reason) — the
    // frontier 'current' state counts as not-yet-captured
    const pendingRequired = protocol.steps.filter(
      (s) => s.required && s.state !== 'done' && s.state !== 'skipped',
    );
    if (pendingRequired.length > 0) {
      throw badRequest(
        `cannot complete: required protocol steps are still pending — ${pendingRequired.map((s) => `${s.id} (${s.label})`).join(', ')}`,
        { captureSessionId: session.id, pendingRequired: pendingRequired.map((s) => s.id) },
      );
    }
    if (session.assets.length === 0) {
      throw badRequest(
        `cannot complete: no evidence assets were uploaded — refusing to build a manifest over nothing`,
        { captureSessionId: session.id, assets: 0 },
      );
    }

    // step that owns each asset (by submission order on the protocol)
    const stepByAsset = new Map<string, string>();
    for (const s of protocol.steps) {
      if (s.assetId) stepByAsset.set(s.assetId, s.id);
    }
    // per-ASSET checkpoint verdicts (persisted on EvidenceAsset.quality at
    // submit time — a failed submission's report is never overwritten by a
    // later retry of the same step)
    const checkpointByAsset = new Map<string, boolean | null>();
    for (const a of session.assets) {
      const cp = parseJson<{ passed?: boolean } | null>(a.quality, null);
      checkpointByAsset.set(a.id, cp && typeof cp.passed === 'boolean' ? cp.passed : null);
    }

    // ── content-addressed manifest: re-hash every stored asset ─────────────
    const manifest = await buildF1Manifest({
      captureSessionId: session.id,
      twinId: session.twinId,
      subjectId: session.twin.subjectId,
      consentGrantId: grant.id,
      statements,
      assets: session.assets.map((a) => ({
        id: a.id,
        stepId: stepByAsset.get(a.id) ?? null,
        storageKey: a.storageKey,
        contentHash: a.contentHash,
        bytes: a.bytes,
        mime: a.mime,
        regions: parseJson<CaptureRegion[]>(a.regions, []),
        checkpointPassed: checkpointByAsset.has(a.id) ? checkpointByAsset.get(a.id)! : null,
      })),
    });

    // ── overall checkpoint summary (per-asset reports are immutable) ──────
    const stepsWithCheckpoint = protocol.steps.filter((s) => s.checkpoint);
    const failedAssets = session.assets.filter((a) => checkpointByAsset.get(a.id) === false);
    const skipped = protocol.steps.filter((s) => s.state === 'skipped');
    const done = protocol.steps.filter((s) => s.state === 'done');
    const scores = done.map((s) => s.checkpoint?.score).filter((sc): sc is number => typeof sc === 'number');
    const summary = {
      version: 'f1-checkpoint-summary/v1',
      stepsChecked: stepsWithCheckpoint.length,
      stepsPassed: stepsWithCheckpoint.length - stepsWithCheckpoint.filter((s) => s.checkpoint?.passed === false).length,
      checkpointsFailed: failedAssets.map((a) => ({
        assetId: a.id,
        stepId: stepByAsset.get(a.id) ?? null,
        refusal: parseJson<{ refusal?: { code: string; message: string } } | null>(a.quality, null)?.refusal ?? null,
      })),
      stepsDone: done.length,
      stepsSkipped: skipped.map((s) => ({ stepId: s.id, reason: s.skipReason ?? '', required: s.required })),
      skippedRequired: skipped.filter((s) => s.required).map((s) => s.id),
      averageStepScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      manifestVerified: manifest.totals.verified === manifest.totals.assets,
      consentGrantId: grant.id,
      trainingPermitted: statements.training.permitted,
      summarizedAt: new Date().toISOString(),
    };

    const completedAt = new Date();
    const review = parseF1Review(session);
    await db.captureSession.update({
      where: { id: session.id },
      data: {
        status: 'complete',
        completedAt,
        consentGrantId: grant.id,
        manifest: JSON.stringify(manifest),
        checkpoints: JSON.stringify(summary),
        retention: JSON.stringify({
          ...statements.retention,
          deletionProcess: statements.deletion,
        }),
        review: JSON.stringify(review),
      },
    });

    await audit(auth.tenantId, auth, 'capture.f1_completed', 'capture_session', session.id, {
      twinId: session.twinId,
      assets: manifest.totals.assets,
      verified: manifest.totals.verified,
      skippedRequired: summary.skippedRequired,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'capture.f1_completed', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      assets: manifest.totals.assets,
      verified: manifest.totals.verified,
      bytes: manifest.totals.bytes,
    });
    await recordUsage(auth.tenantId, 'job.capture.f1_complete', 1, { captureSessionId: session.id });

    // ── P6.B5 CLOSED LOOP: evidence requests linked to this session flip
    // open → fulfilled HERE (the guided fulfillment completes with the
    // capture, not when it starts). Only 'open' requests transition — an
    // expired request keeps its honest expired status (the TTL window
    // passed); the session itself and the linkage stay intact either way.
    const linkedRequests = await db.evidenceRequest.findMany({
      where: { captureSessionId: session.id, tenantId: auth.tenantId, status: 'open' },
    });
    for (const linked of linkedRequests) {
      await db.evidenceRequest.update({
        where: { id: linked.id },
        data: { status: 'fulfilled', captureSessionId: session.id },
      });
      await emitEvent(auth.tenantId, 'evidence.request.fulfilled', 'evidence_request', linked.id, {
        requestId: linked.id,
        captureSessionId: session.id,
        twinId: session.twinId,
        capability: linked.capability,
        assets: manifest.totals.assets,
        verified: manifest.totals.verified,
      });
    }

    const refreshed = await db.captureSession.findUnique({
      where: { id: session.id },
      include: { assets: { orderBy: { createdAt: 'asc' } } },
    });
    return Response.json({
      ...captureSessionView(refreshed ?? session, refreshed?.assets ?? session.assets),
      summary,
      manifest,
    });
  });
}
