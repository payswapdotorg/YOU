// POST /api/v1/captures/:id/assets — multipart evidence upload.
// Validations: mime ∈ png/jpeg/webp, ≤10MB, ACTIVE ConsentGrant scope
// "capture" for the twin's subjectId (403 consent_required), sha256 hash,
// content-addressed putObject, checklist marks regions provided.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { markProvided } from '@/lib/you/core/checklist';
import { requireConsent } from '@/lib/you/core/consent';
import { badRequest, handleRoute, notFound, conflict } from '@/lib/you/core/errors';
import { audit, emitEvent, recordUsage } from '@/lib/you/core/events';
import { putObject } from '@/lib/you/core/storage';
import { evidenceAssetView, parseJson } from '@/lib/you/core/views';
import type { CaptureChecklistItem, CaptureRegion } from '@/lib/you/contracts';

const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_BYTES = 10 * 1024 * 1024;

const VALID_REGIONS: CaptureRegion[] = [
  'face.front', 'face.profile', 'face.hairline', 'teeth', 'hands',
  'hair.back', 'silhouette.front', 'silhouette.side', 'walking', 'speech', 'custom',
];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const session = await db.captureSession.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: { twin: true },
    });
    if (!session) throw notFound(`capture session "${id}" not found`);
    if (session.status === 'complete' || session.status === 'failed') {
      throw conflict(`capture session "${id}" is already ${session.status}`);
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      throw badRequest('upload must be multipart/form-data with a "file" field');
    }
    const form = await request.formData().catch(() => {
      throw badRequest('malformed multipart/form-data body');
    });

    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('multipart field "file" is required');

    const mime = file.type.toLowerCase();
    if (!(ALLOWED_MIMES as readonly string[]).includes(mime)) {
      throw badRequest(`unsupported mime "${mime}" — allowed: ${ALLOWED_MIMES.join(', ')}`);
    }
    if (file.size <= 0) throw badRequest('file is empty');
    if (file.size > MAX_BYTES) throw badRequest(`file exceeds the 10MB limit (${file.size} bytes)`);

    let regions: CaptureRegion[] = [];
    const rawRegions = form.get('regions');
    if (rawRegions !== null && rawRegions !== undefined && String(rawRegions).trim() !== '') {
      try {
        const parsed = JSON.parse(String(rawRegions));
        if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== 'string' || !(VALID_REGIONS as string[]).includes(r))) {
          throw new Error('bad shape');
        }
        regions = parsed as CaptureRegion[];
      } catch {
        throw badRequest(`regions must be a JSON array of capture regions (one of ${VALID_REGIONS.join(', ')})`);
      }
    }

    // server-enforced consent BEFORE any bytes are accepted
    const grant = await requireConsent(auth.tenantId, session.twin.subjectId, 'capture');

    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putObject(buf, { kind: 'evidence', mime });

    const asset = await db.evidenceAsset.create({
      data: {
        tenantId: auth.tenantId,
        captureSessionId: session.id,
        kind: 'image',
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        bytes: stored.bytes,
        mime,
        regions: JSON.stringify(regions),
      },
    });

    // checklist: mark covered regions provided
    const checklist = parseJson<CaptureChecklistItem[]>(session.checklist, []);
    if (regions.length > 0) {
      await db.captureSession.update({
        where: { id: session.id },
        data: {
          checklist: JSON.stringify(markProvided(checklist, regions)),
          ...(session.status === 'pending' ? { status: 'uploading' } : {}),
        },
      });
    } else if (session.status === 'pending') {
      await db.captureSession.update({ where: { id: session.id }, data: { status: 'uploading' } });
    }

    await audit(auth.tenantId, auth, 'evidence.uploaded', 'evidence_asset', asset.id, {
      captureSessionId: session.id,
      twinId: session.twinId,
      contentHash: stored.contentHash,
      bytes: stored.bytes,
      mime,
      regions,
      consentGrantId: grant.id,
    });
    await emitEvent(auth.tenantId, 'evidence.uploaded', 'evidence_asset', asset.id, {
      assetId: asset.id,
      captureSessionId: session.id,
      twinId: session.twinId,
      contentHash: stored.contentHash,
      bytes: stored.bytes,
      regions,
    });
    await recordUsage(auth.tenantId, 'evidence.bytes', stored.bytes, { assetId: asset.id });

    return Response.json(evidenceAssetView(asset), { status: 201 });
  });
}
