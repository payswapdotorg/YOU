// DELETE /api/v1/consent-grants/:id — revoke (set revokedAt; NEVER delete rows)
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { audit, emitEvent } from '@/lib/you/core/events';
import { consentGrantView } from '@/lib/you/core/views';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const grant = await db.consentGrant.findFirst({ where: { id, tenantId: auth.tenantId } });
    if (!grant) throw notFound(`consent grant "${id}" not found`);

    if (!grant.revokedAt) {
      const revokedAt = new Date();
      await db.consentGrant.update({ where: { id: grant.id }, data: { revokedAt } });

      await audit(auth.tenantId, auth, 'consent.revoked', 'consent_grant', grant.id, {
        subjectId: grant.subjectId,
        revokedAt: revokedAt.toISOString(),
      });
      await emitEvent(auth.tenantId, 'consent.revoked', 'consent_grant', grant.id, {
        grantId: grant.id,
        subjectId: grant.subjectId,
        revokedAt: revokedAt.toISOString(),
      });
    }
    // idempotent: revoking an already-revoked grant is a no-op success

    const fresh = await db.consentGrant.findUniqueOrThrow({ where: { id: grant.id } });
    return Response.json(consentGrantView(fresh));
  });
}
