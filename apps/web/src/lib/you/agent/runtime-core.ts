// ═══════════════════════════════════════════════════════════════════════════
// Agent Body/Soul production runtime — the PURE half (Worker C lane, P6.C6).
//
// A Body is visual/physical avatar assets bound to a TwinVersion plus the
// ADR-0002 role/tool contract. A Soul is personality/behavior configuration
// bound to a Twin. Sessions bind (Twin, Body, Soul) with consent provenance
// and pinned Body/Soul version snapshots (reproducibility law).
//
// Honesty laws enforced by this module:
// - CAPABILITY MANIFEST: every Body/Soul carries an honest manifest { can,
//   cannot } over a CLOSED vocabulary of capabilities the runtime actually
//   executes. Anything not declared in `can` is disclosed in `cannot` — no
//   silent overclaiming. Enforcement is SERVER-SIDE: a Soul cannot invoke a
//   capability it does not declare (decideToolInvocation refuses, the runtime
//   records the refusal honestly and the model is told the truth).
// - DETERMINISM: Soul behavior is versioned (immutable snapshots) and
//   reproducible — every turn records the seed that parameterized its request
//   construction. Honest limit (disclosed): the LLM provider's sampled OUTPUT
//   is not byte-reproducible; what is reproducible is the exact request
//   (messages + params + seed) and every runtime decision.
// - TYPED REFUSALS: every failure is a typed AgentRuntimeRefusal with an
//   honest HTTP taxonomy (400 validation / 403 policy / 404 / 409 conflict /
//   503 service-unavailable). Nothing is rewritten to look like success.
// - LATENCY: every duration the engine records is the REAL measured
//   round-trip reported by the injected chat seam (ai/zai.ts measures it);
//   nothing is fabricated here.
//
// ZERO-IMPORT MODULE (erasable TS only — every import is `import type`,
// erased at runtime, except the seeded-PRNG helpers from
// lab/determinism.ts which are themselves zero-import): imported directly by
// node:test unit suites under Node >= 23.6 type stripping. App callers import
// it via '@/lib/you/agent/runtime-core'.
// ═══════════════════════════════════════════════════════════════════════════
import { hashString } from '../lab/determinism.ts';
import { ProviderUnavailableError } from '../core/circuit-breaker.ts';
import type { JobKind } from '../contracts';
import type { AgentPerformanceEvent } from '../contracts';
import type { AgentToolExecution } from '../lab/agent-tools';
import { EMBODIMENT_RULES, MAX_TOOL_ROUNDS, cappedJson, parseToolCall } from '../lab/agent-turn-protocol.ts';

/**
 * The durable job kind for one agent chat turn (P6.C6). Lane-local widening
 * of the frozen JobKind union — the template.analyze / f1.reconstruct
 * precedent; TL adds the union member at landing.
 */
export const AGENT_TURN_JOB_KIND = 'agent.turn' as JobKind;

// ─── Capability manifest (closed vocabulary, server-enforced) ────────────────

/**
 * The CLOSED capability vocabulary. Every token maps to a REAL enforcement
 * point in this runtime — the list deliberately contains nothing the runtime
 * cannot execute (no overclaiming): each capability below has a concrete
 * server-side gate. Extending the vocabulary requires wiring a new gate.
 */
export const AGENT_CAPABILITY_VOCABULARY = [
  'conversation', // run chat turns (LLM) — required by both Body and Soul to start a session
  'tool-use', // invoke W2.C registry tools that only read/list tenant data
  'evidence-request', // invoke the evidence.request tool (creates additional-evidence requests)
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITY_VOCABULARY)[number];

/** The honest capability manifest: what the entity CAN and CANNOT do. */
export interface AgentCapabilityManifest {
  can: AgentCapability[];
  cannot: AgentCapability[];
}

/** Typed manifest refusal (validation_failed, HTTP 400). */
export function invalidManifest(message: string, details?: unknown): AgentRuntimeRefusal {
  return new AgentRuntimeRefusal(400, 'validation_failed', message, details);
}

/**
 * Normalize a caller-provided `can` list into the honest manifest:
 * - every token must be part of the closed vocabulary (else typed 400);
 * - duplicates/ordering noise are collapsed (sorted, unique);
 * - `cannot` is the auto-disclosed COMPLEMENT — a Body/Soul that declares
 *   nothing silently claims nothing; unclaimed capabilities are explicitly
 *   listed as limitations.
 */
