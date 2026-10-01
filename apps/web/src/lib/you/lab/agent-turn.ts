// ═══════════════════════════════════════════════════════════════════════════
// Agent turn runtime — Worker C implementation (task 2-c).
// A chat turn is short-lived and runs synchronously inside the API route;
// every turn + emitted performance events are durably persisted by the caller
// (Worker A route). The Soul is an LLM binding (ADR-0002); the Body contract
// (role/capabilities/tools/memory/permissions) arrives pre-compiled as
// `bodySystemPrompt` and is appended with embodiment rules here.
//
// Honesty: latencyMs is the REAL measured provider round-trip; thinking
// events carry that measurement; tool_use events are emitted ONLY when the
// model explicitly signals tool intent (wave-1: tools are declared, never
// executed — the model may only MENTION intent).
// ═══════════════════════════════════════════════════════════════════════════
import type { AgentPerformanceEvent, AgentSoulView } from '../contracts';
import { chatComplete, type ZaiChatMessage } from '../ai/zai';

export interface AgentTurnInput {
  sessionId: string;
  bodySystemPrompt: string; // compiled from the Body contract by the caller
  soul: AgentSoulView;
  history: { role: 'user' | 'agent'; content: string }[];
  message: string;
}

export interface AgentTurnOutput {
  reply: string;
  events: AgentPerformanceEvent[]; // thinking → (tool_use) → speaking, with real latencies
  latencyMs: number;
  soulKey: string;
  model: string;
}

/** Embodiment rules appended to every Body contract (docs/ARCHITECTURE.md §8). */
const EMBODIMENT_RULES = `
Embodiment rules:
- You are embodied as an avatar. Be concise: reply in at most 120 words unless the user explicitly asks for more.
- Never claim to be a real human. Never claim to possess the identity of any person, including the person this avatar may represent.
- Tools are declared but not executed in this wave. You may MENTION that you intend to use a tool (e.g. begin the reply with "TOOL: knowledge_search" on its own first line) when a tool would genuinely help; the runtime turns an explicit signal like that into a tool_use performance event. Do not pretend a tool has already run.
- Stay within your role, capabilities and permissions from the body contract above.`.trim();

interface ToolIntent {
  detected: boolean;
  tool?: string;
}

/** Honest detector: only fires on explicit signals, never on vague references. */
function detectToolIntent(reply: string): ToolIntent {
  const prefix = /^\s*TOOL\s*:\s*([a-z_-]+)/i.exec(reply);
  if (prefix) return { detected: true, tool: prefix[1].toLowerCase() };
  const explicit =
    /\b(?:i\s+will|i'll|let\s+me|i\s+can|i\s+would\s+like\s+to)\s+(?:use|call|invoke|run|search(?:ing)?)\s+(?:the\s+)?(knowledge_search|search|tool)\b/i.exec(
      reply
    );
  if (explicit) return { detected: true, tool: explicit[1].toLowerCase() };
  return { detected: false };
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
  const startedAt = new Date();

  const messages: ZaiChatMessage[] = [
    { role: 'assistant', content: `${input.bodySystemPrompt}\n\n${EMBODIMENT_RULES}` },
    ...input.history.map((h) => ({ role: h.role === 'user' ? ('user' as const) : ('assistant' as const), content: h.content })),
    { role: 'user', content: input.message },
  ];

  // REAL provider latency, measured inside the wrapper; provider errors
  // surface verbatim (ZaiProviderError keeps the cause message).
  const completion = await chatComplete(messages, {
    thinking: input.soul.params.thinking ?? false,
    ...(input.soul.params.temperature !== undefined
      ? { temperature: input.soul.params.temperature }
      : {}),
  });

  const endedAt = new Date();
  const reply = completion.content;
  const events: AgentPerformanceEvent[] = [];

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
    },
  });

  const intent = detectToolIntent(reply);
  if (intent.detected) {
    events.push({
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      type: 'tool_use',
      timestamp: endedAt.toISOString(),
      durationMs: null,
      source: 'llm',
      payload: {
        tool: intent.tool ?? 'declared',
        executed: false, // wave-1: tools are declared, never executed
        note: 'explicit tool intent signaled by the model; no execution in wave-1',
      },
    });
  }

  events.push({
    eventId: crypto.randomUUID(),
    sessionId: input.sessionId,
    type: 'speaking',
    timestamp: endedAt.toISOString(),
    durationMs: null, // playback duration is modeled later by performance tracks, not measured here
    source: 'llm',
    payload: {
      soulKey: input.soul.soulKey,
      model: completion.model,
      chars: reply.length,
      toolIntent: intent.detected ? (intent.tool ?? 'declared') : false,
    },
  });

  return {
    reply,
    events,
    latencyMs: completion.latencyMs,
    soulKey: input.soul.soulKey,
    model: completion.model,
  };
}
