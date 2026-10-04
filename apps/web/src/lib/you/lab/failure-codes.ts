// ═══════════════════════════════════════════════════════════════════════════
// Failure Atlas production surface (Worker C lane, P6.C11):
// (a) a typed, VERSIONED failure-code taxonomy (region / stage / provider /
//     policy classes) with structured payloads;
// (b) atlas aggregation (by code, region, pipeline, technology version, time
//     window) over REAL recorded cases only;
// (c) the remediation lifecycle open → mitigated → verified with audit
//     fields (who / when / evidence);
// (d) policy decision recording per failure class — derived from real
//     executor behavior, honestly marked "proposed" where the policy is not
//     yet implemented (never "enforced" without a real code path).
//
// ZERO-IMPORT MODULE LAW: no db, no storage, no crypto, no SDK imports.
// node:test imports this file directly and exercises the CONTRACT.
//
// HONESTY MODEL: unknown is unknown — a case that does not fit a taxonomy
// code is recorded UNCLASSIFIED (an explicit code, never a guess); atlas
// rollups only ever count real recorded cases.
// ═══════════════════════════════════════════════════════════════════════════
// NOTE: relative imports carry explicit .ts extensions (the ai/render-provider.ts
// precedent) so node:test's type-stripping resolver can load this contract core
// directly — the extensionless bundler specifiers are not resolvable under
// plain Node ESM.
import { round } from './determinism.ts';

// ─── (a) Failure-code taxonomy ───────────────────────────────────────────────

export const FAILURE_TAXONOMY_VERSION = 1;

export type FailureCodeClass = 'region' | 'stage' | 'provider' | 'policy';

export interface FailureCodeDefinition {
  code: string;
  class: FailureCodeClass;
  description: string;
  /** the structured payload contract for this code */
  payloadFields: string[];
  remediationHint: string;
}

export const FAILURE_CODES: Record<string, FailureCodeDefinition> = {
  REGION_UNCAPTURED: {
    code: 'REGION_UNCAPTURED',
    class: 'region',
    description: 'a canonical body region stayed uncaptured for at least one organization under the world seed conditions',
    payloadFields: ['region', 'regionDifficulty', 'occlusionPenalty', 'worldSeed'],
    remediationHint: 'request targeted region evidence via an EvidenceRequest and re-benchmark the mutated genome on the same seed',
  },
  SOUL_SWAP_CAPABILITY_LOSS: {
    code: 'SOUL_SWAP_CAPABILITY_LOSS',
    class: 'stage',
    description: 'a soul-swapped body lost post-swap capability fit below the retention floor (SOUL-SWAP-001 scenario)',
    payloadFields: ['organizationId', 'role', 'adapterId', 'canonicalSoul', 'swappedSoul', 'fit', 'worldSeed'],
    remediationHint: 'rebind the deep soul to the deliberative stage or re-compile the organization before promoting a swap policy',
  },
  SOUL_SWAP_IDENTITY_DRIFT: {
    code: 'SOUL_SWAP_IDENTITY_DRIFT',
    class: 'stage',
    description: 'post-swap behavioral drift exceeded the drift ceiling (SOUL-SWAP-001 scenario)',
    payloadFields: ['organizationId', 'drift', 'driftCeiling', 'worldSeed'],
    remediationHint: 'constrain soul swaps to same-depth souls for this genome, or re-benchmark with a lower-noise world',
  },
  PROVIDER_GROUNDING_FAILED: {
    code: 'PROVIDER_GROUNDING_FAILED',
    class: 'provider',
    description: 'the real provider grounding call failed — the score degrades honestly to modeled-only (never a fabricated measurement)',
    payloadFields: ['provider', 'model', 'error', 'basis'],
    remediationHint: 'check provider availability/credentials; re-run the benchmark to re-attempt the grounding measurement',
  },
  POLICY_SCOPE_DENIED: {
    code: 'POLICY_SCOPE_DENIED',
    class: 'policy',
    description: 'a policy gate (consent scope / API-key scope) denied the operation',
    payloadFields: ['gate', 'required', 'actual', 'route'],
    remediationHint: 'grant the required consent scope or API-key scope, then retry the operation',
  },
  UNCLASSIFIED: {
    code: 'UNCLASSIFIED',
    class: 'stage',
    description: 'the recorded conditions fit no taxonomy code (honest unknown — never a forced classification)',
    payloadFields: ['*'],
    remediationHint: 'triage manually; extend the taxonomy when the pattern repeats',
  },
};