export function normalizeManifest(can: unknown): AgentCapabilityManifest {
  if (can === undefined || can === null) {
    return { can: [], cannot: [...AGENT_CAPABILITY_VOCABULARY] };
  }
  if (!Array.isArray(can) || can.some((c) => typeof c !== 'string' || !c.trim())) {
    throw invalidManifest('manifest "can" must be an array of capability strings', {
      vocabulary: [...AGENT_CAPABILITY_VOCABULARY],
    });
  }
  const seen = new Set<string>();
  for (const raw of can as string[]) {
    const token = raw.trim();
    if (!(AGENT_CAPABILITY_VOCABULARY as readonly string[]).includes(token)) {
      throw invalidManifest(
        `unknown capability "${token}" — the vocabulary is closed: ${AGENT_CAPABILITY_VOCABULARY.join(', ')}`,
        { vocabulary: [...AGENT_CAPABILITY_VOCABULARY] },
      );
    }
    seen.add(token);
  }
  const canList = [...seen].sort() as AgentCapability[];
  const cannotList = AGENT_CAPABILITY_VOCABULARY.filter((c) => !canList.includes(c));
  return { can: canList, cannot: [...cannotList] };
}

/** Defensive parse of a persisted manifest JSON string (never throws). */
export function parseManifest(json: string | null | undefined): AgentCapabilityManifest {
  if (!json) return { can: [], cannot: [...AGENT_CAPABILITY_VOCABULARY] };
  try {
    const parsed = JSON.parse(json) as { can?: unknown; cannot?: unknown };
    const can = Array.isArray(parsed.can)
      ? parsed.can.filter((c): c is AgentCapability =>
          (AGENT_CAPABILITY_VOCABULARY as readonly string[]).includes(String(c)),
        )
      : [];
    const cannot = AGENT_CAPABILITY_VOCABULARY.filter((c) => !can.includes(c));
    return { can, cannot };
  } catch {
    return { can: [], cannot: [...AGENT_CAPABILITY_VOCABULARY] };
  }
}

// ─── Tool → capability mapping (mirrors the W2.C agent tool registry) ────────

/**
 * Which capability each W2.C registry tool exercises. UNKNOWN tools are
 * refused fail-closed by decideToolInvocation (capability null). This map is
 * a lane-maintained mirror of lab/agent-tools.ts TOOL_DEFINITIONS keys —
 * a new registry tool without a mapping here is refused by the runtime until
 * the mirror is extended (fail-closed, never silent).
 */
export const TOOL_CAPABILITIES: Record<string, AgentCapability> = {
  'twins.list': 'tool-use',
  knowledge_search: 'tool-use',
  'evidence.request': 'evidence-request',
};

export function capabilityForTool(tool: string): AgentCapability | null {
  return TOOL_CAPABILITIES[tool] ?? null;
}

export interface ToolInvocationDecision {
  allowed: boolean;
  /** the capability the tool exercises (null when the tool is unknown). */
  capability: AgentCapability | null;
  /** when refused: the honest, user-comprehensible reason (verbatim in records). */
  reason?: string;
  /** machine-readable refusal kind for tests/telemetry. */
  refusalKind?:
    | 'unknown-tool'
    | 'body-undeclared-tool'
    | 'soul-undeclared-capability'
    | 'body-undeclared-capability';
}

/**
 * SERVER-SIDE capability enforcement (the WO law: "a Soul cannot invoke a
 * capability it does not declare"). A tool invocation is allowed ONLY when
 * the tool is known AND declared by the Body contract AND its capability is
 * declared by BOTH the Soul manifest and the Body manifest (least privilege).
 * Refusals carry an honest reason — never a fabricated result.
 */
export function decideToolInvocation(
  tool: string,
  soulManifest: AgentCapabilityManifest,
  bodyTools: readonly string[],
  bodyManifest: AgentCapabilityManifest,
): ToolInvocationDecision {
  const capability = capabilityForTool(tool);
  if (!capability) {
    return {
      allowed: false,
      capability: null,
      refusalKind: 'unknown-tool',
      reason: `unknown tool "${tool}" — it is not in the agent tool registry capability mirror (known: ${Object.keys(TOOL_CAPABILITIES).join(', ')})`,
    };
  }
  if (!bodyTools.includes(tool)) {
    return {
      allowed: false,
      capability,
      refusalKind: 'body-undeclared-tool',
      reason: `tool "${tool}" is not declared by this Agent Body contract (declared: ${bodyTools.join(', ') || 'none'}) — server-side enforcement refused execution`,
    };
  }
  if (!soulManifest.can.includes(capability)) {
    return {
      allowed: false,
      capability,
      refusalKind: 'soul-undeclared-capability',
      reason: `capability "${capability}" (required by tool "${tool}") is not declared by this Soul's manifest (can: ${soulManifest.can.join(', ') || 'none'}) — server-side enforcement refused execution`,
    };
  }
  if (!bodyManifest.can.includes(capability)) {
    return {
      allowed: false,
      capability,
      refusalKind: 'body-undeclared-capability',
      reason: `capability "${capability}" (required by tool "${tool}") is not declared by this Body's manifest (can: ${bodyManifest.can.join(', ') || 'none'}) — server-side enforcement refused execution`,
    };
  }
  return { allowed: true, capability };
}

