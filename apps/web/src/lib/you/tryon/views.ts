// ═══════════════════════════════════════════════════════════════════════════
// Try-on view mappers (Worker C lane, P6.C8 — the live/runtime.ts view
// precedent, try-on side). Route-side only: imports the storage signing seam,
// so this module is NOT part of the node:test pure surface (the contract
// tests exercise adapters/try-on.ts directly).
//
// CONTRACT LAW at the view layer: a comparison view is only assembled when
// the artifact's visualOnlyDisclaimer is INTACT (disclaimerIsIntact). An
// artifact without the verbatim disclaimer is a contract violation — the
// mapper throws honestly instead of rendering a fabricated disclaimer.
// ═══════════════════════════════════════════════════════════════════════════
import type { GarmentAsset, OutputArtifact, TryOnJob } from '@prisma/client';
import { HttpError } from '../core/errors';
import { parseJson } from '../core/views';
import { signStorageUrl, STORAGE_DEFAULT_TTL_SECONDS } from '../core/storage';
import {
  VISUAL_ONLY_DISCLAIMER,
  disclaimerIsIntact,
  tryOnHttpSpec,
  type TryOnDiffManifest,
  type TryOnIdentityReport,
} from '../adapters/try-on';

/** Translate a TryOnRefusal into the standard error-envelope HttpError. */
export function toTryOnHttpError(err: unknown): HttpError {
  const spec = tryOnHttpSpec(err);
  if (spec) {
    return new HttpError(spec.status, spec.code, spec.message, spec.details);
  }
  throw err;
}

// ─── Garment views ───────────────────────────────────────────────────────────

export interface GarmentAssetView {
  id: string;
  displayName: string;
  productRef: string | null;
  productUrl: string | null;
  contentHash: string;
  bytes: number;
  mime: string;
  /** Signed, expiring URL for the content-addressed garment image. */
  imageUrl: string;
  imageExpiresAt: number; // epoch seconds
  createdAt: string;
}

export function garmentAssetView(g: GarmentAsset): GarmentAssetView {
  return {
    id: g.id,
    displayName: g.displayName,
    productRef: g.productRef,
    productUrl: g.productUrl,
    contentHash: g.contentHash,
    bytes: g.bytes,
    mime: g.mime,
    imageUrl: signStorageUrl(g.storageKey, STORAGE_DEFAULT_TTL_SECONDS),
    imageExpiresAt: Math.floor(Date.now() / 1000) + STORAGE_DEFAULT_TTL_SECONDS,
    createdAt: g.createdAt.toISOString(),
  };
}

// ─── Try-on job views ────────────────────────────────────────────────────────

export type TryOnJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

function parseStatus(raw: string): TryOnJobStatus {
  return raw === 'running' || raw === 'succeeded' || raw === 'failed' ? raw : 'queued';
}

export interface TryOnJobSummaryView {
  id: string;
  twinId: string;
  twinDisplayName: string | null;
  twinVersionId: string;
  garmentAssetId: string;
  garmentDisplayName: string | null;
  productRef: string | null;
  style: string;
  status: TryOnJobStatus;
  /** The durable job id (steps/progress live there). */
  jobId: string | null;
  hasComparison: boolean;
  /** null until a comparison artifact exists; then the report's verdict. */
  identityChecksPassed: boolean | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The CONTRACT disclaimer — present on every view surface, list included. */
  visualOnlyDisclaimer: string;
}

export interface TryOnJobWithRefs {
  job: TryOnJob;
  twinDisplayName: string | null;
  garmentDisplayName: string | null;
  productRef: string | null;
  /** parsed from the artifact meta when a completed artifact exists */
  identityChecksPassed: boolean | null;
}

