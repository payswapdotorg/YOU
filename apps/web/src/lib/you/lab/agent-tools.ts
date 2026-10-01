// ═══════════════════════════════════════════════════════════════════════════
// Agent tool registry — Worker C lane (W2.C work item: avatar tool execution).
//
// Wave-1 declared tools but never executed them. This registry gives the Agent
// Body's declared tools REAL execution via internal service calls (direct,
// tenant-scoped database queries — the same authority the API routes use;
// avatar tool calls never bypass consent enforcement that executors apply).
//
// Honesty rules:
// - a tool executes ONLY if it is declared by the body contract (server-side
//   enforcement — the model cannot invoke undeclared tools);
// - every execution records its input, the concrete internal effect (the exact
//   service call), the verbatim result and the MEASURED duration;
// - failures are recorded as executed: false with the verbatim reason — never
//   fabricated results.
// ═══════════════════════════════════════════════════════════════════════════
import { db } from '@/lib/db';

export interface AgentToolContext {
  tenantId: string;
  sessionId: string;
  /** tools declared by the Agent Body contract (server-enforced allow-list) */
  bodyTools: readonly string[];
  twinId?: string | null;
}

export interface AgentToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentToolExecution {
  tool: string;
  input: Record<string, unknown>;
  executed: boolean;
  /** the concrete internal service call that performed the work */
  effect: string | null;
  /** verbatim result (or null when not executed) */
  result: unknown;
  /** measured execution duration (real, when execution was attempted) */
  durationMs: number | null;
  /** when executed=false: the honest reason */
  reason?: string;
}

/** Capability vocabulary for evidence requests (mirrors the evidence tools' semantics). */
const CAPABILITY_INSTRUCTIONS: Record<string, { instructions: string; expectedSignal: string }> = {
  hands: {
    instructions: 'Capture a photo or short clip with palms visible and fingers spread at chest height.',
    expectedSignal: 'finger and palm geometry visible, fingers spread',
  },
  'face.front': {
    instructions: 'Capture a front-facing photo of the face, neutral expression, even lighting.',
    expectedSignal: 'front-facing facial geometry clearly visible, even lighting',
  },
  'face.profile': {
    instructions: 'Capture a ¾ or full side-profile photo of the face (head turned 45–90°).',
    expectedSignal: 'profile contour (nose, chin, jaw) visible',
  },
  'face.hairline': {
    instructions: 'Capture a front photo with the forehead/hairline visible.',
    expectedSignal: 'forehead and hairline visible',
  },
  'hair.back': {
    instructions: 'Capture a rear-view photo of the head showing hair volume and the back hairline.',
    expectedSignal: 'rear hair volume and back hairline visible',
  },
  teeth: {
    instructions: 'Capture a short clip with a natural smile briefly showing teeth.',
    expectedSignal: 'brief natural smile showing teeth',
  },
  speech: {
    instructions: 'Capture a short audio clip of natural speech (10–20 seconds).',
    expectedSignal: 'natural speech prosody and pace',
  },
  'silhouette.front': {
    instructions: 'Capture a full-body front-facing photo against a plain background.',
    expectedSignal: 'full-body front outline against a plain background',
  },
  'silhouette.side': {
    instructions: 'Capture a full-body side-view photo against a plain background.',
    expectedSignal: 'full-body side outline against a plain background',
  },
};

function capabilitySpec(capability: string): { instructions: string; expectedSignal: string } {
  return (
    CAPABILITY_INSTRUCTIONS[capability] ?? {
      instructions: `Capture additional evidence for capability "${capability}".`,
      expectedSignal: `clear signal for ${capability}`,
    }
  );
}

function reqString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`validation_failed: tool input.${key} (string) is required`);
  }
  return v.trim();
}

interface ToolDefinition {
  description: string;
  run(ctx: AgentToolContext, input: Record<string, unknown>): Promise<{ effect: string; result: unknown }>;
}

// ─── Tool implementations — REAL internal service calls ─────────────────────

