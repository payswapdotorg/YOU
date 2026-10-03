// ═══════════════════════════════════════════════════════════════════════════
// Agent turn runtime — Worker C implementation (task 2-c; W2.C upgrade).
// A chat turn is short-lived and runs synchronously inside the API route;
// every turn + emitted performance events are durably persisted by the caller
// (Worker A route). The Soul is an LLM binding (ADR-0002); the Body contract
// (role/capabilities/tools/memory/permissions) arrives pre-compiled as
// `bodySystemPrompt` and is appended with embodiment rules here.
//
// W2.C — REAL TOOL EXECUTION (was: wave-1 declared-but-never-executed):
// - the body's declared tools are now EXECUTED via internal service calls
//   (lab/agent-tools.ts: twins.list, evidence.request, knowledge_search);
// - the model signals a tool call with the `TOOL: <name>` protocol below;
//   the runtime parses it, executes through the registry (server-enforced
//   body-contract allow-list), then makes a SECOND grounded LLM call with the
//   verbatim tool result so the final reply reflects reality, not invention;
// - tool_use performance events carry input/effect/result/durationMs with
//   executed: true — or an honest executed: false + reason when the tool is
//   unknown, undeclared by the body, or the execution failed;
// - one tool round per turn (bounded latency), disclosed in the rules.
//
// Honesty: latencyMs is the REAL measured provider round-trip (sum over the
// turn's LLM calls); thinking events carry each measured call latency; tool
// execution durations are measured; nothing is fabricated.
// ═══════════════════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import type { AgentPerformanceEvent, AgentSoulView } from '../contracts';
import { chatComplete, type ZaiChatMessage } from '../ai/zai';
import { executeAgentTool, type AgentToolExecution } from './agent-tools';
// P6.C6: the tool-call protocol, embodiment rules, bounded round budget and
// capped-JSON helper were extracted VERBATIM into the zero-import protocol
// module (lab/agent-turn-protocol.ts) so the Body/Soul production runtime
// (lib/you/agent/) shares the exact same protocol. Behavior-preserving.
import {
  EMBODIMENT_RULES,
  MAX_TOOL_ROUNDS,
  cappedJson,
  parseToolCall,
  type ToolIntent,
} from './agent-turn-protocol';

export { EMBODIMENT_RULES, MAX_TOOL_ROUNDS, cappedJson, parseToolCall } from './agent-turn-protocol';
export type { ToolIntent } from './agent-turn-protocol';

export interface AgentTurnInput {
  sessionId: string;
  bodySystemPrompt: string; // compiled from the Body contract by the caller
  soul: AgentSoulView;
  history: { role: 'user' | 'agent'; content: string }[];
  message: string;
}

export interface AgentTurnOutput {
  reply: string;
  events: AgentPerformanceEvent[]; // thinking → (tool_use EXECUTED) → thinking → speaking
  latencyMs: number; // real measured provider round-trips, summed over the turn's LLM calls
  soulKey: string;
  model: string;
  /** number of real provider calls made in this turn (1 without tools, 2 with) */
  llmCalls: number;
  /** tool executions attempted this turn (honest record, incl. failures) */
  tools?: AgentToolExecution[];
}

/** Load the server-side tool context (body contract + tenant) for a session. */
async function loadToolContext(
  sessionId: string
): Promise<{ tenantId: string; sessionId: string; bodyTools: string[]; twinId: string | null } | null> {
  const session = await db.agentAvatarSession.findUnique({
    where: { id: sessionId },
    include: { body: true },
  });
  if (!session) return null;
  let bodyTools: string[] = [];
  try {
    const parsed = JSON.parse(session.body.tools ?? '[]') as unknown;
    if (Array.isArray(parsed)) bodyTools = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    bodyTools = [];
  }
  return {
    tenantId: session.tenantId,
    sessionId: session.id,
    bodyTools,
    twinId: session.twinId,
  };
}