export function failureCodeDefinition(code: string): FailureCodeDefinition {
  return FAILURE_CODES[code] ?? FAILURE_CODES.UNCLASSIFIED;
}

// ─── Classifiers (typed, honest — no guessing) ───────────────────────────────

export interface ClassifiedCase {
  code: string;
  payload: Record<string, unknown>;
}

export function classifyRegionFailure(input: {
  region: string;
  regionDifficulty: number;
  occlusionPenalty: number;
  worldSeed: number;
}): ClassifiedCase {
  return {
    code: 'REGION_UNCAPTURED',
    payload: {
      region: input.region,
      regionDifficulty: input.regionDifficulty,
      occlusionPenalty: input.occlusionPenalty,
      worldSeed: input.worldSeed,
    },
  };
}

export function classifySoulSwapCapabilityLoss(input: {
  organizationId: string;
  role: string;
  adapterId: string;
  canonicalSoul: string;
  swappedSoul: string;
  fit: number;
  worldSeed: number;
}): ClassifiedCase {
  return {
    code: 'SOUL_SWAP_CAPABILITY_LOSS',
    payload: {
      organizationId: input.organizationId,
      role: input.role,
      adapterId: input.adapterId,
      canonicalSoul: input.canonicalSoul,
      swappedSoul: input.swappedSoul,
      fit: input.fit,
      worldSeed: input.worldSeed,
    },
  };
}

export function classifySoulSwapDrift(input: {
  organizationId: string;
  drift: number;
  driftCeiling: number;
  worldSeed: number;
}): ClassifiedCase {
  return {
    code: 'SOUL_SWAP_IDENTITY_DRIFT',
    payload: {
      organizationId: input.organizationId,
      drift: input.drift,
      driftCeiling: input.driftCeiling,
      worldSeed: input.worldSeed,
    },
  };
}

export function classifyGroundingFailure(input: {
  provider: string;
  model: string | null;
  error: string;
}): ClassifiedCase {
  return {
    code: 'PROVIDER_GROUNDING_FAILED',
    payload: { provider: input.provider, model: input.model, error: input.error, basis: 'observed' },
  };
}

export function classifyPolicyScopeDenied(input: {
  gate: string;
  required: string;
  actual: string;
  route: string;
}): ClassifiedCase {
  return {
    code: 'POLICY_SCOPE_DENIED',
    payload: { gate: input.gate, required: input.required, actual: input.actual, route: input.route },
  };
}

// ─── (d) Policy decisions per failure class (honest enforced-vs-proposed) ─────

export type PolicyAction = 'retry' | 'fallback' | 'quarantine' | 'escalate';

export interface PolicyDecisionEntry {
  code: string;
  action: PolicyAction;
  status: 'enforced' | 'proposed';
  /** cites the REAL executor code path for enforced; states not-implemented for proposed */
  basis: string;
}

/**
 * What the system decides on each failure class. "enforced" entries cite real
 * executor behavior (code that runs today); "proposed" entries are honestly
 * labeled — the policy is NOT implemented yet and never claims to be.
 */