// ─── Lifecycle state machine ─────────────────────────────────────────────────

export type AgentEntityStatus = 'draft' | 'active' | 'inactive';
export const AGENT_ENTITY_STATUSES: readonly AgentEntityStatus[] = ['draft', 'active', 'inactive'];

export function parseEntityStatus(raw: string | null | undefined): AgentEntityStatus {
  return AGENT_ENTITY_STATUSES.includes(raw as AgentEntityStatus) ? (raw as AgentEntityStatus) : 'draft';
}

export interface LifecycleDecision {
  ok: boolean;
  next: AgentEntityStatus;
  refusal?: AgentRuntimeRefusal;
}

/**
 * Lifecycle transitions: activate (draft|inactive → active) and deactivate
 * (active → inactive). Invalid transitions are typed 409 conflicts — the
 * honest refusal names the current status. Version bumps are definition
 * edits, not lifecycle transitions (see the server runtime's snapshot append).
 */
export function decideLifecycleTransition(
  from: AgentEntityStatus,
  action: 'activate' | 'deactivate',
): LifecycleDecision {
  if (action === 'activate') {
    if (from === 'active') {
      return {
        ok: false,
        next: from,
        refusal: new AgentRuntimeRefusal(409, 'conflict', `entity is already active (status: ${from})`),
      };
    }
    return { ok: true, next: 'active' };
  }
  // deactivate
  if (from !== 'active') {
    return {
      ok: false,
      next: from,
      refusal: new AgentRuntimeRefusal(
        409,
        'conflict',
        `entity is ${from} — only an active entity can be deactivated (status: ${from})`,
      ),
    };
  }
  return { ok: true, next: 'inactive' };
}

// ─── Typed refusal taxonomy (the honest 4xx/5xx map) ─────────────────────────

export type AgentRuntimeRefusalCode =
  | 'validation_failed'
  | 'policy_blocked'
  | 'consent_required'
  | 'not_found'
  | 'conflict'
  | 'service_unavailable';

/**
 * A typed refusal from the agent runtime. The (status, code) pair is the API
 * taxonomy; routes translate this to the standard { error: { code, message } }
 * envelope via toHttpError (server half).
 */
