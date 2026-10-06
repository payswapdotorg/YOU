// ═══════════════════════════════════════════════════════════════════════════
// Supervised evaluators (Worker C lane, P6.C10) — the learning ladder's
// second stage. The LabObjective.gates JSON drives verdicts:
//   - { min } / { max } / { required } are MACHINE-CHECKED against the
//     mapped report metric;
//   - descriptive STRINGS are human gates — verdict 'manual', never
//     auto-pass;
//   - unknown gate names and garbage shapes are HONEST failures (refusing
//     to guess beats fabricating a verdict);
//   - a manual-only objective cannot machine-validate (validated requires
//     at least one machine gate to pass).
// latencyMs deliberately stays a HUMAN gate: it embeds the real grounding
// measurement (the W2.C call) — a machine gate on it would be
// non-deterministic.
// PURE + zero-import (node:test-importable).
// ═══════════════════════════════════════════════════════════════════════════

export type GateVerdict = 'pass' | 'fail' | 'manual';

export interface GateCheck {
  gate: string;
  verdict: GateVerdict;
  note: string | null;
  actual: number | boolean | string | null;
}

/** The report facts a gate verdict is allowed to read (nothing else). */
export interface GateReportInput {
  scores: Record<string, number>;
  reproducible: boolean;
}

export interface ObjectiveGateVerdicts {
  checks: GateCheck[];
  /** at least one check failed */
  anyFail: boolean;
  /** at least one machine-checkable gate exists */
  anyMachine: boolean;
  /** the machine-validation verdict: no failures AND at least one machine gate */
  machinePass: boolean;
  note: string | null;
}

/** The metric vocabulary gates may reference — anything else is an honest refusal. */
const METRICS: Record<string, (r: GateReportInput) => number | boolean | null> = {
  coverage: (r) => numberOrNull(r.scores.coverage),
  confidence: (r) => numberOrNull(r.scores.confidence),
  costUsd: (r) => numberOrNull(r.scores.costUsd),
  determinism: (r) => numberOrNull(r.scores.determinism),
  reproducibility: (r) => (typeof r.reproducible === 'boolean' ? r.reproducible : null),
};

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isGateShape(v: unknown): v is { min?: unknown; max?: unknown; required?: unknown } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Evaluate one objective's gates JSON (already-parsed value) against a
 * report. Non-object gates JSON at the top level is an honest
 * "nothing machine-checkable" — never a pass.
 */
export function evaluateObjectiveGates(gates: unknown, report: GateReportInput): ObjectiveGateVerdicts {
  if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
    return {
      checks: [],
      anyFail: false,
      anyMachine: false,
      machinePass: false,
      note: 'objective gates are not a JSON object — nothing machine-checkable',
    };
  }

  const checks: GateCheck[] = [];
  for (const [name, spec] of Object.entries(gates as Record<string, unknown>)) {
    // descriptive string → the human gate (manual, never auto-pass)
    if (typeof spec === 'string') {
      checks.push({ gate: name, verdict: 'manual', note: spec, actual: null });
      continue;
    }
    if (!isGateShape(spec)) {
      checks.push({
        gate: name,
        verdict: 'fail',
        note: 'unknown gate shape — refusing to guess (expected {min} | {max} | {required} or a descriptive string)',
        actual: Array.isArray(spec) ? 'array' : typeof spec,
      });
      continue;
    }
    const read = METRICS[name];
    if (!read) {
      checks.push({
        gate: name,
        verdict: 'fail',
        note: `no machine mapping for gate "${name}" — refusing to guess`,
        actual: null,
      });
      continue;
    }
    const actual = read(report);
    if (actual === null) {
      checks.push({
        gate: name,
        verdict: 'fail',
        note: 'metric not reported by this run — refusing to guess',
        actual: null,
      });
      continue;
    }

    const notes: string[] = [];
    let pass = true;
    if (spec.min !== undefined) {
      if (typeof actual === 'number' && numberOrNull(spec.min) !== null) {
        const min = spec.min as number;
        const ok = actual >= min;
        pass = pass && ok;
        notes.push(ok ? `\u2265 ${min}` : `${actual} < min ${min}`);
      } else {
        pass = false;
        notes.push('min gate needs a numeric metric');
      }
    }
    if (spec.max !== undefined) {
      if (typeof actual === 'number' && numberOrNull(spec.max) !== null) {
        const max = spec.max as number;
        const ok = actual <= max;
        pass = pass && ok;
        notes.push(ok ? `\u2264 ${max}` : `${actual} > max ${max}`);
      } else {
        pass = false;
        notes.push('max gate needs a numeric metric');
      }
    }
    if (spec.required !== undefined) {
      const ok = actual === true || actual === 1;
      pass = pass && ok;
      notes.push(ok ? 'required satisfied' : 'required not satisfied');
    }
    if (spec.min === undefined && spec.max === undefined && spec.required === undefined) {
      // an object with none of the machine keys — garbage shape, honest fail
      checks.push({
        gate: name,
        verdict: 'fail',
        note: 'gate object carries no machine-checkable key (min | max | required) — refusing to guess',
        actual: null,
      });
      continue;
    }
    checks.push({
      gate: name,
      verdict: pass ? 'pass' : 'fail',
      note: notes.join(' \u00b7 '),
      actual,
    });
  }

  const anyFail = checks.some((c) => c.verdict === 'fail');
  const anyMachine = checks.some((c) => c.verdict !== 'manual');
  return {
    checks,
    anyFail,
    anyMachine,
    machinePass: anyMachine && !anyFail,
    note: anyMachine
      ? anyFail
        ? `machine gates failed: ${checks.filter((c) => c.verdict === 'fail').map((c) => c.gate).join(', ')}`
        : 'all machine gates pass (manual gates stay human decisions)'
      : 'no machine-checkable gates on this objective — it cannot machine-validate',
  };
}
