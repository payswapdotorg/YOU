// ═══════════════════════════════════════════════════════════════════════════
// Agent Body/Soul production runtime — the SERVER half (Worker C lane, P6.C6).
//
// Persistence + lifecycle (create/activate/deactivate/version with immutable
// snapshots) for Bodies (visual/physical avatar assets bound to a TwinVersion)
// and Souls (personality/behavior configuration bound to a Twin); session
// binding (Twin, Body, Soul) with consent provenance; durable turn execution
// (job kind 'agent.turn') through the EXISTING resilience stack:
//
//   - per-LLM-call: breaker-inside-retry inside ai/zai.ts chatComplete
//   - per-turn: the core/jobs.ts runner wraps this executor in withRetries
//     and dead-letters exhausted retryable failures (job.dead + structured
//     payload, visible via GET /api/v1/maintenance/dead-jobs)
//   - accept-time: the turns route gates on the 'zai' breaker (honest 503)
//
// Honesty laws:
// - consent is enforced at BOTH layers: session create AND every turn
//   (re-verified fail-closed inside the executor — revoked mid-session ends
//   the turn honestly, never silently);
// - the capability manifest is enforced server-side per tool invocation
//   (runtime-core decideToolInvocation) BEFORE any tool executes;
// - every event flows through the existing emitEvent seam (core/events.ts —
//   webhook fan-out included);
// - the executor persists the agent turn ONLY on full success (the
//   core/jobs.ts retry law: a failed attempt leaves no partial output).
//
// Model-binding honesty (disclosed): the Soul's provider/model are declared
// PROVENANCE. Wave-1 chat execution routes through the in-sandbox z-ai seam
// (ai/zai.ts chatComplete — thinking/temperature parameters); the C5 model
// registry governs vision/image/video routing and has no chat capability
// yet (its llama-3.3 entry is registered "for future chat-capability
// routing"). When the registry gains a chat capability, this seam routes
// through it without changing the Soul contract.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  AgentRuntimeBody,
  AgentRuntimeSession,
  AgentRuntimeSoul,
  AgentRuntimeTurn,
  Job,
  Twin,
  TwinVersion,
} from '@prisma/client';
import { db } from '@/lib/db';
import { requireConsent } from '../core/consent';
import { HttpError, badRequest, conflict, notFound } from '../core/errors';
import { emitEvent } from '../core/events';
import { assertProviderAvailable } from '../core/circuit-breaker';
import { parseJson } from '../core/views';
import { createJob } from '../core/jobs';
import { listAgentTools } from '../lab/agent-tools';
import {
  AGENT_TURN_JOB_KIND,
  AGENT_CAPABILITY_VOCABULARY,
  AgentRuntimeRefusal,
  agentRuntimeHttpSpec,
  capabilityForTool,
  compileAgentSystemPrompt,
  decideLifecycleTransition,
  decideSessionBinding,
  deriveSessionSeed,
  normalizeBehaviorParams,
  normalizeManifest,
  normalizePersona,
  parseEntityStatus,
  parseManifest,
  SOUL_PROVIDER_IDS,
  type AgentCapabilityManifest,
  type AgentEntityStatus,
  type AgentRuntimeBodyView,
  type AgentRuntimeSessionSummaryView,
  type AgentRuntimeSessionView,
  type AgentRuntimeSoulView,
  type AgentRuntimeTurnView,
  type AgentSoulBehaviorParams,
  type AgentSoulPersona,
} from './runtime-core';

// the durable agent.turn job kind (lane-local JobKind widening; the executor
// itself lives in lab/executors.ts — placed there to avoid the
// executors ↔ runtime ↔ jobs import cycle, same home as every other executor)
export { AGENT_TURN_JOB_KIND };


// ─── Typed-refusal → HTTP envelope ───────────────────────────────────────────

/** Translate a runtime-core typed refusal into the standard error envelope. */
export function toHttpError(err: unknown): HttpError {
  // pure mapping lives in runtime-core (unit-tested); HttpError instances and
  // unknown errors pass through untouched — the honest 500 path is handleRoute's
  const spec = agentRuntimeHttpSpec(err);
  if (spec) {
    return new HttpError(spec.status, spec.code, spec.message, spec.details, spec.headers);
  }
  throw err;
}