export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const startedAt = new Date();

  // server-side tool context — session lookup gives tenant + body contract
  const toolCtx = await loadToolContext(input.sessionId);

  const messages: ZaiChatMessage[] = [
    { role: 'assistant', content: `${input.bodySystemPrompt}\n\n${EMBODIMENT_RULES}` },
    ...input.history.map((h) => ({ role: h.role === 'user' ? ('user' as const) : ('assistant' as const), content: h.content })),
    { role: 'user', content: input.message },
  ];

  // REAL provider latency, measured inside the wrapper; provider errors
  // surface verbatim (ZaiProviderError keeps the cause message).
  const events: AgentPerformanceEvent[] = [];
  let llmCalls = 0;
  let totalProviderLatencyMs = 0;
  let lastModel = 'unknown';

  const completion = await chatComplete(messages, {
    thinking: input.soul.params.thinking ?? false,
    ...(input.soul.params.temperature !== undefined
      ? { temperature: input.soul.params.temperature }
      : {}),
  });
  llmCalls += 1;
  totalProviderLatencyMs += completion.latencyMs;
  lastModel = completion.model;

  events.push({
    eventId: crypto.randomUUID(),
    sessionId: input.sessionId,
    type: 'thinking',
    timestamp: startedAt.toISOString(),
    durationMs: completion.latencyMs, // real measured latency
    source: 'llm',
    payload: {
      soulKey: input.soul.soulKey,
      model: completion.model,
      messageChars: input.message.length,
      historyTurns: input.history.length,
      phase: 'reply-draft',
    },
  });

  let reply = completion.content;
  const toolExecutions: AgentToolExecution[] = [];

  // ── W2.C: execute declared tools when the model signals them ──────────────
  // Bounded agentic loop: up to MAX_TOOL_ROUNDS tool calls per turn (each
  // round = execute → grounded follow-up LLM call). The model may chain tools
  // (e.g. twins.list → evidence.request); the loop ends when the follow-up is
  // a plain answer or the round budget is exhausted.
  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const intent = parseToolCall(reply);
    if (!intent) break;

    const execution =
      toolCtx === null
        ? {
            tool: intent.tool,
            input: intent.input,
            executed: false,
            effect: null,
            result: null,
            durationMs: null as number | null,
            reason: `session ${input.sessionId} not found — no server-side tool context; intent recorded, nothing executed`,
          }
        : await executeAgentTool(toolCtx, intent);
    toolExecutions.push(execution);

    const resultJson = cappedJson(execution.result, 2400);
    events.push({
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      type: 'tool_use',
      timestamp: new Date().toISOString(),
      durationMs: execution.durationMs, // real measured execution duration
      source: 'application',
      payload: {
        tool: execution.tool,
        executed: execution.executed,
        round,
        input: execution.input,
        effect: execution.effect,
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
          ? 'tool executed by the runtime via internal service call (server-enforced body-contract allow-list); result delivered to the Soul for the follow-up'
          : 'tool NOT executed — honest failure record (see reason)',
      },
    });

    // grounded follow-up LLM call: the model answers with the REAL tool result
    // (on non-final rounds it may request one more tool in the same format)
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
    const followUpStarted = new Date();
    const followUp = await chatComplete(messages, {
      thinking: input.soul.params.thinking ?? false,
      ...(input.soul.params.temperature !== undefined
        ? { temperature: input.soul.params.temperature }
        : {}),
    });
    llmCalls += 1;
    totalProviderLatencyMs += followUp.latencyMs;
    lastModel = followUp.model;
    reply = followUp.content;

    events.push({
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      type: 'thinking',
      timestamp: followUpStarted.toISOString(),
      durationMs: followUp.latencyMs, // real measured latency
      source: 'llm',
      payload: {
        soulKey: input.soul.soulKey,
        model: followUp.model,
        phase: 'tool-followup',
        round,
        tool: execution.tool,
        toolExecuted: execution.executed,
      },
    });
  }

  events.push({
    eventId: crypto.randomUUID(),
    sessionId: input.sessionId,
    type: 'speaking',
    timestamp: new Date().toISOString(),
    durationMs: null, // playback duration is modeled later by performance tracks, not measured here
    source: 'llm',
    payload: {
      soulKey: input.soul.soulKey,
      model: lastModel,
      chars: reply.length,
      toolCalls: toolExecutions.map((t) => t.tool),
      toolExecuted: toolExecutions.some((t) => t.executed),
      llmCalls,
    },
  });

  return {
    reply,
    events,
    latencyMs: totalProviderLatencyMs,
    soulKey: input.soul.soulKey,
    model: lastModel,
    llmCalls,
    ...(toolExecutions.length > 0 ? { tools: toolExecutions } : {}),
  };
}
