// ═══════════════════════════════════════════════════════════════════════════
// Agent turn protocol — the pure, zero-import half of the chat-turn runtime
// (Worker C lane; extracted from lab/agent-turn.ts for P6.C6 so the new
// Body/Soul production runtime shares the EXACT tool-call protocol and
// embodiment rules instead of duplicating them).
//
// ZERO-IMPORT MODULE (erasable TS only — the single import is `import type`,
// erased at runtime): imported directly by node:test unit suites under
// Node >= 23.6 type stripping. App callers import it via
// '@/lib/you/lab/agent-turn-protocol'.
//
// Protocol law (unchanged from W2.C — behavior-preserving extraction):
// - the model signals a tool call with the explicit `TOOL: <name>` protocol
//   line — the honest parser never fires on vague references;
// - the runtime executes ONLY tools the server-side contracts allow;
// - tool results are delivered verbatim to the model in a grounded follow-up
//   call so the reply reflects reality, not invention.
// ═══════════════════════════════════════════════════════════════════════════
import type { AgentToolExecution } from './agent-tools';

export interface ToolIntent {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Honest parser: only fires on the explicit `TOOL:` protocol line — never on
 * vague references. Tolerates preamble/prose around the signal (models often
 * add a sentence before the request); the signal line itself must be exact.
 * Accepts `INPUT: {json}` on the following line(s) or a fenced/braced block.
 */
export function parseToolCall(reply: string): ToolIntent | null {
  const lines = reply.split('\n').map((l) => l.trim());
  let toolLineIdx = -1;
  let tool = '';
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^TOOL\s*:\s*([a-zA-Z0-9_.-]+)\s*$/i.exec(lines[i]);
    if (match) {
      toolLineIdx = i;
      tool = match[1].toLowerCase();
      break;
    }
  }
  if (toolLineIdx === -1) return null;

  // INPUT: {…} on a following line…
  let rawJson: string | null = null;
  let inputIdx = -1;
  for (let i = toolLineIdx + 1; i < lines.length; i += 1) {
    if (/^INPUT\s*:/i.test(lines[i])) {
      inputIdx = i;
      break;
    }
  }
  if (inputIdx !== -1) {
    rawJson = lines[inputIdx].replace(/^INPUT\s*:\s*/i, '').trim();
  } else {
    // …or the first fenced/braced JSON object after the TOOL line
    const after = lines.slice(toolLineIdx + 1).join('\n');
    const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(after);
    const braced = /\{[\s\S]*?\}/.exec(after);
    const match = fenced ?? braced;
    if (match) rawJson = match[1] ?? (match[0] as string);
  }
  if (!rawJson) return { tool, input: {} };
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { tool, input: parsed as Record<string, unknown> };
    }
  } catch {
    /* fall through: malformed input → empty input; the tool will validate */
  }
  return { tool, input: {} };
}

/** Embodiment rules appended to every Body contract (docs/ARCHITECTURE.md §8). */
export const EMBODIMENT_RULES = `
Embodiment rules:
- You are embodied as an avatar. Be concise: reply in at most 120 words unless the user explicitly asks for more.
- Never claim to be a real human. Never claim to possess the identity of any person, including the person this avatar may represent.
- Tools ARE executable in this runtime, but ONLY the tools declared in your body contract above. Request a tool call in exactly this format (the whole reply, nothing else):
TOOL: <tool-name>
INPUT: <single-line JSON object with the tool's input>
- The runtime executes the tool and returns the real result to you; you may chain at most TWO tool calls per turn — after each result, either answer the user or request the next tool in the same format.
- Never fabricate or imply a tool result you did not receive. If the runtime reports a tool as unavailable or failed, say so honestly and answer from your own knowledge.
- Known tool input shapes (use EXACT field names and exact ids — display names are not ids):
  twins.list → {"limit": 10, "query": "optional name filter"}
  evidence.request → {"twinId": "<exact twin id, e.g. from twins.list>", "capability": "hands | face.profile | hair.back | teeth | speech | silhouette.front", "reason": "optional"}
  knowledge_search → {"query": "search text"}
- Stay within your role, capabilities and permissions from the body contract above.`.trim();

/** JSON.stringify with a hard cap so event payloads stay bounded. */
export function cappedJson(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > maxChars
    ? { text: `${text.slice(0, maxChars)}…`, truncated: true }
    : { text, truncated: false };
}

/** Bounded tool rounds per turn (each round = execute + one grounded LLM call). */
export const MAX_TOOL_ROUNDS = 2;

/** Type re-export so protocol consumers share the execution record shape. */
export type { AgentToolExecution };
