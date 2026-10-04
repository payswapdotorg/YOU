// ═══════════════════════════════════════════════════════════════════════════
// Game/AR export view mappers (Worker C lane, P6.C9 — the tryon/views.ts
// precedent, export side). Route-side only: imports the storage signing seam,
// so this module is NOT part of the node:test pure surface (the contract
// tests exercise adapters/game-export.ts directly).
//
// CONTRACT LAW at the view layer: an artifact view is only assembled when
// the artifact's manifest claims statement is INTACT (claimsAreIntact). An
// export artifact without the verbatim honest-claims text is a contract
// violation — the mapper throws honestly instead of rendering a fabricated
// claims statement.
// ═══════════════════════════════════════════════════════════════════════════
import type { ExportJob, OutputArtifact } from '@prisma/client';
import { HttpError } from '../core/errors';
import { parseJson } from '../core/views';
import { signStorageUrl, STORAGE_DEFAULT_TTL_SECONDS } from '../core/storage';
import {
  EXPORT_CLAIMS,
  claimsAreIntact,
  exportHttpSpec,
  type ExportManifest,
  type ExportMappingTable,
  type ExportPackageManifest,
} from '../adapters/game-export';

/** Translate an ExportRefusal into the standard error-envelope HttpError. */
export function toExportHttpError(err: unknown): HttpError {
  const spec = exportHttpSpec(err);
  if (spec) {
    return new HttpError(spec.status, spec.code, spec.message, spec.details);
  }
  throw err;
}

// ─── Export job views ───────────────────────────────────────────────────────

export type ExportJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

function parseStatus(raw: string): ExportJobStatus {
  return raw === 'running' || raw === 'succeeded' || raw === 'failed' ? raw : 'queued';
}

export interface ExportJobSummaryView {
  id: string;
  twinId: string;
  twinDisplayName: string | null;
  twinVersionId: string;
  format: 'glb' | 'vrm';
  lodLevel: number;
  includeFacialControls: boolean;
  status: ExportJobStatus;
  /** The durable job id (steps/progress live there). */
  jobId: string | null;
  hasArtifact: boolean;
  /** The structural-vs-derived manifest when the artifact exists (else null). */
  manifest: ExportManifest | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The CONTRACT honest-claims text — Present on every view surface. */
  claims: string;
}

export interface ExportJobWithRefs {
  job: ExportJob;
  twinDisplayName: string | null;
  /** the primary artifact's parsed manifest when the export completed */
  manifest: ExportManifest | null;
}

export function exportJobSummaryView(input: ExportJobWithRefs): ExportJobSummaryView {
  const format = input.job.format === 'vrm' ? 'vrm' : 'glb';
  return {
    id: input.job.id,
    twinId: input.job.twinId,
    twinDisplayName: input.twinDisplayName,
    twinVersionId: input.job.twinVersionId,
    format,
    lodLevel: input.job.lodLevel,
    includeFacialControls: input.job.includeFacialControls,
    status: parseStatus(input.job.status),
    jobId: input.job.jobId ?? null,
    hasArtifact: input.job.artifactId !== null,
    manifest: input.manifest,
    error: input.job.error,
    createdAt: input.job.createdAt.toISOString(),
    finishedAt: input.job.finishedAt ? input.job.finishedAt.toISOString() : null,
    claims: EXPORT_CLAIMS,
  };
}

// ─── The export artifact view (model + mapping + manifest, signed URLs) ─────

interface ArtifactMeta {
  adapterId?: unknown;
  /** the CONTRACT honest-claims statement, verbatim */
  visualClaims?: unknown;
  manifest?: unknown;
  mappingTable?: unknown;
  packageManifest?: unknown;
}

export interface ExportArtifactView {
  artifactId: string;
  kind: string;
  /** Signed, expiring URL for the content-addressed GLB/VRM binary. */
  modelUrl: string;
  modelExpiresAt: number;
  bytes: number;
  mime: string;
  format: 'glb' | 'vrm';
  lodLevel: number;
  manifest: ExportManifest;
  mappingTable: ExportMappingTable;
  /** The honest Unity/Unreal package surface (files + README). */
  packageManifest: ExportPackageManifest;
  companions: Array<{ role: string; artifactId: string; url: string; expiresAt: number; bytes: number; mime: string }>;
  claims: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Assemble the export artifact view from the primary artifact's meta.
 * CONTRACT ENFORCED: throws (500 internal_error via the route wrapper) when
 * the artifact's honest-claims statement is missing or altered — the view
 * never fabricates one.
 */
export function exportArtifactView(
  artifact: OutputArtifact,
  opts: {
    format: 'glb' | 'vrm';
    lodLevel: number;
    /** companion artifacts loaded by the route (mapping + manifest), keyed by role. */
    companions: Array<{ role: 'retargeting-mapping' | 'export-manifest'; artifact: OutputArtifact }>;
  },
): ExportArtifactView {
  const meta = parseJson<ArtifactMeta>(artifact.meta, {});
  if (!claimsAreIntact(meta.visualClaims)) {
    throw new HttpError(
      500,
      'internal_error',
      `export artifact ${artifact.id} is missing the verbatim honest-claims statement — contract violation (refusing to render a fabricated claims text)`,
    );
  }
  if (!meta.manifest || !meta.mappingTable || !meta.packageManifest) {
    throw new HttpError(
      500,
      'internal_error',
      `export artifact ${artifact.id} is missing its manifest/mapping/package surfaces — contract violation (an export artifact is only valid as the full honest bundle)`,
    );
  }
  const companionViews = opts.companions.map((c) => ({
    role: c.role,
    artifactId: c.artifact.id,
    url: signStorageUrl(c.artifact.storageKey, STORAGE_DEFAULT_TTL_SECONDS),
    expiresAt: Math.floor(Date.now() / 1000) + STORAGE_DEFAULT_TTL_SECONDS,
    bytes: num(c.artifact.bytes),
    mime: str(c.artifact.mime) || 'application/json',
  }));
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    modelUrl: signStorageUrl(artifact.storageKey, 3600),
    modelExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    bytes: num(artifact.bytes),
    mime: str(artifact.mime) || 'model/gltf-binary',
    format: opts.format,
    lodLevel: opts.lodLevel,
    manifest: meta.manifest as ExportManifest,
    mappingTable: meta.mappingTable as ExportMappingTable,
    packageManifest: meta.packageManifest as ExportPackageManifest,
    companions: companionViews,
    claims: EXPORT_CLAIMS,
  };
}
