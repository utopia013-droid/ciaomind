export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type TaskKind = 'code' | 'office' | 'research' | 'sensitive';
export type TaskStatus = 'queued' | 'dispatched' | 'review' | 'done' | 'paused' | 'blocked';
export interface TaskInput { task_id: string; input_version?: 1; kind: TaskKind; input: JSONValue }
export interface DispatchPacket {
  protocol: 'ciaomind.file-worker.v1'; task_id: string; input_version: number;
  input_sha256: string; attempt_id: string; kind: TaskKind; worker: string; input: JSONValue;
  execution: 'manual-file-handoff'; worker_authenticated: false;
}
export interface WorkerResult {
  task_id: string; input_version: number; input_sha256: string; attempt_id: string;
  producer: string; output: JSONValue; evidence: string[];
}
export interface TaskRecord {
  task_id: string; input_version: number; input_sha256: string; kind: TaskKind;
  worker: string; input: JSONValue; status: TaskStatus; attempt_id: string | null;
  result: WorkerResult | null; blocked_reason: string | null; created_at: string; updated_at: string;
}
export interface ReviewInput {
  task_id: string; attempt_id: string; reviewer: string; decision: 'accept' | 'reject'; evidence: string;
}
export interface AuditEvent { event_id: number; task_id: string; type: string; detail: JSONValue; created_at: string }
export const ROUTES: Readonly<Record<TaskKind, string>>;
export const MAX_INPUT_BYTES: number;
export const MAX_PACKET_BYTES: number;
export const MAX_JSON_BYTES: number;
export function canonicalJSON(value: JSONValue): string;
/** Trusted local operator API. Actor strings do not authenticate callers. */
export class ControlPlane {
  constructor(options: { dbPath: string });
  close(): void;
  createTask(input: TaskInput): TaskRecord;
  dispatch(taskId: string): DispatchPacket;
  submitResult(result: WorkerResult): TaskRecord;
  reviewTask(input: ReviewInput): TaskRecord;
  getTask(taskId: string): TaskRecord;
  listTasks(): TaskRecord[];
  events(taskId: string): AuditEvent[];
  pauseTask(taskId: string): TaskRecord;
  resumeTask(taskId: string): TaskRecord;
  retryTask(taskId: string, reason: string): TaskRecord;
}
