// GET /api/v1/twins/:id/deficiencies — the honest quality-deficiency report
// for a twin (P6.B4): per-capability aggregation over the twin's REAL
// persisted state (capture sessions with protocol/checkpoints/assets + a
// TwinVersion's reconstruction confidence summary).
//
//   ?versionId=<id>            — report for that specific TwinVersion
//                                 (default: the twin's latest version)
//   &baselineVersionId=<id>    — additionally returns the baseline report and
//                                 the per-capability deficiency delta
//                                 (improved / regressed / unchanged / unknown)
//
// Honesty laws (lib/you/core/deficiency.ts): unknown is unknown — never
// coerced into ok; deficient only with a citable source signal; a twin with
// no captures returns all-unknown rows + disclosures, never fake green.
import { db } from '@/lib/db';
import { requireApiAuth } from '@/lib/you/core/auth';
import { handleRoute, notFound } from '@/lib/you/core/errors';
import { parseJson } from '@/lib/you/core/views';
import type { TwinVersion } from '@prisma/client';
import {
  buildDeficiencyReport, diffDeficiencyReports,
  type DeficiencyCaptureInput, type DeficiencyCheckpointSummaryInput,
  type DeficiencyVersionInput,
} from '@/lib/you/core/deficiency';
import type {
  CaptureChecklistItem, CaptureRegion, EvidenceQuality, F1ProtocolState, HtirConfidence,
} from '@/lib/you/contracts';

function versionInput(v: {
  id: string; version: number; createdAt: Date; confidenceSummary: string | null;
}): DeficiencyVersionInput {
  return {
    id: v.id,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    confidenceSummary: parseJson<HtirConfidence | null>(v.confidenceSummary, null),
  };
}

function captureInputs(
  sessions: {
    id: string; twinId: string; status: string; createdAt: Date; completedAt: Date | null;
    error: string | null; checklist: string; protocol: string | null; checkpoints: string | null;
    assets: {
      id: string; captureSessionId: string; regions: string; quality: string | null;
    }[];
  }[],
): DeficiencyCaptureInput[] {
  return sessions.map((c) => ({
    id: c.id,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    error: c.error,
    protocol: parseJson<F1ProtocolState | null>(c.protocol, null),
    checkpoints: parseJson<DeficiencyCheckpointSummaryInput | null>(c.checkpoints, null),
    checklist: parseJson<CaptureChecklistItem[]>(c.checklist, []),
    assets: c.assets.map((a) => ({
      id: a.id,
      regions: parseJson<CaptureRegion[]>(a.regions, []),
      quality: parseJson<EvidenceQuality | null>(a.quality, null),
    })),
  }));
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(async () => {
    const auth = await requireApiAuth(request);
    const { id } = await params;

    const twin = await db.twin.findFirst({
      where: { id, tenantId: auth.tenantId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        captureSessions: {
          orderBy: { createdAt: 'desc' },
          include: { assets: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!twin) throw notFound(`twin "${id}" not found`);

    const url = new URL(request.url);
    const versionId = url.searchParams.get('versionId');
    const baselineVersionId = url.searchParams.get('baselineVersionId');

    // version selection (tenant scoping is inherent: the twin was fetched
    // tenant-scoped and versions belong to it)
    let versionRow: TwinVersion | null = twin.versions[0] ?? null; // highest version number = latest
    if (versionId) {
      versionRow = twin.versions.find((v) => v.id === versionId) ?? null;
      if (!versionRow) throw notFound(`twin version "${versionId}" not found for twin "${id}"`);
    }

    const captures = captureInputs(twin.captureSessions);
    const report = buildDeficiencyReport({
      twinId: twin.id,
      version: versionRow ? versionInput(versionRow) : null,
      captures,
    });

    if (!baselineVersionId) {
      return Response.json({ report });
    }

    const baselineRow = twin.versions.find((v) => v.id === baselineVersionId) ?? null;
    if (!baselineRow) throw notFound(`baseline twin version "${baselineVersionId}" not found for twin "${id}"`);
    const baselineReport = buildDeficiencyReport({
      twinId: twin.id,
      version: versionInput(baselineRow),
      captures,
    });
    const delta = diffDeficiencyReports(baselineReport, report);

    return Response.json({ report, baselineReport, delta });
  });
}
