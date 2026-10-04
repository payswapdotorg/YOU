// ═══════════════════════════════════════════════════════════════════════════
// YOU core — Solution Artifact section slots (Worker B lane, P6.B6).
//
// PURE MODULE — no db, no '@/…' aliases, type-only imports from contracts:
// node:test imports it directly (same law as core/deficiency.ts and
// lab/f1-recon.ts; explicit .ts extensions for type-stripping imports).
//
// P5 (docs/PHASE_6_HANDOFF.md): EVERY major workflow can produce an artifact
// with sections — result, compare, evidence, improve, performance,
// provenance, consent, API/code, feedback, targeted evidence requests.
//
// HONESTY LAWS:
// - EVERY SECTION HAS A SLOT: a manifest v2 carries all 10 keys; each is
//   either filled with REAL references or explicitly null WITH a documented
//   reason. Nothing in between, nothing invented.
// - NULL MEANS ABSENT: a null slot is never coerced into a filled one
//   without a real, persisted signal behind it (feedback and evidence
//   requests accrue AFTER creation — they surface live at read time via
//   enrichSectionsLive, never by rewriting the stored manifest).
// - CAUSALITY IS REAL: the improve chain links requests → their fulfillment
//   capture sessions → versions whose evidenceAssetIds actually overlap
//   those sessions' assets. Timestamps alone never imply causation.
// - NUMBERS ARE QUOTED: metrics land in the result slot verbatim from the
//   job output; no rounding, no derivation.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  ArtifactManifestSections, ArtifactSectionKey, ArtifactSectionSlot,
  EvidenceRequestView, FeedbackRequestView, ManifestApiCodeSection,
  ManifestCompareSection, ManifestConsentSection, ManifestEvidenceRequestsSection,
  ManifestEvidenceSection, ManifestFeedbackSection, ManifestImproveSection,
  ManifestPerformanceSection, ManifestProvenanceSection, ManifestResultSection,
} from '../contracts';

// ─── Catalog ─────────────────────────────────────────────────────────────────

/** The 10 P5 sections in canonical surface order. */
export const ARTIFACT_SECTION_KEYS: readonly ArtifactSectionKey[] = [
  'result', 'compare', 'evidence', 'improve', 'performance',
  'provenance', 'consent', 'apiCode', 'feedback', 'evidenceRequests',
];

/** Placeholder token replaced by the real artifact id after row creation. */
export const ARTIFACT_ID_TOKEN = '__ARTIFACT_ID__';

// ─── Slot helpers ────────────────────────────────────────────────────────────

function filled<T>(data: T): ArtifactSectionSlot<T> {
  return { data };
}

function absent<T>(reason: string, fillHint?: string): ArtifactSectionSlot<T> {
  return { data: null, reason, ...(fillHint !== undefined ? { fillHint } : {}) };
}

/** Creation-time accrual note — shared by the three post-review sections. */
const ACCRUES_NOTE = 'accrues after creation: the stored manifest is an immutable snapshot — live objects surface at read time';

// ─── Shared creation context shapes (what the executors actually know) ───────

export interface TwinVersionRef { id: string; version: number }
export interface PerformanceRef { id: string; name: string }
export interface AdapterComponent { adapterId: string; version: string }

export interface TwinCompileSectionInput {
  twinId: string;
  twinVersion: TwinVersionRef;
  /** previous version of the same twin — null when this is the first compile */
  baselineTwinVersion: TwinVersionRef | null;
  captureSessionId: string | null;
  pipeline: { id: string; name: string } | null;
  /** verbatim from the reconstruction confidence summary (quoted, never derived) */
  confidence: { overall: number; deficiencies: number } | null;
  evidenceAssetIds: string[];
  adapterComponents: AdapterComponent[];
  provenanceKeys: string[];
  consent: { grantIds: string[]; scopes: string[]; subjectId: string };
  llmCalls: number | null;
}

export interface RenderSectionInput {
  renderJobId: string;
  twinVersion: TwinVersionRef;
  baselineTwinVersion: TwinVersionRef | null;
  /** the performance driving the render — null for a static render */
  performance: PerformanceRef | null;
  adapterComponents: AdapterComponent[];
  outputArtifact: { artifactId: string; label: string; kind: string } | null;
  latencyMs: number | null;
  costUsd: number | null;
  provenanceKeys: string[];
  consent: { grantIds: string[]; scopes: string[]; subjectId: string };
}

