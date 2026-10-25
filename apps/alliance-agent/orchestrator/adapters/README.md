# Worker adapters

All adapters implement `id`, `type`, explicit `namespaces`, `capabilities`, `effects`, `enabled`, `doctor()` and `run(packet,{signal})`. `createWorkerRegistry(config,{env})` returns an object keyed by worker ID; `doctorRegistry` returns diagnostic metadata without printing credentials or raw CLI output.

Task/review packets use `ciaomind.goal-worker.v1`. Results must echo namespace, goal ID/version, step/task ID, input SHA256 and attempt ID exactly, plus the configured producer ID and nonempty evidence. Missing fields are rejected, never synthesized by the adapter. Mission plan reviews have their own phase identity and receive the already-validated original planning receipt as task data.

## Codex

The adapter uses the locally installed official noninteractive CLI, via argument arrays and stdin (`shell:false`). It requests a JSON response schema, an ephemeral run, no shared daemon, read-only sandbox and no interactive approvals. It disables user configuration, optional apps/plugins/hooks/browser/computer/image/subagent tools and web search. A project-local `.codex/config.toml` is refused pending a separately reviewed adapter policy. No `dangerously` or hook-trust bypass options are used.

Both `enabled:true` and `CIAOMIND_ENABLE_WORKERS=1` are required. `workdir` must be an existing absolute path. Cached `codex login status` is classified only as ChatGPT, API-key, missing or unverified; this diagnostic does **not** establish inference readiness. API-key mode is denied unless `allowApiKey:true` is separately configured. This implementation task does not authorize paid API calls. An actual inference failure remains blocked even when login metadata exists.

Native managed policy, provider behavior and host read access remain part of the trust boundary. The adapter does not provide OS-level directory isolation, multi-user tenancy or a proof that two registry identities belong to independent people/providers. Every invocation is bounded by cancellation, timeout and combined stdout/stderr plus final-response size limits. Provider errors expose only HTTP status and a fixed public error-code category; raw stderr and credentials are not put into audit events.

Default task output is `{summary:string,artifacts:string[]}` to keep the provider's strict JSON schema closed. A review returns `decision:accept|reject` and evidence. One coordinator invocation may contain multiple internal model/tool calls; its call budget is not a token or currency cap.

Reference: the installed Codex 0.163.0 `codex exec --help` and `codex features list`; [official Codex SDK and app-server documentation](https://learn.chatgpt.com/docs/codex-sdk).

## Gemini

Gemini uses documented headless JSON output, passes the packet through stdin and requests plan mode plus sandbox. The outer `{response,stats,error}` envelope and inner exact JSON result are validated independently.

It additionally requires `reviewedConfig:true`: plan mode is not a certificate that operator-installed MCP servers, extensions or hooks are free of side effects. Review those settings before enabling. Cached authentication or API/Vertex credentials must be provisioned separately using the provider's normal flow. This project does not automatically sign in, copy credentials, or treat the current ChatGPT connection as Gemini authorization. Without a successful real invocation its authentication remains unverified.

References: [headless output](https://geminicli.com/docs/cli/headless/), [CLI flags](https://geminicli.com/docs/cli/cli-reference/), [plan mode](https://geminicli.com/docs/cli/plan-mode/).

## Explicit demo subprocess

IDs must start with `demo-`. No model is involved and every output says `local-demo-no-model`.

- `input.operation='sum'`, with finite `values`, returns count/sum/sorted unique values plus a JSON summary. A distinct demo reviewer recomputes it.
- `inspect` reports synthetic input keys without reading files.
- `plan-mission`/`review-plan` exercise a fixed synthetic one-step sum plan under `demo.plan`/`demo.compute`; they do not understand or prove arbitrary natural-language objectives.
- `evaluate-mission` checks a completed synthetic child goal, every sum result, and its distinct accepting reviewer. It does not accept unknown real-world work.

Only errors known to precede provider execution set `notStarted:true`, allowing the coordinator to release its reservation. A post-spawn auth error, cancellation or uncertain outcome does not make that claim.