const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  'twins.list': {
    description: 'List the digital twins that exist in this tenant (optionally filtered by a name query).',
    async run(ctx, input) {
      const limitRaw = input.limit;
      const limit =
        typeof limitRaw === 'number' && Number.isFinite(limitRaw)
          ? Math.min(20, Math.max(1, Math.floor(limitRaw)))
          : 10;
      const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : undefined;
      const twins = await db.twin.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(query
            ? { OR: [{ displayName: { contains: query } }, { personName: { contains: query } }] }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          displayName: true,
          personName: true,
          status: true,
          currentVersion: true,
          subjectId: true,
          createdAt: true,
        },
      });
      return {
        effect: `internal service call: db.twin.findMany (tenant-scoped${query ? `, displayName/personName contains "${query}"` : ''}, limit ${limit}) → ${twins.length} row(s)`,
        result: { count: twins.length, limit, twins },
      };
    },
  },

  'evidence.request': {
    description:
      'Create a targeted additional-evidence request for a twin (capability e.g. hands, face.profile, speech). Does not capture anything by itself — capture still requires consent.',
    async run(ctx, input) {
      const twinId = reqString(input, 'twinId');
      const capability = reqString(input, 'capability');
      const reason =
        typeof input.reason === 'string' && input.reason.trim()
          ? input.reason.trim()
          : `requested by agent avatar session ${ctx.sessionId}`;
      const twin = await db.twin.findFirst({ where: { id: twinId, tenantId: ctx.tenantId } });
      if (!twin) {
        throw new Error(
          `not_found: twinId "${twinId}" is not an exact twin id in this tenant — call twins.list to get exact ids (display names are not ids)`
        );
      }
      const latest = await db.twinVersion.findFirst({
        where: { twinId },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });
      const spec = capabilitySpec(capability);
      const request = await db.evidenceRequest.create({
        data: {
          tenantId: ctx.tenantId,
          twinVersionId: latest?.id ?? null,
          reason,
          capability,
          instructions: spec.instructions,
          expectedSignal: spec.expectedSignal,
          scope:
            'additional-evidence request created by an embodied agent; any capture/reconstruction remains consent-gated and server-enforced',
          status: 'open',
        },
      });
      return {
        effect: `internal service call: db.evidenceRequest.create (open request, capability "${capability}", twin ${twin.displayName}${latest ? ` v${latest.version}` : ' (no version yet)'})`,
        result: {
          evidenceRequestId: request.id,
          capability,
          twinVersionId: latest?.id ?? null,
          instructions: spec.instructions,
          status: 'open',
        },
      };
    },
  },

  knowledge_search: {
    description: 'Search tenant knowledge: twins by name, open evidence requests, and recent render artifacts.',
    async run(ctx, input) {
      const query = reqString(input, 'query');
      const [twins, requests, artifacts] = await Promise.all([
        db.twin.findMany({
          where: {
            tenantId: ctx.tenantId,
            OR: [
              { displayName: { contains: query } },
              { personName: { contains: query } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, displayName: true, status: true, currentVersion: true },
        }),
        db.evidenceRequest.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: 'open',
            OR: [{ capability: { contains: query } }, { reason: { contains: query } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, capability: true, reason: true, status: true },
        }),
        db.outputArtifact.findMany({
          where: { tenantId: ctx.tenantId, kind: { in: ['image', 'video', 'svg'] } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, kind: true, mime: true, bytes: true },
        }),
      ]);
      return {
        effect: `internal service call: db.twin.findMany + db.evidenceRequest.findMany + db.outputArtifact.findMany (tenant-scoped, query "${query}")`,
        result: {
          query,
          twinMatches: twins,
          openEvidenceRequests: requests,
          recentArtifacts: artifacts,
        },
      };
    },
  },
};

export function listAgentTools(): string[] {
  return Object.keys(TOOL_DEFINITIONS);
}

export function agentToolDescription(tool: string): string | null {
  return TOOL_DEFINITIONS[tool]?.description ?? null;
}

/**
 * Execute one agent tool call with server-side body-contract enforcement.
 * Never throws: failures come back as { executed: false, reason } — the turn
 * runtime surfaces them honestly instead of crashing the chat turn.
 */
export async function executeAgentTool(ctx: AgentToolContext, call: AgentToolCall): Promise<AgentToolExecution> {
  const definition = TOOL_DEFINITIONS[call.tool];
  if (!definition) {
    return {
      tool: call.tool,
      input: call.input,
      executed: false,
      effect: null,
      result: null,
      durationMs: null,
      reason: `unknown tool "${call.tool}" — not in the W2.C agent tool registry (available: ${Object.keys(TOOL_DEFINITIONS).join(', ')})`,
    };
  }
  if (!ctx.bodyTools.includes(call.tool)) {
    return {
      tool: call.tool,
      input: call.input,
      executed: false,
      effect: null,
      result: null,
      durationMs: null,
      reason: `tool "${call.tool}" is not declared by this Agent Body contract (declared: ${ctx.bodyTools.join(', ') || 'none'}) — server-side enforcement refused execution`,
    };
  }
  const started = Date.now();
  try {
    const { effect, result } = await definition.run(ctx, call.input ?? {});
    return {
      tool: call.tool,
      input: call.input,
      executed: true,
      effect,
      result,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      tool: call.tool,
      input: call.input,
      executed: false,
      effect: null,
      result: null,
      durationMs: Date.now() - started,
      reason: `execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