export interface PerformanceSectionInput {
  performance: PerformanceRef;
  origin: string;
  durationMs: number | null;
  trackCount: number;
  sentenceCount: number | null;
  llmEnhanced: boolean;
  twinId: string | null;
  provenanceKeys: string[];
}

// ─── Section builders (one per creation path) ────────────────────────────────

export function buildTwinCompileSections(input: TwinCompileSectionInput): ArtifactManifestSections {
  const { twinVersion, baselineTwinVersion } = input;
  const summary = input.confidence
    ? `Compiled v${twinVersion.version}${baselineTwinVersion ? ` (baseline v${baselineTwinVersion.version})` : ''} · overall confidence ${input.confidence.overall} · ${input.confidence.deficiencies} deficiencies`
    : `Compiled v${twinVersion.version}${baselineTwinVersion ? ` (baseline v${baselineTwinVersion.version})` : ''} · no confidence summary published`;

  return {
    result: filled<ManifestResultSection>({
      summary,
      refs: [
        { label: `TwinVersion v${twinVersion.version}`, kind: 'twinVersion', ref: twinVersion.id },
        ...(input.captureSessionId
          ? [{ label: `Capture session ${input.captureSessionId}`, kind: 'captureSession', ref: input.captureSessionId }]
          : []),
        ...(input.pipeline
          ? [{ label: `Pipeline ${input.pipeline.name}`, kind: 'pipeline', ref: input.pipeline.id }]
          : []),
      ],
      ...(input.confidence
        ? {
            metrics: {
              overall: input.confidence.overall,
              deficiencies: input.confidence.deficiencies,
              ...(input.llmCalls !== null ? { llmCalls: input.llmCalls } : {}),
            } as Record<string, string | number | boolean>,
          }
        : {}),
    }),
    compare: baselineTwinVersion
      ? filled<ManifestCompareSection>({
          baselineTwinVersion,
          note: `Version compare against the prior compile (v${baselineTwinVersion.version}) — confidence and deficiency delta.`,
        })
      : absent<ManifestCompareSection>(
          `first compiled version — no prior TwinVersion of this twin exists to compare against`,
          'compile a new version from new evidence; v1 then becomes its baseline',
        ),
    evidence: input.evidenceAssetIds.length
      ? filled<ManifestEvidenceSection>({ assetIds: [...input.evidenceAssetIds] })
      : absent<ManifestEvidenceSection>(
          'this compile referenced no analyzed evidence assets',
          'compile from a capture session with analyzed assets',
        ),
    improve: absent<ManifestImproveSection>(
      `the improve chain ${ACCRUES_NOTE} — targeted evidence requests, their fulfillment captures, and versions compiled from them appear here live`,
      'request targeted evidence from the Improve tab, then compile a new version from its fulfillment',
    ),
    performance: absent<ManifestPerformanceSection>(
      'twin compilation is evidence → HTIR — no performance track is involved in this workflow',
      'render this version with a performance to produce a render-review artifact carrying one',
    ),
    provenance: filled<ManifestProvenanceSection>({
      adapterComponents: input.adapterComponents.map((c) => ({ ...c })),
      provenanceKeys: [...input.provenanceKeys],
    }),
    consent: filled<ManifestConsentSection>({
      subjectId: input.consent.subjectId,
      grantIds: [...input.consent.grantIds],
      scopes: [...input.consent.scopes],
    }),
    apiCode: filled<ManifestApiCodeSection>({
      endpoints: [
        `/api/v1/artifacts/${ARTIFACT_ID_TOKEN}`,
        `/api/v1/twins/${input.twinId}/versions`,
        `/api/v1/twins/${input.twinId}/deficiencies?versionId=${twinVersion.id}`,
        '/api/v1/feedback',
        '/api/v1/evidence-requests',
      ],
    }),
    feedback: absent<ManifestFeedbackSection>(
      `feedback ${ACCRUES_NOTE} — live FeedbackRequests linked to this artifact surface on the Feedback tab`,
      'submit a verdict from the Feedback tab',
    ),
    evidenceRequests: absent<ManifestEvidenceRequestsSection>(
      `targeted evidence requests ${ACCRUES_NOTE} — live requests referencing this artifact's TwinVersion surface on the Improve tab`,
      'request targeted evidence from the Improve tab',
    ),
  };
}

