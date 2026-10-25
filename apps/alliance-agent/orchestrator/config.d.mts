export type Namespace = "project" | "personal";
export interface WorkerConfig {
  id: string;
  type: "demo" | "codex" | "gemini";
  role?: "worker" | "reviewer";
  namespaces: Namespace[];
  enabled: boolean;
  workdir?: string;
  binary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  model?: string;
  reviewedConfig?: boolean;
  allowApiKey?: boolean;
}
export interface OrchestratorConfig {
  workers: WorkerConfig[];
  poll_interval_ms: number;
  shutdown_timeout_ms: number;
}
export const DEFAULT_CONFIG: Readonly<OrchestratorConfig>;
export function loadConfig(
  path?: string,
  options?: { env?: Record<string, string | undefined> },
): OrchestratorConfig;
export function resolveDataPaths(options?: {
  db?: string;
  env?: Record<string, string | undefined>;
}): { directory: string; dbPath: string };