export function tryOnJobSummaryView(input: TryOnJobWithRefs): TryOnJobSummaryView {
  return {
    id: input.job.id,
    twinId: input.job.twinId,
    twinDisplayName: input.twinDisplayName,
    twinVersionId: input.job.twinVersionId,
    garmentAssetId: input.job.garmentAssetId,
    garmentDisplayName: input.garmentDisplayName,
    productRef: input.productRef,
    style: input.job.style,
    status: parseStatus(input.job.status),
    jobId: input.job.jobId ?? null,
    hasComparison: input.job.artifactId !== null,
    identityChecksPassed: input.identityChecksPassed,
    error: input.job.error,
    createdAt: input.job.createdAt.toISOString(),
    finishedAt: input.job.finishedAt ? input.job.finishedAt.toISOString() : null,
    visualOnlyDisclaimer: VISUAL_ONLY_DISCLAIMER,
  };
}

// ─── The comparison view (side-by-side + manifest + identity report) ────────

interface ComparisonMeta {
  visualOnlyDisclaimer?: unknown;
  identityReport?: unknown;
  diffManifest?: unknown;
  provider?: unknown;
  comparison?: unknown;
}

export interface TryOnComparisonView {
  artifactId: string;
  sideBySide: {
    baseline: { url: string; contentHash: string; bytes: number; mime: string; label: string };
    tryOn: { url: string; contentHash: string; bytes: number; mime: string; label: string };
    garment: {
      url: string;
      contentHash: string;
      bytes: number;
      label: string;
      displayName: string;
      productRef: string | null;
      productUrl: string | null;
      assetId: string;
    };
  };
  diffManifest: TryOnDiffManifest;
  identityReport: TryOnIdentityReport;
  provider: { id: string; model: string | null; taskId: string | null; latencyMs: number; realLatency: boolean };
  visualOnlyDisclaimer: string;
}

/**
 * Assemble the comparison view from the artifact's meta. CONTRACT ENFORCED:
 * throws (500 internal_error via the route wrapper) when the artifact's
 * disclaimer is missing or altered — the view never fabricates one.
 */
export function tryOnComparisonView(artifact: OutputArtifact): TryOnComparisonView {
  const meta = parseJson<ComparisonMeta>(artifact.meta, {});
  if (!disclaimerIsIntact(meta.visualOnlyDisclaimer)) {
    throw new HttpError(
      500,
      'internal_error',
      `try-on comparison artifact ${artifact.id} is missing the verbatim visual-only disclaimer — contract violation (refusing to render a fabricated disclaimer)`,
    );
  }
  const c = (meta.comparison ?? {}) as Record<string, unknown>;
  const baseline = (c.baseline ?? {}) as Record<string, unknown>;
  const tryOn = (c.tryOn ?? {}) as Record<string, unknown>;
  const garment = (c.garment ?? {}) as Record<string, unknown>;
  const provider = (meta.provider ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const optStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    artifactId: artifact.id,
    sideBySide: {
      baseline: {
        url: signStorageUrl(str(baseline.storageKey) || artifact.storageKey, 3600),
        contentHash: str(baseline.contentHash),
        bytes: num(baseline.bytes),
        mime: str(baseline.mime) || artifact.mime,
        label: 'Twin baseline (no garment)',
      },
      tryOn: {
        url: signStorageUrl(artifact.storageKey, 3600),
        contentHash: artifact.contentHash,
        bytes: artifact.bytes,
        mime: artifact.mime,
        label: 'Virtual try-on output',
      },
      garment: {
        url: signStorageUrl(str(garment.storageKey), 3600),
        contentHash: str(garment.contentHash),
        bytes: num(garment.bytes),
        label: 'Garment product image (identity reference)',
        displayName: str(garment.displayName) || 'garment',
        productRef: optStr(garment.productRef),
        productUrl: optStr(garment.productUrl),
        assetId: str(garment.assetId),
      },
    },
    diffManifest: (meta.diffManifest ?? { changes: [], providerReportedNothing: true }) as TryOnDiffManifest,
    identityReport: (meta.identityReport ?? null) as TryOnIdentityReport,
    provider: {
      id: str(provider.id) || 'unknown',
      model: optStr(provider.model),
      taskId: optStr(provider.taskId),
      latencyMs: num(provider.latencyMs),
      realLatency: provider.realLatency === true,
    },
    visualOnlyDisclaimer: VISUAL_ONLY_DISCLAIMER,
  };
}