export function buildRenderSections(input: RenderSectionInput): ArtifactManifestSections {
  const { twinVersion, baselineTwinVersion } = input;
  const timing = input.latencyMs !== null ? ` in ${input.latencyMs}ms` : '';
  const cost = input.costUsd !== null ? ` · $${input.costUsd}` : '';
  const summary = input.outputArtifact
    ? `Rendered ${input.outputArtifact.label}${timing}${cost}`
    : `Render job completed${timing}${cost} — no output artifact row was persisted`;

  return {
    result: filled<ManifestResultSection>({
      summary,
      refs: [
        { label: `Render job ${input.renderJobId}`, kind: 'renderJob', ref: input.renderJobId },
        { label: `TwinVersion v${twinVersion.version}`, kind: 'twinVersion', ref: twinVersion.id },
        ...(input.outputArtifact
          ? [{ label: input.outputArtifact.label, kind: input.outputArtifact.kind, ref: input.outputArtifact.artifactId }]
          : []),
        ...(input.performance
          ? [{ label: `Performance ${input.performance.name}`, kind: 'performance', ref: input.performance.id }]
          : []),
      ],
      ...(input.outputArtifact
        ? {
            metrics: {
              ...(input.latencyMs !== null ? { latencyMs: input.latencyMs } : {}),
              ...(input.costUsd !== null ? { costUsd: input.costUsd } : {}),
            } as Record<string, string | number | boolean>,
          }
        : {}),
    }),
    compare: baselineTwinVersion
      ? filled<ManifestCompareSection>({
          baselineTwinVersion,
          note: `The rendered TwinVersion (v${twinVersion.version}) compares against its prior compile (v${baselineTwinVersion.version}).`,
        })
      : absent<ManifestCompareSection>(
          `the rendered TwinVersion (v${twinVersion.version}) is this twin's first compile — no baseline exists`,
          'compile a new version and re-render to enable the compare',
        ),
    evidence: absent<ManifestEvidenceSection>(
      'render jobs consume a compiled TwinVersion (HTIR), not raw captures — the twin-review artifact of that version carries the underlying evidence',
      'open the twin-review artifact for this TwinVersion',
    ),
    improve: absent<ManifestImproveSection>(
      `the improve chain ${ACCRUES_NOTE} — requests targeting the rendered TwinVersion and versions compiled after it appear here live`,
      'request targeted evidence from the Improve tab, then compile a new version',
    ),
    performance: input.performance
      ? filled<ManifestPerformanceSection>({ id: input.performance.id, name: input.performance.name })
      : absent<ManifestPerformanceSection>(
          'static render — no performance track drove this job',
          'create the render with a performanceId to bake a track in',
        ),
    provenance: filled<ManifestProvenanceSection>({
      adapterComponents: input.adapterComponents.map((c) => ({ ...c })),
      provenanceKeys: [...input.provenanceKeys],
    }),
    consent: filled<ManifestConsentSection>({
      subjectId: input.consent.subjectId,
      grantIds: [...input.consent.grantIds],
      scopes: [...input.consent.scopes],
    }),
    apiCode: filled<ManifestApiCodeSection>({
      endpoints: [
        `/api/v1/artifacts/${ARTIFACT_ID_TOKEN}`,
        `/api/v1/renders/${input.renderJobId}`,
        ...(input.performance ? [`/api/v1/performances/${input.performance.id}`] : []),
        '/api/v1/feedback',
        '/api/v1/evidence-requests',
      ],
    }),
    feedback: absent<ManifestFeedbackSection>(
      `feedback ${ACCRUES_NOTE} — live FeedbackRequests linked to this artifact surface on the Feedback tab`,
      'submit a verdict from the Feedback tab',
    ),
    evidenceRequests: absent<ManifestEvidenceRequestsSection>(
      `targeted evidence requests ${ACCRUES_NOTE} — live requests referencing the rendered TwinVersion surface on the Improve tab`,
      'request targeted evidence from the Improve tab',
    ),
  };
}

