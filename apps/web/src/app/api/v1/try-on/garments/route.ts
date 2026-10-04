// POST /api/v1/try-on/garments — garment/product asset upload (P6.C8).
//
// The garment image follows the SAME validation laws as evidence uploads:
// multipart/form-data with a "file" field, mime ∈ png/jpeg/webp, non-empty
// ≤10MB, per-tenant upload rate limit; bytes are content-addressed through
// the object-store seam (immutable key garment/<sha256>.<ext>) and the
// merchant provenance (productRef + productUrl) is recorded on the row.
//
// No subject-consent gate HERE: a garment is PRODUCT data (no human subject
// biometrics); the consent gate is at try-on CREATE (rendering the twin
// requires the render scope — /api/v1/try-on POST).
//
// GET /api/v1/try-on/garments — list garment assets (newest first, bounded)
// with signed expiring image URLs.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { badRequest, handleRoute } from '@/lib/you/core/errors';
import { audit, emitEvent, recordUsage } from '@/lib/you/core/events';
import { putObject } from '@/lib/you/core/storage';
import { enforceRateLimit } from '@/lib/you/core/ratelimit';
import { validateGarmentUpload } from '@/lib/you/adapters/try-on';
import { garmentAssetView, toTryOnHttpError } from '@/lib/you/tryon/views';

const LIST_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const garments = await db.garmentAsset.findMany({
      where: { tenantId: auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return Response.json(garments.map((g) => garmentAssetView(g)));
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);

    enforceRateLimit('asset-upload', auth.tenantId); // the shared per-tenant upload ceiling

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
      throw badRequest('upload must be multipart/form-data with a "file" field');
    }
    const form = await request.formData().catch(() => {
      throw badRequest('malformed multipart/form-data body');
    });

    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('multipart field "file" is required');

    // validation laws (MIME/size/displayName/productRef/productUrl) — the
    // shared validateGarmentUpload throws typed TryOnRefusal('validation_failed')
    let validated;
    try {
      validated = validateGarmentUpload({
        mime: file.type,
        bytes: file.size,
        displayName: String(form.get('displayName') ?? ''),
        productRef: form.get('productRef') !== null ? String(form.get('productRef')) : undefined,
        productUrl: form.get('productUrl') !== null ? String(form.get('productUrl')) : undefined,
      });
    } catch (err) {
      throw toTryOnHttpError(err);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const stored = await putObject(buf, { kind: 'garment', mime: validated.mime });

    const garment = await db.garmentAsset.create({
      data: {
        tenantId: auth.tenantId,
        displayName: validated.displayName,
        productRef: validated.productRef,
        productUrl: validated.productUrl,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        bytes: stored.bytes,
        mime: validated.mime,
      },
    });

    await audit(auth.tenantId, auth, 'garment.uploaded', 'garment_asset', garment.id, {
      contentHash: stored.contentHash,
      bytes: stored.bytes,
      mime: validated.mime,
      productRef: validated.productRef,
      productUrl: validated.productUrl,
    });
    await emitEvent(auth.tenantId, 'garment.uploaded', 'garment_asset', garment.id, {
      garmentAssetId: garment.id,
      contentHash: stored.contentHash,
      bytes: stored.bytes,
      productRef: garment.productRef,
    });
    await recordUsage(auth.tenantId, 'garment.bytes', stored.bytes, { garmentAssetId: garment.id });

    return Response.json(garmentAssetView(garment), { status: 201 });
  });
}