export const POLICY_DECISIONS: Record<string, PolicyDecisionEntry[]> = {
  REGION_UNCAPTURED: [
    {
      code: 'REGION_UNCAPTURED',
      action: 'fallback',
      status: 'enforced',
      basis:
        'the benchmark harness really applies the fallback QA stage to recover borderline regions at reduced confidence (benchmark.ts computePureMetrics — the hasFallbackQa branch), and the recorded remediation routes through the real EvidenceRequest flow',
    },
    {
      code: 'REGION_UNCAPTURED',
      action: 'retry',
      status: 'proposed',
      basis: 'no automated region re-capture retry exists in the lab harness yet — the remediation is a recorded hint, not an executed retry',
    },
  ],
  SOUL_SWAP_CAPABILITY_LOSS: [
    {
      code: 'SOUL_SWAP_CAPABILITY_LOSS',
      action: 'escalate',
      status: 'proposed',
      basis: 'no automated escalation path exists — the case lands in the atlas for human triage; promotion gates would cite it as evidence',
    },
  ],
  SOUL_SWAP_IDENTITY_DRIFT: [
    {
      code: 'SOUL_SWAP_IDENTITY_DRIFT',
      action: 'escalate',
      status: 'proposed',
      basis: 'no automated escalation path exists — the case lands in the atlas for human triage; promotion gates would cite it as evidence',
    },
  ],
  PROVIDER_GROUNDING_FAILED: [
    {
      code: 'PROVIDER_GROUNDING_FAILED',
      action: 'fallback',
      status: 'enforced',
      basis:
        'the harness really degrades the latency score to modeled-only and labels it (the grounding.real === false path in benchmark.ts / soul-swap.ts) — an honest fallback, not a fabricated measurement',
    },
    {
      code: 'PROVIDER_GROUNDING_FAILED',
      action: 'retry',
      status: 'proposed',
      basis: 'the grounding call is single-shot — no provider retry is implemented in the harness',
    },
  ],
  POLICY_SCOPE_DENIED: [
    {
      code: 'POLICY_SCOPE_DENIED',
      action: 'quarantine',
      status: 'proposed',
      basis:
        'consent/scope-gated routes refuse the individual request outright today (an enforced refusal, not a quarantine); quarantining a repeating offender is not implemented',
    },
  ],
  UNCLASSIFIED: [
    {
      code: 'UNCLASSIFIED',
      action: 'escalate',
      status: 'proposed',
      basis: 'unclassified failures require human triage — no automated routing exists',
    },
  ],
};

export function policyDecisionsForCode(code: string): PolicyDecisionEntry[] {
  return POLICY_DECISIONS[code] ?? POLICY_DECISIONS.UNCLASSIFIED;
}

// ─── (b) Atlas aggregation over real recorded cases ──────────────────────────

export interface AtlasCase {
  id: string;
  code: string;
  inputConditions: Record<string, unknown>;
  payload: Record<string, unknown>;
  pipeline: Record<string, unknown>;
  technologyVersions: unknown[];
  suspectedCause: string;
  confidence: number;
  status: string; // open | mitigated | verified
  createdAt: string; // ISO
}

export interface AtlasGroupRow {
  key: string;
  count: number;
  meanConfidence: number;
  minConfidence: number;
  maxConfidence: number;
  open: number;
  mitigated: number;
  verified: number;
  topSuspectedCauses: Array<{ cause: string; count: number }>;
}

export interface AtlasCodeRow extends AtlasGroupRow {
  code: string;
  class: FailureCodeClass;
  policy: PolicyDecisionEntry[];
}

export interface FailureAtlas {
  taxonomyVersion: number;
  window: { from: string | null; to: string | null; filteredOut: number; note: string };
  totals: {
    cases: number;
    open: number;
    mitigated: number;
    verified: number;
    meanConfidence: number | null;
    unclassified: number;
  };
  byCode: AtlasCodeRow[];
  byRegion: AtlasGroupRow[];
  byPipeline: AtlasGroupRow[];
  byTechnologyVersion: AtlasGroupRow[];
  honestyNotes: string[];
}

function rollupGroup(cases: AtlasCase[], keyOf: (c: AtlasCase) => string | null, topCauses = 3): AtlasGroupRow[] {
  const groups = new Map<string, AtlasCase[]>();
  for (const c of cases) {
    const key = keyOf(c);
    if (key === null || key === '') continue;
    const cur = groups.get(key) ?? [];
    cur.push(c);
    groups.set(key, cur);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const confidences = group.map((c) => c.confidence);
      const causes = new Map<string, number>();
      for (const c of group) {
        causes.set(c.suspectedCause, (causes.get(c.suspectedCause) ?? 0) + 1);
      }
      const topSuspectedCauses = [...causes.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, topCauses)
        .map(([cause, count]) => ({ cause, count }));
      return {
        key,
        count: group.length,
        meanConfidence: round(round(confidences.reduce((a, b) => a + b, 0) / Math.max(1, group.length), 4), 4),
        minConfidence: round(Math.min(...confidences), 4),
        maxConfidence: round(Math.max(...confidences), 4),
        open: group.filter((c) => c.status === 'open').length,
        mitigated: group.filter((c) => c.status === 'mitigated').length,
        verified: group.filter((c) => c.status === 'verified').length,
        topSuspectedCauses,
      };
    })
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/**
 * Aggregate the atlas from REAL recorded cases only — no case, no count.
 * Time window filters on createdAt (inclusive bounds; null = open-ended).
 */
