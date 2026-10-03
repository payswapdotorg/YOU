// DELETE /api/v1/captures/:id/f1 — the deletion path of the F1 flow (P6.B3),
// honoring the consent retention policy recorded on the capture.
//
// Deletion is ALLOWED when the consent statements permit it now:
//   - the consent did not grant retention (mayBeRetained: false); or
//   - the covering grant is revoked (withdrawal) or expired; or
//   - the stated retainUntil window has elapsed.
// Otherwise an honest 409 policy_blocked envelope carries the policy and the
// window — the subject withdraws by revoking the grant (DELETE
// /api/v1/consent-grants/:id), which is the documented withdrawal process.
//
// What is deleted: the session row, its EvidenceAsset rows, and every
// content-addressed object that no OTHER row still references (shared bytes
// are retained and the response says so). What is NOT deleted: historical
// TwinVersions (immutable by law — their provenance keeps the content hashes
// as the honest record of what existed) and the immutable audit/event trail.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { f1DeletionDecision, grantF1Statements, parseF1Protocol } from '@/lib/you/core/f1-flow';
import { badRequest, conflict, handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { deleteObject } from '@/lib/you/core/storage';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true, assets: true },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);

    const protocol = parseF1Protocol(session);
    if (!protocol) {
      throw badRequest(`capture session "${id}" is not a guided F1 session — the retention-honoring deletion path applies to guided F1 captures`);
    }

    // ── retention decision from the consent statements ─────────────────────
    const grant = session.consentGrantId
      ? await db.consentGrant.findFirst({ where: { id: session.consentGrantId, tenantId: auth.tenantId } })
      : null;
    const statements = grant ? grantF1Statements(grant) : null;
    const retention = statements?.retention ?? parseRetentionPolicy(session.retention);
    const decision = f1DeletionDecision(
      retention,
      grant ? { revokedAt: grant.revokedAt, expiresAt: grant.expiresAt } : null,
    );
    if (!decision.allowed) {
      throw conflict(
        `deletion refused: ${decision.reason}`,
        {
          captureSessionId: session.id,
          policy: decision.policy,
          ...(decision.retainUntil ? { retainUntil: decision.retainUntil } : {}),
          consentGrantId: session.consentGrantId,
          withdrawal:
            'the subject withdraws by revoking the covering consent grant (DELETE /api/v1/consent-grants/:id) — deletion then proceeds immediately',
        },
      );
    }

    // ── what remains: historical TwinVersions are immutable ────────────────
    const sessionAssetIds = new Set(session.assets.map((a) => a.id));
    const versions = await db.twinVersion.findMany({
      where: { twinId: session.twinId },
      orderBy: { version: 'desc' },
    });
    const linkedVersions = versions.filter((v) =>
      parseJsonAssetIds(v).some((aid: string) => sessionAssetIds.has(aid)),
    );

    // ── delete assets + unreferenced content-addressed objects ─────────────
    // Content addressing means one object may back SEVERAL asset rows (e.g.
    // the same photo submitted for two steps). The rows go first, then each
    // UNIQUE storage key is checked against what still references it (other
    // sessions' assets, output artifacts) — shared bytes are retained and
    // disclosed, never over-deleted.
    const uniqueKeys = [...new Set(session.assets.map((a) => a.storageKey))];
    await db.evidenceAsset.deleteMany({ where: { captureSessionId: session.id } });
    let objectsDeleted = 0;
    let objectsRetained = 0;
    const retainedKeys: string[] = [];
    for (const key of uniqueKeys) {
      const otherAssetRefs = await db.evidenceAsset.count({ where: { storageKey: key } });
      const artifactRefs = await db.outputArtifact.count({ where: { storageKey: key } });
      if (otherAssetRefs === 0 && artifactRefs === 0) {
        await deleteObject(key).catch(() => undefined);
        objectsDeleted += 1;
      } else {
        objectsRetained += 1;
        retainedKeys.push(key);
      }
    }

    await db.captureSession.delete({ where: { id: session.id } });

    await audit(auth.tenantId, auth, 'capture.f1_deleted', 'capture_session', session.id, {
      twinId: session.twinId,
      assetsDeleted: session.assets.length,
      objectsDeleted,
      objectsRetained,
      retainedKeys,
      twinVersionsRemain: linkedVersions.map((v) => ({ id: v.id, version: v.version })),
      withdrewConsent: !!grant?.revokedAt,
      reason: retention && !retention.mayBeRetained
        ? 'consent did not grant retention'
        : grant?.revokedAt
          ? 'consent withdrawn (grant revoked)'
          : 'retention window elapsed / grant gone or expired',
    });
    await emitEvent(auth.tenantId, 'capture.f1_deleted', 'capture_session', session.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      assetsDeleted: session.assets.length,
      objectsDeleted,
      objectsRetained,
    });

    return Response.json({
      deleted: true,
      captureSessionId: session.id,
      assetsDeleted: session.assets.length,
      objectsDeleted,
      objectsRetained,
      retainedKeys,
      twinVersionsRemain: linkedVersions.map((v) => ({ id: v.id, version: v.version })),
      disclosure:
        'historical TwinVersions are immutable and were NOT deleted — their provenance retains the content hashes of the deleted evidence as the honest record of what existed. The audit/event trail is likewise retained (compliance).',
    });
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseJsonAssetIds(v: { evidenceAssetIds: string }): string[] {
  try {
    const parsed = JSON.parse(v.evidenceAssetIds);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Fallback retention view from the session's snapshotted policy (grant gone). */
function parseRetentionPolicy(retention: string | null): {
  mayBeRetained: boolean;
  retainUntil?: string;
  policy: string;
} | null {
  if (!retention) return null;
  try {
    const parsed = JSON.parse(retention);
    if (parsed && typeof parsed === 'object' && typeof parsed.mayBeRetained === 'boolean') {
      return parsed as { mayBeRetained: boolean; retainUntil?: string; policy: string };
    }
    return null;
  } catch {
    return null;
  }
}
