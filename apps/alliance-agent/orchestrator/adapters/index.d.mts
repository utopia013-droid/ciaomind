import type {
  OrchestratorConfig,
  WorkerConfig,
  Namespace,
} from "../config.mjs";

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };
export interface WorkerIdentity {
  namespace: Namespace;
  goal_id: string;
  goal_version: number;
  step_id: string;
  task_id: string;
  input_sha256: string;
  attempt_id: string;
}
export interface WorkerPacket extends WorkerIdentity {
  protocol: "ciaomind.goal-worker.v1";
  type: "task" | "review";
  worker: string;
  kind: string;
  capability: string;
  input: JSONValue;
  objective: string;
  acceptance: string[];
  grant: { namespace: Namespace; capability: string };
  lease_until?: number | string;
  deadline?: number | string;
  idempotency_key?: string;
  result?: unknown;
}
export interface TaskResult extends WorkerIdentity {
  producer: string;
  output: JSONValue;
  evidence: string[];
}
export interface ReviewResult extends WorkerIdentity {
  producer: string;
  decision: "accept" | "reject";
  evidence: string[];
}
export type WorkerResult = TaskResult | ReviewResult;
export interface WorkerDoctor {
  id: string;
  type: "codex" | "gemini" | "demo";
  enabled: boolean;
  installed: boolean;
  configured: boolean;
  auth: "chatgpt" | "api-key" | "missing" | "unverified" | "not-required-demo";
  reason: string | null;
  security: string;
}
export interface WorkerAdapter {
  id: string;
  type: "codex" | "gemini" | "demo";
  namespaces: Namespace[];
  capabilities: string[];
  effects: "read-only";
  enabled: boolean;
  security?: string;
  doctor(): Promise<WorkerDoctor>;
  run(
    packet: WorkerPacket,
    options?: { signal?: AbortSignal },
  ): Promise<WorkerResult>;
}
export interface FactoryOptions {
  env?: Record<string, string | undefined>;
}
export class WorkerError extends Error {
  code: string;
  retryable: boolean;
  notStarted: boolean;
  diagnostic?: {
    provider: string;
    http_status: number | null;
    error_code: string;
  };
  constructor(
    code: string,
    message: string,
    options?: { retryable?: boolean; notStarted?: boolean },
  );
}
export function createCodexWorker(
  options?: Partial<WorkerConfig>,
  runtime?: FactoryOptions,
): WorkerAdapter;
export function createGeminiWorker(
  options?: Partial<WorkerConfig>,
  runtime?: FactoryOptions,
): WorkerAdapter;
export function createDemoWorker(
  options?: Partial<WorkerConfig>,
): WorkerAdapter;
export function createWorkerRegistry(
  config: OrchestratorConfig | WorkerConfig[],
  options?: FactoryOptions,
): Record<string, WorkerAdapter>;
export function doctorRegistry(
  config: OrchestratorConfig | WorkerConfig[],
  options?: FactoryOptions,
): Promise<WorkerDoctor[]>;
export function validateResult(
  result: unknown,
  packet: WorkerPacket,
  adapterId: string,
): WorkerResult;
export function responseSchema(packet: WorkerPacket): Record<string, unknown>;
