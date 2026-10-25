import type { JSONValue } from "../control/core.mjs";
export type Namespace = "personal" | "project";
export interface StepContract {
  step_id: string;
  kind?: string;
  worker: string;
  reviewer?: string | null;
  capability?: string;
  input?: JSONValue;
  depends_on?: string[];
}
export interface GoalContract {
  namespace: Namespace;
  goal_id: string;
  goal_version?: 1;
  objective: string;
  acceptance: string[];
  steps: StepContract[];
  grants: string[];
  max_calls?: number;
  max_attempts?: number;
  revisit_seconds?: number;
}
export interface StepRecord extends StepContract {
  status: "pending" | "running" | "review" | "done" | "blocked";
  phase: "task" | "review";
  attempt_id: string | null;
  input_sha256: string | null;
  attempts: number;
  review_attempts: number;
  result: WorkerResult | null;
  review: WorkerResult | null;
  blocked_reason: string | null;
  next_attempt_at: number | null;
  lease_until: number | null;
}
export interface GoalRecord extends GoalContract {
  goal_version: 1;
  max_calls: number;
  max_attempts: number;
  revisit_seconds: number;
  contract_sha256: string;
  status:
    | "active"
    | "blocked"
    | "paused"
    | "cancelled"
    | "completed"
    | "maintenance";
  calls_reserved: number;
  cycle: number;
  next_wake_at: number | null;
  blocked_reason: string | null;
  created_at: number;
  updated_at: number;
  steps: StepRecord[];
}
export interface PacketIdentity {
  namespace: Namespace;
  goal_id: string;
  goal_version: 1;
  step_id: string;
  task_id: string;
  input_sha256: string;
  attempt_id: string;
}
export interface WorkerPacket extends PacketIdentity {
  protocol: "ciaomind.goal-worker.v1";
  type: "task" | "review";
  worker: string;
  kind: string;
  capability: string;
  input: JSONValue;
  dependencies: Record<string, JSONValue>;
  objective: string;
  acceptance: string[];
  lease_until: number;
  deadline: number;
  grant: { namespace: Namespace; capability: string };
  idempotency_key: string;
  result?: WorkerResult;
}
export interface WorkerResult extends PacketIdentity {
  producer: string;
  output?: JSONValue;
  evidence: string[];
  decision?: "accept" | "reject";
}
export interface GoalEvent {
  event_id: number;
  namespace: Namespace;
  goal_id: string;
  type: string;
  detail: JSONValue;
  created_at: number;
}
export interface CallRecord {
  call_id: string;
  namespace: Namespace;
  goal_id: string;
  step_id: string;
  attempt_id: string;
  phase: "task" | "review";
  owner: string;
  effects: "read-only" | "write";
  status:
    | "reserved"
    | "completed"
    | "failed"
    | "not_started"
    | "expired"
    | "cancelled";
  packet: WorkerPacket;
  result: WorkerResult | null;
  error: JSONValue | null;
  created_at: number;
  finished_at: number | null;
}
export function fault(code: string, message: string): Error & { code: string };
export function json(value: JSONValue): string;
export function hash(value: JSONValue): string;
export class GoalStore {
  constructor(options: { dbPath: string; now?: () => number | Date });
  close(): void;
  createGoal(contract: GoalContract): GoalRecord;
  getGoal(namespace: Namespace, goal_id: string): GoalRecord;
  listGoals(namespace?: Namespace): GoalRecord[];
  events(namespace: Namespace, goal_id: string): GoalEvent[];
  calls(namespace: Namespace, goal_id: string): CallRecord[];
  pauseGoal(namespace: Namespace, goal_id: string): GoalRecord;
  resumeGoal(namespace: Namespace, goal_id: string): GoalRecord;
  cancelGoal(namespace: Namespace, goal_id: string): GoalRecord;
  retryBlocked(
    namespace: Namespace,
    goal_id: string,
    options?: { step_id?: string },
  ): GoalRecord;
}
