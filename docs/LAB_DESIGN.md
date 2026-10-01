# YOU Reality Engineering Lab

## Objective
Discover and continuously improve pipelines and agent organizations for human reconstruction, animation, rendering, try-on and embodiment.

## World
Each Lab world defines actors, ground truth, cameras, lighting, clothing, hair, geometry, motion, sensors, noise, occlusion and known perturbations. Synthetic worlds are deterministic by seed and explicitly labeled as simulated.

## Organization Compiler
Task -> required capabilities -> candidate roles -> body graph -> tools/skills -> Soul assignment -> budget/latency policy.

Always benchmark:
1. generalist baseline
2. hand-designed organization
3. searched organization

## Agent Body
Reusable role/capability/tool/memory/evaluator contract.

## Soul
LLM/VLM/runtime binding. A Body can be possessed by another Soul without changing its domain contract. system_one/system_two are routing profiles.

## Technology search
Search dimensions include model, code, data pipeline, parameters, ensemble/cascade/fallback, compute and post-processing. Closed systems may be characterized through public documentation and authorized APIs; do not circumvent access controls or copy protected internals.

## Learning ladder
deterministic replay -> supervised evaluators -> search/bandits -> offline policy learning -> bounded RL -> shadow/canary.

RL is used where feedback is meaningful; deterministic benchmark gates remain authoritative.

## Failure Atlas
Store every repeatable failure with input conditions, pipeline, technology versions, artifacts, suspected cause, confidence and remediation.

## Capture Scientist
The Lab may discover better capture instructions and request only the additional evidence needed for a missing region/action.

## Pipeline Genome
A PipelineCandidate is a graph of adapter versions, parameters, skills, organizations, Souls, compute and evaluation configuration. The Lab can mutate this graph and benchmark offspring.

## Promotion
Draft -> benchmarked -> validated -> canary -> production -> retired.
Promotion is evidence-driven and reversible.