export function buildPerformanceSections(input: PerformanceSectionInput): ArtifactManifestSections {
  const summary = `${input.origin}-origin performance · ${input.trackCount} tracks${input.durationMs !== null ? ` · ${input.durationMs}ms` : ''}${input.sentenceCount !== null ? ` · ${input.sentenceCount} sentences` : ''} · ${input.llmEnhanced ? 'LLM-tagged expressions' : 'deterministic fallback expressions'}`;

  return {
    result: filled<ManifestResultSection>({
      summary,
      refs: [
        { label: `Performance ${input.performance.name}`, kind: 'performance', ref: input.performance.id },
        ...(input.twinId
          ? [{ label: `Twin ${input.twinId}`, kind: 'twin', ref: input.twinId }]
          : []),
      ],
      metrics: {
        tracks: input.trackCount,
        ...(input.durationMs !== null ? { durationMs: input.durationMs } : {}),
        ...(input.sentenceCount !== null ? { sentences: input.sentenceCount } : {}),
        llmEnhanced: input.llmEnhanced,
      },
    }),
    compare: absent<ManifestCompareSection>(
      'performances are identity-independent control streams, not versioned twins — no baseline comparison applies to this workflow',
    ),
    evidence: absent<ManifestEvidenceSection>(
      `${input.origin}-origin performances record no captures — no raw evidence exists to reference`,
    ),
    improve: absent<ManifestImproveSection>(
      'the improve chain tracks evidence requests → captures → new twin versions; a performance improves by regeneration from an edited script instead',
      'edit the script and create a new performance',
    ),
    performance: filled<ManifestPerformanceSection>({ id: input.performance.id, name: input.performance.name }),
    provenance: filled<ManifestProvenanceSection>({
      adapterComponents: [],
      provenanceKeys: [...input.provenanceKeys],
    }),
    consent: absent<ManifestConsentSection>(
      'no subject evidence is involved — a text-origin performance records no biometrics, so no consent grant applies',
    ),
    apiCode: filled<ManifestApiCodeSection>({
      endpoints: [
        `/api/v1/artifacts/${ARTIFACT_ID_TOKEN}`,
        `/api/v1/performances/${input.performance.id}`,
        '/api/v1/feedback',
      ],
    }),
    feedback: absent<ManifestFeedbackSection>(
      input.twinId
        ? 'verdict feedback references a TwinVersion (the /api/v1/feedback contract); this performance is twin-linked but not bound to a compiled version — attaching one would be invention'
        : 'verdict feedback references a TwinVersion (the /api/v1/feedback contract); this performance is identity-independent and carries none',
      'drive a render with this performance — the resulting render-review artifact carries the reviewable TwinVersion',
    ),
    evidenceRequests: absent<ManifestEvidenceRequestsSection>(
      input.twinId
        ? 'targeted evidence requests reference a TwinVersion; this performance is twin-linked but not bound to a compiled version'
        : 'targeted evidence requests reference a TwinVersion; this performance is identity-independent and carries none',
      'request evidence from a twin-review artifact of the linked twin',
    ),
  };
}

// ─── Post-creation binding ───────────────────────────────────────────────────

/** Replace the artifact-id placeholder token in the apiCode endpoints with
 *  the REAL row id (called once, right after solutionArtifact.create). */
export function bindArtifactId(
  sections: ArtifactManifestSections,
  artifactId: string,
): ArtifactManifestSections {
  const bindSlot = (endpoints: string[]) => endpoints.map((e) => e.replaceAll(ARTIFACT_ID_TOKEN, artifactId));
  return {
    ...sections,
    apiCode: sections.apiCode.data
      ? { data: { ...sections.apiCode.data, endpoints: bindSlot(sections.apiCode.data.endpoints) } }
      : sections.apiCode,
  };
}

// ─── Read-time live enrichment ───────────────────────────────────────────────

export interface LiveArtifactState {
  /** FeedbackRequests linked to THIS artifact (newest first). */
  feedbackRequests: FeedbackRequestView[];
  /** targeted EvidenceRequests referencing the artifact's TwinVersion (chronological). */
  evidenceRequests: EvidenceRequestView[];
  /** newer versions of the same twin (asc), causally linked — see linkFollowUpVersions. */
  followUpVersions: ManifestImproveSection['followUpVersions'];
  /** the creation-time capability catalog (from evidence_request_schema). */
  capabilities: string[];
}

/**
 * Merge LIVE state into the stored sections for a read — the stored manifest
 * is never rewritten. Honesty laws:
 * - feedback/evidenceRequests fill ONLY when real rows exist; with none, the
 *   STORED null-with-reason stands verbatim (the creation-time structural
 *   reason — e.g. a performance artifact can never accrue TwinVersion-bound
 *   feedback — is more honest than a generic "none yet"; the generic message
 *   only fills in when a stored reason is missing).
 * - improve fills only when a chain actually exists (a request OR a follow-up
 *   version); artifacts without a TwinVersion keep their creation-time reason.
 * - every other slot passes through byte-identical.
 */
