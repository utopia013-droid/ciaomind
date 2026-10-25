import type {
  GoalStore,
  Namespace,
  WorkerPacket,
  WorkerResult,
} from "./store.mjs";
export interface WorkerAdapter {
  id?: string;
  capabilities: string[];
  effects: "read-only" | "write";
  enabled: boolean;
  namespaces: Namespace[];
  run(
    packet: WorkerPacket,
    context: { signal: AbortSignal },
  ): Promise<WorkerResult> | WorkerResult;
}
export interface TickSummary {
  goals_scanned: number;
  task_calls: number;
  review_calls: number;
  completed_steps: number;
  blocked_steps: number;
  recovered_leases: number;
  maintenance_checks: number;
  errors: Array<{
    namespace?: Namespace;
    goal_id?: string;
    step_id?: string;
    code: string;
    message: string;
  }>;
}
export class Coordinator {
  constructor(options: {
    store: GoalStore;
    workers: Map<string, WorkerAdapter> | Record<string, WorkerAdapter>;
    owner?: string;
    leaseMs?: number;
    maxActionsPerTick?: number;
    now?: () => number | Date;
  });
  tick(options?: {
    namespace?: Namespace;
    signal?: AbortSignal;
  }): Promise<TickSummary>;
}
