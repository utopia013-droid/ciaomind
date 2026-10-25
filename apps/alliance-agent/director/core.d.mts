import type { GoalStore } from "../orchestrator/store.mjs";
import type { JSONValue } from "../control/core.mjs";
import type { WorkerAdapter } from "../orchestrator/adapters/index.mjs";
export interface MissionInput {
  mission_id: string;
  namespace: "personal" | "project";
  mode?: "live" | "demo";
  objective: string;
  acceptance: string[];
  grants: string[];
  planner: string;
  reviewer: string;
  allowed_workers: string[];
  max_calls?: number;
  max_cycles?: number;
  revisit_seconds?: number;
}
export interface MissionRecord extends Required<MissionInput> {
  mission_version: 1;
  contract_sha256: string;
  status:
    | "active"
    | "blocked"
    | "paused"
    | "cancelled"
    | "completed"
    | "maintenance";
  phase: "plan" | "plan_review" | "child" | "final_review";
  cycle: number;
  calls_reserved: number;
  plan: JSONValue | null;
  child_goal: JSONValue | null;
  child_goal_id: string | null;
  observations: JSONValue[];
  blocked_reason: string | null;
  resume_status: string | null;
  next_wake_at: number | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
}
export interface MissionEvent {
  event_id: number;
  namespace: string;
  mission_id: string;
  type: string;
  detail: JSONValue;
  created_at: number;
}
export interface MissionCall {
  attempt_id: string;
  phase: string;
  packet: JSONValue;
  result: JSONValue | null;
  error: JSONValue | null;
  created_at: number;
  updated_at: number;
}
export class MissionStore {
  constructor(options: { dbPath: string; now?: () => number | Date });
  close(): void;
  createMission(input: MissionInput): MissionRecord;
  getMission(namespace: string, id: string): MissionRecord;
  listMissions(namespace?: string): MissionRecord[];
  events(namespace: string, id: string): MissionEvent[];
  calls(namespace: string, id: string): MissionCall[];
  pauseMission(namespace: string, id: string): MissionRecord;
  resumeMission(namespace: string, id: string): MissionRecord;
  cancelMission(namespace: string, id: string): MissionRecord;
  retryMission(namespace: string, id: string): MissionRecord;
}
export interface MissionTick {
  missions_scanned: number;
  planner_calls: number;
  plan_reviews: number;
  mission_reviews: number;
  child_ticks: number;
  completed_missions: number;
  blocked_missions: number;
  recovered_leases: number;
  errors: { namespace: string; mission_id: string; code: string }[];
}
export class MissionDirector {
  constructor(options: {
    store: MissionStore;
    goalStore: GoalStore;
    workers: Record<string, WorkerAdapter> | Map<string, WorkerAdapter>;
    leaseMs?: number;
    owner?: string;
  });
  tick(options?: {
    namespace?: string;
    signal?: AbortSignal;
  }): Promise<MissionTick>;
}