export function enrichSectionsLive(
  stored: ArtifactManifestSections,
  live: LiveArtifactState,
): ArtifactManifestSections {
  const keepOrGeneric = (
    storedSlot: ArtifactSectionSlot<unknown>,
    generic: string,
  ): ArtifactSectionSlot<unknown> =>
    storedSlot.reason ? storedSlot : absent(generic);

  const feedback: ArtifactSectionSlot<ManifestFeedbackSection> = live.feedbackRequests.length
    ? {
        data: {
          requests: live.feedbackRequests,
          note: 'live FeedbackRequests linked to this artifact, merged at read time — the stored manifest is immutable and feedback never mutates evidence',
        },
      }
    : (keepOrGeneric(stored.feedback, 'no FeedbackRequests reference this artifact yet') as ArtifactSectionSlot<ManifestFeedbackSection>);

  const evidenceRequests: ArtifactSectionSlot<ManifestEvidenceRequestsSection> = live.evidenceRequests.length
    ? { data: { requests: live.evidenceRequests, capabilities: [...live.capabilities] } }
    : (keepOrGeneric(stored.evidenceRequests, 'no targeted evidence requests reference this TwinVersion yet') as ArtifactSectionSlot<ManifestEvidenceRequestsSection>);

  const storedImprove = stored.improve;
  const hasChain = live.evidenceRequests.length > 0 || live.followUpVersions.length > 0;
  const improve: ArtifactSectionSlot<ManifestImproveSection> = hasChain
    ? {
        data: {
          requests: live.evidenceRequests.map((r) => ({
            requestId: r.id,
            capability: r.capability,
            status: r.status,
            captureSessionId: r.captureSessionId ?? null,
          })),
          followUpVersions: live.followUpVersions,
          note: 'the live improve chain: targeted evidence requests → their fulfillment capture sessions → versions compiled from that evidence (causal links only — evidence asset overlap, never timestamps alone)',
        },
      }
    : (keepOrGeneric(storedImprove, 'no improve chain yet') as ArtifactSectionSlot<ManifestImproveSection>);

  return {
    ...stored,
    feedback,
    evidenceRequests,
    improve,
  };
}

// ─── Causal linking (pure) ───────────────────────────────────────────────────

export interface FollowUpVersionCandidate {
  twinVersionId: string;
  version: number;
  /** the version's persisted evidenceAssetIds (parsed from the row) */
  evidenceAssetIds: string[];
  /** the twin-review artifact of that version, when one exists */
  artifactId: string | null;
}

/**
 * Link follow-up versions to the fulfillment capture sessions that REALLY
 * caused them: a session causes a version when the version's
 * evidenceAssetIds overlap that session's evidence assets. Timestamps are
 * never consulted — overlap is the only causality signal.
 */
export function linkFollowUpVersions(input: {
  requests: { requestId: string; captureSessionId: string | null }[];
  /** assets recorded per fulfillment capture session */
  sessionAssets: Record<string, string[]>;
  versions: FollowUpVersionCandidate[];
}): ManifestImproveSection['followUpVersions'] {
  const sessionIds = [
    ...new Set(input.requests.map((r) => r.captureSessionId).filter((s): s is string => !!s)),
  ];
  return input.versions
    .slice()
    .sort((a, b) => a.version - b.version)
    .map((v) => ({
      twinVersionId: v.twinVersionId,
      version: v.version,
      artifactId: v.artifactId,
      causedBySessionIds: sessionIds.filter((sid) => {
        const assets = input.sessionAssets[sid] ?? [];
        return assets.some((a) => v.evidenceAssetIds.includes(a));
      }),
    }));
}

// ─── Completeness summary (UI + tests) ───────────────────────────────────────

export interface SectionCompleteness {
  total: number;
  filled: number;
  absent: number;
}

/** Count filled vs absent slots across the 10 canonical sections. */
export function sectionCompleteness(sections: ArtifactManifestSections): SectionCompleteness {
  let filledCount = 0;
  for (const key of ARTIFACT_SECTION_KEYS) {
    if (sections[key]?.data != null) filledCount += 1;
  }
  return { total: ARTIFACT_SECTION_KEYS.length, filled: filledCount, absent: ARTIFACT_SECTION_KEYS.length - filledCount };
}