export function aggregateAtlas(
  cases: AtlasCase[],
  opts: { from?: string | null; to?: string | null; topCauses?: number } = {},
): FailureAtlas {
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const inWindow = cases.filter((c) => {
    const t = Date.parse(c.createdAt);
    if (Number.isNaN(t)) return false;
    if (from !== null && t < Date.parse(from)) return false;
    if (to !== null && t > Date.parse(to)) return false;
    return true;
  });
  const filteredOut = cases.length - inWindow.length;

  const statusCount = (s: string) => inWindow.filter((c) => c.status === s).length;
  const confidences = inWindow.map((c) => c.confidence);

  const byCode: AtlasCodeRow[] = rollupGroup(inWindow, (c) => c.code, opts.topCauses).map((row) => {
    const def = failureCodeDefinition(row.key);
    return { ...row, code: row.key, class: def.class, policy: policyDecisionsForCode(row.key) };
  });

  const byRegion = rollupGroup(
    inWindow,
    (c) => (typeof c.payload.region === 'string' ? c.payload.region : null),
    opts.topCauses,
  );

  const byPipeline = rollupGroup(
    inWindow,
    (c) => {
      const p = c.pipeline;
      const name = typeof p.name === 'string' ? p.name : typeof p.pipelineName === 'string' ? p.pipelineName : null;
      return name;
    },
    opts.topCauses,
  );

  const byTechnologyVersion = rollupGroup(
    inWindow,
    (c) => {
      const versions = Array.isArray(c.technologyVersions) ? c.technologyVersions : [];
      // one case can cite several versions — attribute to the first (stable order)
      const first = versions[0];
      if (first && typeof first === 'object') {
        const v = first as { component?: unknown; version?: unknown; adapterId?: unknown };
        const comp = typeof v.component === 'string' ? v.component : typeof v.adapterId === 'string' ? v.adapterId : null;
        const ver = typeof v.version === 'string' ? v.version : null;
        if (comp && ver) return `${comp}@${ver}`;
      }
      return null;
    },
    opts.topCauses,
  );

  return {
    taxonomyVersion: FAILURE_TAXONOMY_VERSION,
    window: {
      from,
      to,
      filteredOut,
      note: 'window bounds are inclusive on createdAt; null = open-ended; counts derive from real recorded cases only',
    },
    totals: {
      cases: inWindow.length,
      open: statusCount('open'),
      mitigated: statusCount('mitigated'),
      verified: statusCount('verified'),
      meanConfidence: inWindow.length
        ? round(round(confidences.reduce((a, b) => a + b, 0) / inWindow.length, 4), 4)
        : null,
      unclassified: inWindow.filter((c) => c.code === 'UNCLASSIFIED' || !FAILURE_CODES[c.code]).length,
    },
    byCode,
    byRegion,
    byPipeline,
    byTechnologyVersion,
    honestyNotes: [
      'atlas rollups count REAL recorded FailureCase rows only — no case, no count',
      'confidence rollups are means/mins/maxes over recorded case confidence (simulated-world evidence, labeled as such at record time)',
      'top suspected causes are the most frequent recorded cause strings — they are hypotheses, not diagnoses',
      'policy entries are labeled enforced (cites a real executor code path) or proposed (not yet implemented — never claimed as enforced)',
    ],
  };
}

// ─── (c) Remediation lifecycle: open → mitigated → verified ──────────────────

export const REMEDIATION_STATUSES = ['open', 'mitigated', 'verified'] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];
export type RemediationAction = 'mitigate' | 'verify';

export interface RemediationLogEntry {
  action: RemediationAction;
  from: RemediationStatus;
  to: RemediationStatus;
  actorType: 'user' | 'application';
  actorId: string;
  tenantId: string;
  evidence: string;
  note?: string;
  at: string; // ISO
}

export type RemediationDecision =
  | { ok: true; status: RemediationStatus; log: RemediationLogEntry[] }
  | { ok: false; status: number; code: string; message: string };

/**
 * The remediation transition table:
 *   open --mitigate--> mitigated --verify--> verified (terminal).
 * Evidence is REQUIRED on every action; every action appends an audit entry
 * (who / when / evidence). Anything else is an honest refusal.
 */