// ─── JSON helpers ────────────────────────────────────────────────────────────

function parseTools(json: string | null | undefined): string[] {
  const parsed = parseJson<string[]>(json ?? '[]', []);
  return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
}

function parsePersona(json: string | null | undefined): AgentSoulPersona {
  const p = parseJson<Record<string, unknown>>(json ?? '{}', {});
  return normalizePersona(p);
}

function parseParams(json: string | null | undefined): AgentSoulBehaviorParams {
  const p = parseJson<Record<string, unknown>>(json ?? '{}', {});
  const out: AgentSoulBehaviorParams = {};
  if (typeof p.thinking === 'boolean') out.thinking = p.thinking;
  if (typeof p.temperature === 'number' && Number.isFinite(p.temperature)) {
    out.temperature = p.temperature;
  }
  return out;
}

// ─── View mappers ────────────────────────────────────────────────────────────

export function runtimeBodyView(
  b: AgentRuntimeBody & { twinVersion?: (TwinVersion & { twin?: Twin | null }) | null },
): AgentRuntimeBodyView {
  return {
    id: b.id,
    name: b.name,
    role: b.role,
    description: b.description,
    twinVersionId: b.twinVersionId,
    twinDisplayName: b.twinVersion?.twin?.displayName ?? null,
    twinVersionNumber: b.twinVersion?.version ?? null,
    version: b.version,
    status: parseEntityStatus(b.status),
    tools: parseTools(b.tools),
    manifest: parseManifest(b.manifest),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

export function runtimeSoulView(
  s: AgentRuntimeSoul & { twin?: Twin | null },
): AgentRuntimeSoulView {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    twinId: s.twinId,
    twinDisplayName: s.twin?.displayName ?? '',
    persona: parsePersona(s.persona),
    provider: s.provider,
    model: s.model,
    params: parseParams(s.params),
    seed: s.seed,
    version: s.version,
    status: parseEntityStatus(s.status),
    manifest: parseManifest(s.manifest),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function runtimeTurnView(
  t: AgentRuntimeTurn,
  jobStatus: string | null = null,
  jobError: string | null = null,
): AgentRuntimeTurnView {
  return {
    id: t.id,
    role: t.role === 'agent' ? 'agent' : 'user',
    content: t.content,
    states: parseJson<AgentRuntimeTurnView['states']>(t.states, []),
    latencyMs: t.latencyMs,
    seed: t.seed,
    model: t.model,
    jobId: t.jobId,
    jobStatus,
    jobError,
    createdAt: t.createdAt.toISOString(),
  };
}

export function runtimeSessionView(
  s: AgentRuntimeSession & { twin?: Twin | null; body?: AgentRuntimeBody | null; soul?: AgentRuntimeSoul | null },
  turns: AgentRuntimeTurn[],
  jobsById: Map<string, Job> = new Map(),
): AgentRuntimeSessionView {
  return {
    id: s.id,
    twinId: s.twinId,
    twinDisplayName: s.twin?.displayName ?? '',
    bodyId: s.bodyId,
    bodyName: s.body?.name ?? '',
    bodyVersion: s.bodyVersion,
    soulId: s.soulId,
    soulName: s.soul?.name ?? '',
    soulVersion: s.soulVersion,
    consentGrantId: s.consentGrantId,
    seed: s.seed,
    status: s.status === 'ended' ? 'ended' : 'live',
    turns: turns.map((t) => {
      const job = t.jobId ? jobsById.get(t.jobId) : undefined;
      return runtimeTurnView(
        t,
        job?.status ?? null,
        job?.status === 'failed' || job?.status === 'dead' ? (job.error ?? null) : null,
      );
    }),
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
  };
}

export function runtimeSessionSummaryView(
  s: AgentRuntimeSession & { twin?: Twin | null; body?: AgentRuntimeBody | null; soul?: AgentRuntimeSoul | null; _count?: { turns?: number } },
): AgentRuntimeSessionSummaryView {
  return {
    id: s.id,
    twinDisplayName: s.twin?.displayName ?? '',
    bodyId: s.bodyId,
    bodyName: s.body?.name ?? '',
    bodyVersion: s.bodyVersion,
    soulId: s.soulId,
    soulName: s.soul?.name ?? '',
    soulVersion: s.soulVersion,
    consentGrantId: s.consentGrantId,
    status: s.status === 'ended' ? 'ended' : 'live',
    turnCount: s._count?.turns ?? 0,
    createdAt: s.createdAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
  };
}

// ─── Body persistence + lifecycle ────────────────────────────────────────────

export interface CreateRuntimeBodyInput {
  name: string;
  role: string;
  description?: string;
  /** optional twin binding — the twin's latest TwinVersion is resolved server-side. */
  twinId?: string;
  tools?: string[];
  capabilities?: string[];
}

/** Validate the tool allow-list against the W2.C registry + capability mirror (honest 400s). */
function validateBodyTools(tools: string[], manifest: AgentCapabilityManifest): void {
  const registry = listAgentTools();
  for (const tool of tools) {
    if (!registry.includes(tool)) {
      throw new AgentRuntimeRefusal(
        400,
        'validation_failed',
        `unknown tool "${tool}" — the W2.C agent tool registry has: ${registry.join(', ')}`,
        { registry },
      );
    }
    const capability = capabilityForTool(tool);
    if (!capability) {
      throw new AgentRuntimeRefusal(
        400,
        'validation_failed',
        `tool "${tool}" has no capability mapping in the runtime mirror (known: ${Object.keys({ 'twins.list': 1, knowledge_search: 1, 'evidence.request': 1 }).join(', ')})`,
      );
    }
    if (!manifest.can.includes(capability)) {
      throw new AgentRuntimeRefusal(
        400,
        'validation_failed',
        `tool "${tool}" requires capability "${capability}" which this Body's manifest does not declare (can: ${manifest.can.join(', ') || 'none'}) — declare the capability or drop the tool`,
        { tool, capability, can: manifest.can },
      );
    }
  }
}

interface BodySnapshot {
  name: string;
  role: string;
  description: string | null;
  twinVersionId: string | null;
  tools: string[];
  manifest: AgentCapabilityManifest;
}

function bodySnapshot(b: AgentRuntimeBody): BodySnapshot {
  return {
    name: b.name,
    role: b.role,
    description: b.description,
    twinVersionId: b.twinVersionId,
    tools: parseTools(b.tools),
    manifest: parseManifest(b.manifest),
  };
}

async function appendBodyVersion(bodyId: string, version: number, snapshot: BodySnapshot): Promise<void> {
  await db.agentRuntimeBodyVersion.create({
    data: { bodyId, version, snapshot: JSON.stringify(snapshot) },
  });
}

export async function createRuntimeBody(tenantId: string, input: CreateRuntimeBodyInput): Promise<AgentRuntimeBodyView> {
  const manifest = normalizeManifest(input.capabilities); // typed 400 on unknown tokens
  const tools = (input.tools ?? []).map((t) => t.trim()).filter(Boolean);
  validateBodyTools(tools, manifest);

  let twinVersionId: string | null = null;
  let latest: TwinVersion | null = null;
  let twin: Twin | null = null;
  if (input.twinId) {
    twin = await db.twin.findFirst({ where: { id: input.twinId, tenantId } });
    if (!twin) throw notFound(`twin "${input.twinId}" not found`);
    latest = await db.twinVersion.findFirst({ where: { twinId: twin.id }, orderBy: { version: 'desc' } });
    if (!latest) {
      throw conflict(
        `twin "${twin.displayName}" has no TwinVersion to bind — compile or reconstruct the twin first (a Body binds visual/physical avatar assets to a concrete TwinVersion)`,
      );
    }
    twinVersionId = latest.id;
  }

  const body = await db.agentRuntimeBody.create({
    data: {
      tenantId,
      name: input.name,
      role: input.role,
      description: input.description ?? null,
      twinVersionId,
      version: 1,
      status: 'draft',
      tools: JSON.stringify(tools),
      manifest: JSON.stringify(manifest),
    },
  });
  await appendBodyVersion(body.id, 1, bodySnapshot(body));

  await emitEvent(tenantId, 'agent.body.created', 'agent_runtime_body', body.id, {
    bodyId: body.id,
    name: body.name,
    role: body.role,
    version: 1,
    twinVersionId,
  });
  // build the view from the rows we already hold (no refetch race)
  return runtimeBodyView({ ...body, ...(latest ? { twinVersion: { ...latest, twin } } : {}) });
}

export interface UpdateRuntimeBodyInput {
  action?: 'activate' | 'deactivate';
  name?: string;
  role?: string;
  description?: string | null;
  twinId?: string | null;
  tools?: string[];
  capabilities?: string[];
}

export async function updateRuntimeBody(
  tenantId: string,
  bodyId: string,
  input: UpdateRuntimeBodyInput,
): Promise<AgentRuntimeBodyView> {
  const body = await db.agentRuntimeBody.findFirst({
    where: { id: bodyId, tenantId },
    include: { twinVersion: { include: { twin: true } } },
  });
  if (!body) throw notFound(`agent body "${bodyId}" not found`);

  const hasDefinitionFields =
    input.name !== undefined ||
    input.role !== undefined ||
    input.description !== undefined ||
    input.twinId !== undefined ||
    input.tools !== undefined ||
    input.capabilities !== undefined;

  if (input.action && hasDefinitionFields) {
    throw badRequest('action and definition fields are mutually exclusive — send a lifecycle action OR a definition update');
  }
  if (!input.action && !hasDefinitionFields) {
    throw badRequest('nothing to update — send { action: "activate" | "deactivate" } or definition fields');
  }

  if (input.action) {
    const decision = decideLifecycleTransition(parseEntityStatus(body.status), input.action);
    if (!decision.ok) throw toHttpError(decision.refusal);
    const updated = await db.agentRuntimeBody.update({
      where: { id: body.id },
      data: { status: decision.next },
    });
    await emitEvent(tenantId, `agent.body.${decision.next === 'active' ? 'activated' : 'deactivated'}`, 'agent_runtime_body', body.id, {
      bodyId: body.id,
      from: body.status,
      to: decision.next,
      version: body.version,
    });
    return runtimeBodyView({ ...updated, twinVersion: body.twinVersion });
  }

  // definition update → new immutable version snapshot
  const nextName = input.name !== undefined ? input.name : body.name;
  const nextRole = input.role !== undefined ? input.role : body.role;
  const nextDescription =
    input.description !== undefined ? input.description : body.description;
  const nextTools = input.tools !== undefined ? input.tools.map((t) => t.trim()).filter(Boolean) : parseTools(body.tools);
  const nextManifest =
    input.capabilities !== undefined ? normalizeManifest(input.capabilities) : parseManifest(body.manifest);
  validateBodyTools(nextTools, nextManifest);

  let nextTwinVersionId = body.twinVersionId;
  let nextTwinVersion = body.twinVersion; // (TwinVersion & { twin }) | null from the initial include
  if (input.twinId !== undefined) {
    if (input.twinId === null) {
      nextTwinVersionId = null; // explicit unbinding
      nextTwinVersion = null;
    } else {
      const twin = await db.twin.findFirst({ where: { id: input.twinId, tenantId } });
      if (!twin) throw notFound(`twin "${input.twinId}" not found`);
      const latest = await db.twinVersion.findFirst({ where: { twinId: twin.id }, orderBy: { version: 'desc' } });
      if (!latest) {
        throw conflict(
          `twin "${twin.displayName}" has no TwinVersion to bind — compile or reconstruct the twin first`,
        );
      }
      nextTwinVersionId = latest.id;
      nextTwinVersion = { ...latest, twin };
    }
  }

  const nextVersion = body.version + 1;
  const updated = await db.agentRuntimeBody.update({
    where: { id: body.id },
    data: {
      name: nextName,
      role: nextRole,
      description: nextDescription,
      twinVersionId: nextTwinVersionId,
      tools: JSON.stringify(nextTools),
      manifest: JSON.stringify(nextManifest),
      version: nextVersion,
    },
  });
  await appendBodyVersion(updated.id, nextVersion, bodySnapshot(updated));
  await emitEvent(tenantId, 'agent.body.versioned', 'agent_runtime_body', body.id, {
    bodyId: body.id,
    fromVersion: body.version,
    toVersion: nextVersion,
  });
  return runtimeBodyView({ ...updated, twinVersion: nextTwinVersion });
}

// ─── Soul persistence + lifecycle ────────────────────────────────────────────

export interface CreateRuntimeSoulInput {
  name: string;
  description?: string;
  twinId: string; // a Soul is personality bound to a Twin (required)
  persona?: Record<string, unknown>;
  provider?: string;
  model: string;
  params?: Record<string, unknown>;
  capabilities?: string[];
}

interface SoulSnapshot {
  name: string;
  description: string | null;
  twinId: string;
  persona: AgentSoulPersona;
  provider: string;
  model: string;
  params: AgentSoulBehaviorParams;
  manifest: AgentCapabilityManifest;
  seed: number;
}

function soulSnapshot(s: AgentRuntimeSoul): SoulSnapshot {
  return {
    name: s.name,
    description: s.description,
    twinId: s.twinId,
    persona: parsePersona(s.persona),
    provider: s.provider,
    model: s.model,
    params: parseParams(s.params),
    manifest: parseManifest(s.manifest),
    seed: s.seed,
  };
}

async function appendSoulVersion(soulId: string, version: number, snapshot: SoulSnapshot): Promise<void> {
  await db.agentRuntimeSoulVersion.create({
    data: { soulId, version, snapshot: JSON.stringify(snapshot) },
  });
}

export async function createRuntimeSoul(tenantId: string, input: CreateRuntimeSoulInput): Promise<AgentRuntimeSoulView> {
  const manifest = normalizeManifest(input.capabilities);
  const persona = normalizePersona(input.persona);
  const params = normalizeBehaviorParams(input.params); // typed 400 on bad temperature
  const provider = (input.provider ?? 'zai').trim().toLowerCase();
  if (!(SOUL_PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw badRequest(
      `provider "${provider}" has no chat adapter in wave-1 (available: ${SOUL_PROVIDER_IDS.join(', ')}) — the C5 model registry has no chat capability yet; chat execution routes through the zai seam`,
    );
  }
  const twin = await db.twin.findFirst({ where: { id: input.twinId, tenantId } });
  if (!twin) throw notFound(`twin "${input.twinId}" not found`);

  const createdAt = new Date();
  // deterministic in its recorded inputs (tenant/twin/name/creation instant)
  const seed = deriveSessionSeed(tenantId, input.twinId, input.name, createdAt.toISOString());

  const soul = await db.agentRuntimeSoul.create({
    data: {
      tenantId,
      name: input.name,
      description: input.description ?? null,
      twinId: twin.id,
      persona: JSON.stringify(persona),
      provider,
      model: input.model,
      params: JSON.stringify(params),
      seed,
      version: 1,
      status: 'draft',
      manifest: JSON.stringify(manifest),
    },
  });
  await appendSoulVersion(soul.id, 1, soulSnapshot(soul));
  await emitEvent(tenantId, 'agent.soul.created', 'agent_runtime_soul', soul.id, {
    soulId: soul.id,
    name: soul.name,
    twinId: twin.id,
    version: 1,
    seed,
  });
  return runtimeSoulView({ ...soul, twin });
}

export interface UpdateRuntimeSoulInput {
  action?: 'activate' | 'deactivate';
  name?: string;
  description?: string | null;
  persona?: Record<string, unknown>;
  params?: Record<string, unknown>;
  capabilities?: string[];
}

export async function updateRuntimeSoul(
  tenantId: string,
  soulId: string,
  input: UpdateRuntimeSoulInput,
): Promise<AgentRuntimeSoulView> {
  const soul = await db.agentRuntimeSoul.findFirst({
    where: { id: soulId, tenantId },
    include: { twin: true },
  });
  if (!soul) throw notFound(`agent soul "${soulId}" not found`);

  const hasDefinitionFields =
    input.name !== undefined ||
    input.description !== undefined ||
    input.persona !== undefined ||
    input.params !== undefined ||
    input.capabilities !== undefined;

  if (input.action && hasDefinitionFields) {
    throw badRequest('action and definition fields are mutually exclusive — send a lifecycle action OR a definition update');
  }
  if (!input.action && !hasDefinitionFields) {
    throw badRequest('nothing to update — send { action: "activate" | "deactivate" } or definition fields');
  }

  if (input.action) {
    const decision = decideLifecycleTransition(parseEntityStatus(soul.status), input.action);
    if (!decision.ok) throw toHttpError(decision.refusal);
    const updated = await db.agentRuntimeSoul.update({
      where: { id: soul.id },
      data: { status: decision.next },
    });
    await emitEvent(tenantId, `agent.soul.${decision.next === 'active' ? 'activated' : 'deactivated'}`, 'agent_runtime_soul', soul.id, {
      soulId: soul.id,
      from: soul.status,
      to: decision.next,
      version: soul.version,
    });
    return runtimeSoulView({ ...updated, twin: soul.twin });
  }

  // definition update → new immutable version snapshot.
  // NOTE: twinId, provider, model and seed are IMMUTABLE after create —
  // rebinding a Soul to another twin/person is a NEW Soul (identity law), and
  // mutating the seed would break reproducibility of past turns.
  const nextName = input.name !== undefined ? input.name : soul.name;
  const nextDescription = input.description !== undefined ? input.description : soul.description;
  const nextPersona = input.persona !== undefined ? normalizePersona(input.persona) : parsePersona(soul.persona);
  const nextParams = input.params !== undefined ? normalizeBehaviorParams(input.params) : parseParams(soul.params);
  const nextManifest =
    input.capabilities !== undefined ? normalizeManifest(input.capabilities) : parseManifest(soul.manifest);

  const nextVersion = soul.version + 1;
  const updated = await db.agentRuntimeSoul.update({
    where: { id: soul.id },
    data: {
      name: nextName,
      description: nextDescription,
      persona: JSON.stringify(nextPersona),
      params: JSON.stringify(nextParams),
      manifest: JSON.stringify(nextManifest),
      version: nextVersion,
    },
  });
  await appendSoulVersion(updated.id, nextVersion, soulSnapshot(updated));
  await emitEvent(tenantId, 'agent.soul.versioned', 'agent_runtime_soul', soul.id, {
    soulId: soul.id,
    fromVersion: soul.version,
    toVersion: nextVersion,
  });
  return runtimeSoulView({ ...updated, twin: soul.twin });
}

// ─── Session runtime ─────────────────────────────────────────────────────────

export async function createRuntimeSession(
  tenantId: string,
  input: { bodyId: string; soulId: string },
): Promise<AgentRuntimeSessionView> {
  const body = await db.agentRuntimeBody.findFirst({
    where: { id: input.bodyId, tenantId },
    include: { twinVersion: { include: { twin: true } } },
  });
  if (!body) throw notFound(`agent body "${input.bodyId}" not found`);
  const soul = await db.agentRuntimeSoul.findFirst({
    where: { id: input.soulId, tenantId },
    include: { twin: true },
  });
  if (!soul) throw notFound(`agent soul "${input.soulId}" not found`);

  // binding law (typed refusals: 409 lifecycle / 403 policy / 409 binding conflict)
  const binding = decideSessionBinding({
    body: {
      id: body.id,
      name: body.name,
      status: parseEntityStatus(body.status),
      twinVersionId: body.twinVersionId,
      manifest: parseManifest(body.manifest),
    },
    soul: {
      id: soul.id,
      name: soul.name,
      status: parseEntityStatus(soul.status),
      twinId: soul.twinId,
      manifest: parseManifest(soul.manifest),
    },
    twinOfBodyVersion: body.twinVersion?.twinId ?? null,
  });
  if (!binding.ok) throw toHttpError(binding.refusal);

  // consent is explicit, scoped and server-enforced (embodiment scope)
  const twin = soul.twin;
  const grant = await requireConsent(tenantId, twin.subjectId, 'embodiment');

  const createdAt = new Date();
  const seed = deriveSessionSeed(tenantId, soul.id, body.id, createdAt.toISOString());
  const session = await db.agentRuntimeSession.create({
    data: {
      tenantId,
      twinId: twin.id,
      bodyId: body.id,
      bodyVersion: body.version,
      soulId: soul.id,
      soulVersion: soul.version,
      consentGrantId: grant.id,
      seed,
      status: 'live',
    },
  });

  await emitEvent(tenantId, 'agent.session.started', 'agent_runtime_session', session.id, {
    sessionId: session.id,
    twinId: twin.id,
    bodyId: body.id,
    bodyVersion: body.version,
    soulId: soul.id,
    soulVersion: soul.version,
    consentGrantId: grant.id,
    seed,
  });

  return runtimeSessionView(
    { ...session, twin: soul.twin, body, soul: { ...soul } },
    [],
  );
}

/** Explicit teardown: live → ended (+ event only on the actual transition). */
export async function endRuntimeSession(tenantId: string, sessionId: string): Promise<void> {
  const session = await db.agentRuntimeSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) throw notFound(`agent session "${sessionId}" not found`);
  if (session.status === 'ended') return; // idempotent teardown — honest 204
  const endedAt = new Date();
  await db.agentRuntimeSession.update({ where: { id: session.id }, data: { status: 'ended', endedAt } });
  await emitEvent(tenantId, 'agent.session.ended', 'agent_runtime_session', session.id, {
    sessionId: session.id,
    endedAt: endedAt.toISOString(),
    turns: await db.agentRuntimeTurn.count({ where: { sessionId: session.id } }),
  });
}

// ─── Turn submission (durable agent.turn job) ────────────────────────────────

export interface SubmitTurnResult {
  jobId: string;
  turn: AgentRuntimeTurnView;
  replayed: boolean; // true when the idempotency key returned an existing job
}

export async function submitRuntimeTurn(
  tenantId: string,
  sessionId: string,
  message: string,
  idempotencyKey?: string,
): Promise<SubmitTurnResult> {
  // accept-time breaker admission — honest 503 with retry guidance
  assertProviderAvailable('zai');

  const session = await db.agentRuntimeSession.findFirst({ where: { id: sessionId, tenantId } });
  if (!session) throw notFound(`agent session "${sessionId}" not found`);
  if (session.status !== 'live') {
    throw conflict(`agent session "${sessionId}" has ended — start a new session to continue`);
  }

  // consent re-verified at submit time too (fail-closed; the executor
  // re-verifies again — revoked consent never silently runs a turn)
  const twin = await db.twin.findFirst({ where: { id: session.twinId, tenantId } });
  if (!twin) throw notFound(`twin "${session.twinId}" not found`);
  await requireConsent(tenantId, twin.subjectId, 'embodiment');

  // idempotent replay: an existing job under the same key returns its turn
  if (idempotencyKey) {
    const existing = await db.job.findUnique({ where: { idempotencyKey } });
    if (existing && existing.kind === AGENT_TURN_JOB_KIND) {
      const input = parseJson<{ userTurnId?: string }>(existing.input, {});
      if (input.userTurnId) {
        const turn = await db.agentRuntimeTurn.findUnique({ where: { id: input.userTurnId } });
        if (turn) {
          return { jobId: existing.id, turn: runtimeTurnView(turn, existing.status, existing.error ?? null), replayed: true };
        }
      }
    }
  }

  const userTurn = await db.agentRuntimeTurn.create({
    data: { sessionId: session.id, role: 'user', content: message },
  });

  const job = await createJob(
    tenantId,
    AGENT_TURN_JOB_KIND,
    { sessionId: session.id, userTurnId: userTurn.id, message },
    idempotencyKey,
  );
  await db.agentRuntimeTurn.update({ where: { id: userTurn.id }, data: { jobId: job.id } }).catch(() => undefined);

  await emitEvent(tenantId, 'agent.turn.submitted', 'agent_runtime_session', session.id, {
    sessionId: session.id,
    turnId: userTurn.id,
    jobId: job.id,
  });

  const refreshed = await db.agentRuntimeTurn.findUnique({ where: { id: userTurn.id } });
  return { jobId: job.id, turn: runtimeTurnView(refreshed ?? userTurn), replayed: false };
}

// Compile-time guard: the system-prompt compiler stays wired to the same
// snapshot shapes the executor feeds it (drift breaks the build, not prod).
export type { AgentCapabilityManifest, AgentEntityStatus };
export { compileAgentSystemPrompt, AGENT_CAPABILITY_VOCABULARY };
