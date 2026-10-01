export type OrchestratorIntent = { objective: string; constraints?: Record<string, unknown> };
export const compileIntent = (intent: OrchestratorIntent) => ({ intent, status: "planned" as const });