export function applyRemediationTransition(args: {
  currentStatus: string;
  log: RemediationLogEntry[];
  action: RemediationAction;
  evidence: string;
  actor: { actorType: 'user' | 'application'; actorId: string; tenantId: string };
  note?: string;
  now: string;
}): RemediationDecision {
  const evidence = (args.evidence ?? '').trim();
  if (!evidence) {
    return {
      ok: false,
      status: 400,
      code: 'validation_failed',
      message: 'field "evidence" is required (non-empty string) — remediation actions are evidence-driven',
    };
  }
  if (!(REMEDIATION_STATUSES as readonly string[]).includes(args.currentStatus)) {
    return {
      ok: false,
      status: 400,
      code: 'validation_failed',
      message: `unknown remediation status "${args.currentStatus}" — expected one of ${REMEDIATION_STATUSES.join(' | ')}`,
    };
  }
  const from = args.currentStatus as RemediationStatus;

  const next: RemediationStatus | null =
    args.action === 'mitigate' ? (from === 'open' ? 'mitigated' : null) : from === 'mitigated' ? 'verified' : null;

  if (next === null) {
    const reason =
      args.action === 'mitigate'
        ? from === 'mitigated'
          ? 'the case is already mitigated — verify it (or re-open via a new case) instead of re-mitigating'
          : 'the case is verified (terminal) — no further remediation transitions are allowed'
        : from === 'open'
          ? 'the case is still open — mitigate it before verification'
          : 'the case is verified (terminal) — no further remediation transitions are allowed';
    return {
      ok: false,
      status: 409,
      code: 'conflict',
      message: `invalid remediation transition ${from} --${args.action}--> …: ${reason}`,
    };
  }

  const entry: RemediationLogEntry = {
    action: args.action,
    from,
    to: next,
    actorType: args.actor.actorType,
    actorId: args.actor.actorId,
    tenantId: args.actor.tenantId,
    evidence,
    ...(args.note && args.note.trim() ? { note: args.note.trim() } : {}),
    at: args.now,
  };
  return { ok: true, status: next, log: [...args.log, entry] };
}

// ─── Route decision folds (the routes' enforcement order, exactly) ───────────

export interface LabRouteAuth {
  tenantId: string;
  actorType: 'user' | 'application';
  actorId: string;
  /** null = interactive session (full studio access); array = api key scopes */
  scopes: string[] | null;
}

/**
 * The POST /api/v1/lab/failures/:id/remediate decision fold:
 * unauthenticated → 401; write-scope enforcement → 403 (POST on an API key
 * requires "write"); unknown case → 404; invalid body → 400; invalid
 * transition → 409; otherwise proceed. Lab data is platform-global by design
 * (matching every existing /lab route) — the enforcement boundary is
 * authentication + scope, and the audit entry records the acting tenant.
 */
export function decideRemediate(args: {
  auth: LabRouteAuth | null;
  failureId: string;
  failure: { id: string; status: string; remediationLog: RemediationLogEntry[] } | null;
  body: { action?: unknown; evidence?: unknown; note?: unknown };
  now: string;
}):
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'proceed'; action: RemediationAction; evidence: string; note?: string } {
  if (!args.auth) {
    return { kind: 'error', status: 401, code: 'unauthenticated', message: 'authentication required' };
  }
  const scopes = args.auth.scopes;
  if (scopes !== null && !scopes.includes('write')) {
    return {
      kind: 'error',
      status: 403,
      code: 'forbidden',
      message: `api key lacks the "write" scope required for POST /api/v1/lab/failures/${args.failureId}/remediate`,
    };
  }
  if (!args.failure) {
    return {
      kind: 'error',
      status: 404,
      code: 'not_found',
      message: `failure case "${args.failureId}" not found`,
    };
  }
  const action = args.body.action;
  if (action !== 'mitigate' && action !== 'verify') {
    return {
      kind: 'error',
      status: 400,
      code: 'validation_failed',
      message: 'field "action" must be "mitigate" or "verify"',
    };
  }
  const evidence = typeof args.body.evidence === 'string' ? args.body.evidence : '';
  if (!evidence.trim()) {
    return {
      kind: 'error',
      status: 400,
      code: 'validation_failed',
      message: 'field "evidence" is required (non-empty string) — remediation actions are evidence-driven',
    };
  }
  const note = typeof args.body.note === 'string' && args.body.note.trim() ? args.body.note.trim() : undefined;
  return { kind: 'proceed', action, evidence, ...(note !== undefined ? { note } : {}) };
}