export class AgentRuntimeRefusal extends Error {
  readonly status: number;
  readonly code: AgentRuntimeRefusalCode;
  readonly details?: unknown;
  constructor(status: number, code: AgentRuntimeRefusalCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentRuntimeRefusal';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const agentNotFound = (what: string) =>
  new AgentRuntimeRefusal(404, 'not_found', `${what} not found`);

// ─── The honest HTTP taxonomy (pure, testable) ──────────────────────────────

export interface AgentRuntimeHttpSpec {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  headers?: Record<string, string>;
}

/**
 * Pure mapping of runtime failures to the standard error-envelope spec.
 * Handles ONLY the runtime's own typed failures (AgentRuntimeRefusal + the
 * breaker's ProviderUnavailableError); anything else returns null and the
 * route layer lets it propagate to the honest 500 path (never rewritten).
 */
export function agentRuntimeHttpSpec(err: unknown): AgentRuntimeHttpSpec | null {
  if (err instanceof AgentRuntimeRefusal) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  if (err instanceof ProviderUnavailableError) {
    const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    return {
      status: 503,
      code: 'service_unavailable',
      message: err.message,
      details: { provider: err.provider, breakerState: err.breakerState, retryAfterSeconds },
      headers: { 'retry-after': String(retryAfterSeconds) },
    };
  }
  return null;
}

// ─── Session binding rules ───────────────────────────────────────────────────

export interface SessionBindingInput {
  body: {
    id: string;
    name: string;
    status: AgentEntityStatus;
    twinVersionId: string | null;
    manifest: AgentCapabilityManifest;
  };
  soul: { id: string; name: string; status: AgentEntityStatus; twinId: string; manifest: AgentCapabilityManifest };
  /** twinId of the Body's bound TwinVersion (null when the Body is abstract). */
  twinOfBodyVersion: string | null;
}

export type SessionBindingDecision = { ok: true } | { ok: false; refusal: AgentRuntimeRefusal };

/**
 * The session bind law: sessions bind (Twin, Body, Soul).
 * - both entities must be ACTIVE (409 on lifecycle state);
 * - both manifests must declare `conversation` — a Soul that cannot converse
 *   cannot run chat turns (403 policy_blocked);
 * - the Body's TwinVersion (when bound) must belong to the Soul's Twin
 *   (409 binding conflict) — the visual embodiment and the personality must
 *   point at the same person.
 * Consent is enforced server-side at the route/executor (db-bound), NOT here.
 */
export function decideSessionBinding(input: SessionBindingInput): SessionBindingDecision {
  if (input.body.status !== 'active') {
    return {
      ok: false,
      refusal: new AgentRuntimeRefusal(
        409,
        'conflict',
        `body "${input.body.name}" is ${input.body.status} — only an active Body can be bound to a session`,
        { bodyId: input.body.id, bodyStatus: input.body.status },
      ),
    };
  }
  if (input.soul.status !== 'active') {
    return {
      ok: false,
      refusal: new AgentRuntimeRefusal(
        409,
        'conflict',
        `soul "${input.soul.name}" is ${input.soul.status} — only an active Soul can be bound to a session`,
        { soulId: input.soul.id, soulStatus: input.soul.status },
      ),
    };
  }
  if (!input.soul.manifest.can.includes('conversation')) {
    return {
      ok: false,
      refusal: new AgentRuntimeRefusal(
        403,
        'policy_blocked',
        `soul "${input.soul.name}" does not declare the "conversation" capability — its manifest cannot run chat sessions`,
        { soulId: input.soul.id, can: input.soul.manifest.can, cannot: input.soul.manifest.cannot },
      ),
    };
  }
  if (!input.body.manifest.can.includes('conversation')) {
    return {
      ok: false,
      refusal: new AgentRuntimeRefusal(
        403,
        'policy_blocked',
        `body "${input.body.name}" does not declare the "conversation" capability — its manifest cannot run chat sessions`,
        { bodyId: input.body.id, can: input.body.manifest.can, cannot: input.body.manifest.cannot },
      ),
    };
  }
  if (input.twinOfBodyVersion !== null && input.twinOfBodyVersion !== input.soul.twinId) {
    return {
      ok: false,
      refusal: new AgentRuntimeRefusal(
        409,
        'conflict',
        `binding conflict: body "${input.body.name}" is bound to a TwinVersion of another twin than soul "${input.soul.name}" — the visual embodiment and the personality must point at the same twin`,
        {
          bodyId: input.body.id,
          twinOfBodyVersion: input.twinOfBodyVersion,
          soulId: input.soul.id,
          soulTwinId: input.soul.twinId,
        },
      ),
    };
  }
  return { ok: true };
}

// ─── Determinism (seeded, recorded, reproducible) ────────────────────────────

/**
 * Session base seed: deterministic in its inputs (all of which are recorded
 * on the session row), so the row is post-hoc reproducible.
 */
export function deriveSessionSeed(
  tenantId: string,
  soulId: string,
  bodyId: string,
  createdAtIso: string,
): number {
  // SIGNED 32-bit: Prisma Int columns reject unsigned values ≥ 2^31
  // (observed live: seed 2963674284 failed the insert with "does not fit in
  // an INT column"). `| 0` maps the unsigned hash deterministically.
  return hashString(`session:${tenantId}:${soulId}:${bodyId}:${createdAtIso}`) | 0;
}

/** Turn seed: derived from the session seed, the turn ordinal and the user turn id. */
export function deriveTurnSeed(sessionSeed: number, agentTurnOrdinal: number, userTurnId: string): number {
  // signed 32-bit, same Int-column law as deriveSessionSeed
  return (sessionSeed ^ hashString(`turn:${agentTurnOrdinal}:${userTurnId}`)) | 0;
}

/**
 * Deterministic default temperature for Souls that do not declare one:
 * uniformly derived from the turn seed in [0.4, 0.8), rounded to 3 decimals.
 * Souls that DO declare a temperature use it verbatim (declared behavior).
 */
export function seededDefaultTemperature(seed: number): number {
  // Math.abs: seeds are signed 32-bit; the band stays [0.4, 0.8) either way
  const raw = 0.4 + (Math.abs(seed) % 400) / 1000;
  return Math.round(raw * 1000) / 1000;
}

// ─── Soul persona + behavior params (validated, honest) ──────────────────────

export interface AgentSoulPersona {
  tagline?: string;
  traits: string[];
  speakingStyle?: string;
  additionalInstructions?: string;
}

export interface AgentSoulBehaviorParams {
  thinking?: boolean;
  temperature?: number;
}

export const SOUL_PROVIDER_IDS = ['zai'] as const;
export type SoulProviderId = (typeof SOUL_PROVIDER_IDS)[number];

/** Validated persona (bounded fields; traits deduped + capped at 12). */
export function normalizePersona(input: unknown): AgentSoulPersona {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t ? t.slice(0, max) : undefined;
  };
  const tagline = str(src.tagline, 200);
  const speakingStyle = str(src.speakingStyle, 600);
  const additionalInstructions = str(src.additionalInstructions, 2000);
  const traits = Array.isArray(src.traits)
    ? [
        ...new Set(
          src.traits
            .filter((t): t is string => typeof t === 'string' && !!t.trim())
            .map((t) => t.trim().slice(0, 60)),
        ),
      ].slice(0, 12)
    : [];
  return {
    ...(tagline ? { tagline } : {}),
    traits,
    ...(speakingStyle ? { speakingStyle } : {}),
    ...(additionalInstructions ? { additionalInstructions } : {}),
  };
}

/** Validated behavior params (thinking boolean; temperature 0..2 finite). */
export function normalizeBehaviorParams(input: unknown): AgentSoulBehaviorParams {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: AgentSoulBehaviorParams = {};
  if (typeof src.thinking === 'boolean') out.thinking = src.thinking;
  if (typeof src.temperature === 'number' && Number.isFinite(src.temperature)) {
    if (src.temperature < 0 || src.temperature > 2) {
      throw invalidManifest('soul params.temperature must be within [0, 2]', { temperature: src.temperature });
    }
    out.temperature = Math.round(src.temperature * 1000) / 1000;
  }
  return out;
}

// ─── System prompt compilation (reproducible request construction) ──────────

export interface AgentSystemPromptInput {
  body: {
    name: string;
    role: string;
    description?: string | null;
    version: number;
    tools: string[];
    manifest: AgentCapabilityManifest;
    twinVersionId?: string | null;
  };
  soul: {
    name: string;
    description?: string | null;
    version: number;
    persona: AgentSoulPersona;
    manifest: AgentCapabilityManifest;
    twinDisplayName: string;
    provider: string;
    model: string;
  };
  turnSeed: number;
  temperature: number;
  thinking: boolean;
}

/**
 * Compile the full system prompt from the pinned Body + Soul snapshots.
 * PURE: given the same snapshots + seed-derived params, the prompt is
 * byte-identical (the reproducibility law for request construction).
 */
export function compileAgentSystemPrompt(input: AgentSystemPromptInput): string {
  const { body, soul } = input;
  const lines: string[] = [
    `You are "${body.name}", an embodied agent (Body v${body.version}).`,
    `Role: ${body.role}.`,
  ];
  if (body.description) lines.push(`Description: ${body.description}`);
  lines.push(`Tools: ${body.tools.join(', ') || 'none'}.`);
  if (body.twinVersionId) {
    lines.push(
      `Visual embodiment: this Body's visual/physical avatar assets are bound to TwinVersion ${body.twinVersionId} of twin "${soul.twinDisplayName}".`,
    );
  } else {
    lines.push('Visual embodiment: this Body is abstract (no TwinVersion visual binding).');
  }
  lines.push('');
  lines.push('Capability manifest (server-enforced — the runtime refuses what is not declared):');
  lines.push(`- CAN: ${body.manifest.can.join(', ') || 'nothing'}`);
  lines.push(
    `- CANNOT: ${body.manifest.cannot.join(', ') || 'nothing'} — requests exercising these are refused by the runtime; never claim them.`,
  );
  lines.push('');
  lines.push(
    `You are animated by Soul "${soul.name}" (v${soul.version}) — the personality and behavior configuration for twin "${soul.twinDisplayName}".`,
  );
  if (soul.description) lines.push(`Soul description: ${soul.description}`);
  if (soul.persona.tagline) lines.push(`Persona tagline: ${soul.persona.tagline}`);
  if (soul.persona.traits.length) lines.push(`Traits: ${soul.persona.traits.join(', ')}`);
  if (soul.persona.speakingStyle) lines.push(`Speaking style: ${soul.persona.speakingStyle}`);
  if (soul.persona.additionalInstructions) lines.push(`Additional instructions: ${soul.persona.additionalInstructions}`);
  lines.push('');
  lines.push('Soul manifest (server-enforced):');
  lines.push(`- CAN: ${soul.manifest.can.join(', ') || 'nothing'}`);
  lines.push(
    `- CANNOT: ${soul.manifest.cannot.join(', ') || 'nothing'} — the runtime refuses tool calls exercising these; answer from your own knowledge instead and say so honestly.`,
  );
  lines.push('');
  lines.push(
    `Behavior parameters for this turn (reproducible request construction): thinking ${input.thinking ? 'enabled' : 'disabled'}, temperature ${input.temperature} (turn seed ${input.turnSeed}).`,
  );
  lines.push('');
  lines.push(EMBODIMENT_RULES);
  return lines.join('\n');
}

// ─── The turn engine (deps-injected, pure orchestration) ─────────────────────

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnEngineChatResult {
  content: string;
  latencyMs: number; // REAL measured provider round-trip (the seam measures it)
  model: string;
}

export interface TurnEngineDeps {
  chat: (
    messages: AgentChatMessage[],
    opts: { thinking: boolean; temperature: number },
  ) => Promise<TurnEngineChatResult>;
  executeTool: (
    ctx: { tenantId: string; sessionId: string; bodyTools: readonly string[]; twinId?: string | null },
    call: { tool: string; input: Record<string, unknown> },
  ) => Promise<AgentToolExecution>;
  /** epoch-ms clock (tests inject a fixed clock for event timestamps). */
  now: () => number;
  uuid: () => string;
  /**
   * P6.C7 EXTENSION (optional, backward-compatible — extend never break):
   * called with each performance event AS IT IS EMITTED (thinking → tool_use
   * → thinking → speaking), before the turn completes — the engine AWAITS it
   * so live pushes stay ordered (no read-modify-write races between events).
   * The live runtime uses this to stream agent states into bound live
   * sessions (the low-latency path). Absent/throwing callbacks never break
   * the turn (best-effort law).
   */
  onEvent?: (event: AgentPerformanceEvent) => void | Promise<void>;
}

export interface TurnEngineInput {
  tenantId: string;
  sessionId: string;
  twinId: string | null;
  body: {
    name: string;
    role: string;
    description?: string | null;
    version: number;
    tools: string[];
    manifest: AgentCapabilityManifest;
    twinVersionId?: string | null;
  };
  soul: {
    name: string;
    description?: string | null;
    version: number;
    persona: AgentSoulPersona;
    manifest: AgentCapabilityManifest;
    params: AgentSoulBehaviorParams;
    provider: string;
    model: string;
    twinDisplayName: string;
  };
  history: { role: 'user' | 'agent'; content: string }[];
  message: string;
  turnSeed: number;
}

export interface TurnEngineOutput {
  reply: string;
  events: AgentPerformanceEvent[]; // thinking → (tool_use) → thinking → speaking
  latencyMs: number; // sum of REAL measured provider round-trips
  model: string;
  llmCalls: number;
  tools: AgentToolExecution[];
  /** the reproducibility record: exactly what parameterized this request. */
  requestParams: { thinking: boolean; temperature: number; seed: number };
}

/**
 * Run ONE agent turn through the Soul. Mirrors lab/agent-turn.ts runAgentTurn
 * (same protocol, same event shapes) with the P6.C6 additions:
 * - the Soul manifest is enforced BEFORE any tool executes (server-side);
 * - the temperature derives deterministically from the turn seed when the
 *   Soul does not declare one;
 * - the request construction is fully recorded for reproducibility.
 *
 * The caller (durable job executor) wraps this in the resilience stack:
 * per-call retries + breaker live inside the chat seam (ai/zai.ts), the
 * job-level bounded retry + dead-letter live in core/jobs.ts runJob.
 */
export async function runAgentTurnEngine(deps: TurnEngineDeps, input: TurnEngineInput): Promise<TurnEngineOutput> {
  const thinking = input.soul.params.thinking ?? false;
  const temperature = input.soul.params.temperature ?? seededDefaultTemperature(input.turnSeed);

  const systemPrompt = compileAgentSystemPrompt({
    body: input.body,
    soul: input.soul,
    turnSeed: input.turnSeed,
    temperature,
    thinking,
  });

  const messages: AgentChatMessage[] = [
    { role: 'assistant', content: systemPrompt },
    ...input.history.map((h) => ({
      role: h.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: h.content,
    })),
    { role: 'user', content: input.message },
  ];

  const events: AgentPerformanceEvent[] = [];
  // P6.C7: broadcast each event as it is emitted (live streaming hook —
  // AWAITED so pushes stay ordered; best-effort: a throwing callback is
  // swallowed, the durable turn record is truth)
  const emit = async (event: AgentPerformanceEvent): Promise<void> => {
    events.push(event);
    if (deps.onEvent) {
      try {
        await deps.onEvent(event);
      } catch {
        /* best-effort law — the durable turn record is truth, not the live push */
      }
    }
  };
  const toolCtx = {
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    bodyTools: input.body.tools,
    ...(input.twinId !== null ? { twinId: input.twinId } : {}),
  };

  let llmCalls = 0;
  let totalLatencyMs = 0;
  let lastModel = 'unknown';

  const completion = await deps.chat(messages, { thinking, temperature });
  llmCalls += 1;
  totalLatencyMs += completion.latencyMs;
  lastModel = completion.model;

  await emit({
    eventId: deps.uuid(),
    sessionId: input.sessionId,
    type: 'thinking',
    timestamp: new Date(deps.now()).toISOString(),
    durationMs: completion.latencyMs, // real measured latency
    source: 'llm',
    payload: {
      soul: input.soul.name,
      soulVersion: input.soul.version,
      model: completion.model,
      messageChars: input.message.length,
      historyTurns: input.history.length,
      phase: 'reply-draft',
      turnSeed: input.turnSeed,
      thinking,
      temperature,
    },
  });

  let reply = completion.content;
  const toolExecutions: AgentToolExecution[] = [];

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const intent = parseToolCall(reply);
    if (!intent) break;

    // ── P6.C6 server-side capability enforcement (BEFORE any execution) ──
    const decision = decideToolInvocation(intent.tool, input.soul.manifest, input.body.tools, input.body.manifest);
    const execution: AgentToolExecution = decision.allowed
      ? await deps.executeTool(toolCtx, intent)
      : {
          tool: intent.tool,
          input: intent.input,
          executed: false,
          effect: null,
          result: null,
          durationMs: null,
          reason: decision.reason,
        };
    toolExecutions.push(execution);

    const resultJson = cappedJson(execution.result, 2400);
    await emit({
      eventId: deps.uuid(),
      sessionId: input.sessionId,
      type: 'tool_use',
      timestamp: new Date(deps.now()).toISOString(),
      durationMs: execution.durationMs, // real measured execution duration
      source: 'application',
      payload: {
        tool: execution.tool,
        executed: execution.executed,
        round,
        input: execution.input,
        effect: execution.effect,
        ...(decision.capability ? { capability: decision.capability } : {}),
        ...(decision.refusalKind ? { enforcement: decision.refusalKind } : {}),
        ...(execution.executed
          ? {
              result: resultJson.truncated
                ? `${resultJson.text} (truncated for the event record; full result was delivered to the model)`
                : resultJson.text,
              resultTruncated: resultJson.truncated,
            }
          : { result: null }),
        ...(execution.reason ? { reason: execution.reason } : {}),
        note: execution.executed
          ? 'tool executed by the runtime via internal service call (body contract + Soul capability manifest enforced server-side); result delivered to the Soul for the follow-up'
          : 'tool NOT executed — honest failure record (see reason)',
      },
    });

    // grounded follow-up LLM call with the REAL (or honestly refused) result
    messages.push({ role: 'assistant', content: reply }); // the raw tool request
    const isFinalRound = round === MAX_TOOL_ROUNDS;
    const followUpInstruction = isFinalRound
      ? 'This was the last tool round for this turn — produce your final answer for the user now. Be concise.'
      : 'If this result is sufficient, produce your final answer for the user now (concise, grounded in this result). If you genuinely need ONE more tool call to fulfill the user request, reply with the TOOL:/INPUT: format again.';
    messages.push({
      role: 'user',
      content: execution.executed
        ? `TOOL RESULT (executed by the runtime in ${execution.durationMs}ms; effect: ${execution.effect}): ${resultJson.text}\n\n${followUpInstruction}`
        : `TOOL RESULT: the tool was NOT executed (${execution.reason}). Do not pretend it ran. ${followUpInstruction}`,
    });
    const followUpStartedAt = deps.now();
    const followUp = await deps.chat(messages, { thinking, temperature });
    llmCalls += 1;
    totalLatencyMs += followUp.latencyMs;
    lastModel = followUp.model;
    reply = followUp.content;

    await emit({
      eventId: deps.uuid(),
      sessionId: input.sessionId,
      type: 'thinking',
      timestamp: new Date(followUpStartedAt).toISOString(),
      durationMs: followUp.latencyMs, // real measured latency
      source: 'llm',
      payload: {
        soul: input.soul.name,
        soulVersion: input.soul.version,
        model: followUp.model,
        phase: 'tool-followup',
        round,
        tool: execution.tool,
        toolExecuted: execution.executed,
      },
    });
  }

