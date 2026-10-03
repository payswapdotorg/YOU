export type TwinId = string;
export type TwinVersion = { twinId: TwinId; version: number };
export type JobState = "queued"|"provisioning"|"running"|"collecting"|"succeeded"|"failed"|"cancelled"|"unavailable"|"dead";
export type ConsentGrant = {
  id: string; subjectId: string; granteeId: string; purpose: string;
  operations: string[]; expiresAt: string; revocable: boolean;
};
export type PerformanceState =
  | "listening"|"reading"|"typing"|"thinking"|"tool_use"|"speaking"
  | "interrupted"|"idle"|"unavailable";