  await emit({
    eventId: deps.uuid(),
    sessionId: input.sessionId,
    type: 'speaking',
    timestamp: new Date(deps.now()).toISOString(),
    durationMs: null, // playback duration is modeled later by performance tracks, not measured here
    source: 'llm',
    payload: {
      soul: input.soul.name,
      soulVersion: input.soul.version,
      model: lastModel,
      chars: reply.length,
      toolCalls: toolExecutions.map((t) => t.tool),
      toolExecuted: toolExecutions.some((t) => t.executed),
      llmCalls,
      turnSeed: input.turnSeed,
    },
  });

  return {
    reply,
    events,
    latencyMs: totalLatencyMs,
    model: lastModel,
    llmCalls,
    tools: toolExecutions,
    requestParams: { thinking, temperature, seed: input.turnSeed },
  };
}

// ─── Client-facing view types (lane-owned; the Studio imports these type-only) ──

export interface AgentCapabilityManifestView {
  can: string[];
  cannot: string[];
}

export interface AgentRuntimeBodyView {
  id: string;
  name: string;
  role: string;
  description: string | null;
  /** visual/physical avatar assets binding (null = abstract Body). */
  twinVersionId: string | null;
  twinDisplayName: string | null;
  twinVersionNumber: number | null;
  version: number;
  status: AgentEntityStatus;
  tools: string[];
  manifest: AgentCapabilityManifestView;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSoulPersonaView {
  tagline?: string;
  traits: string[];
  speakingStyle?: string;
  additionalInstructions?: string;
}

export interface AgentRuntimeSoulView {
  id: string;
  name: string;
  description: string | null;
  /** a Soul is personality/behavior configuration bound to a Twin. */
  twinId: string;
  twinDisplayName: string;
  persona: AgentSoulPersonaView;
  provider: string;
  model: string;
  params: AgentSoulBehaviorParams;
  seed: number;
  version: number;
  status: AgentEntityStatus;
  manifest: AgentCapabilityManifestView;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeTurnView {
  id: string;
  role: 'user' | 'agent';
  content: string;
  states: AgentPerformanceEvent[];
  latencyMs: number | null;
  /** recorded per turn — the that parameterized the agent turn's request. */
  seed: number | null;
  /** model binding recorded on agent turns (provenance). */
  model: string | null;
  /** the durable agent.turn job driving this exchange (user turns). */
  jobId: string | null;
  /** honest job status join (queued|running|succeeded|failed|dead) — null when no job. */
  jobStatus: string | null;
  /** verbatim job error when the turn job failed/dead — null otherwise. */
  jobError: string | null;
  createdAt: string;
}

export interface AgentRuntimeSessionView {
  id: string;
  twinId: string;
  twinDisplayName: string;
  bodyId: string;
  bodyName: string;
  bodyVersion: number;
  soulId: string;
  soulName: string;
  soulVersion: number;
  /** consent provenance: the embodiment grant covering the bind (re-verified per turn). */
  consentGrantId: string | null;
  seed: number;
  status: 'live' | 'ended';
  turns: AgentRuntimeTurnView[];
  createdAt: string;
  endedAt: string | null;
}

/** List-shaped session view (no turns; turnCount for the history table). */
export interface AgentRuntimeSessionSummaryView {
  id: string;
  twinDisplayName: string;
  bodyId: string;
  bodyName: string;
  bodyVersion: number;
  soulId: string;
  soulName: string;
  soulVersion: number;
  consentGrantId: string | null;
  status: 'live' | 'ended';
  turnCount: number;
  createdAt: string;
  endedAt: string | null;
}
