# CIAOMIND 长期目标总控

这是由用户管理的本地单用户 Agent 运行时。用户给目标和验收标准，director 在固定授权、调用上限和循环上限内组织计划、独立审查、执行、原目标验收及必要的重规划。调用各家服务仍使用各自官方接口与授权。

## 先运行可重复演示

仅需 Node.js 24+，无需安装依赖或模型凭据：

```bash
node director/demo.mjs
```

演示使用明确标识的本地 demo 工人，展示“目标 → 计划 → 独立计划审查 → 子任务 → 独立目标审查”，并在中途重开数据库恢复。它不调用真实模型，不能作为跨厂商联通证据。

旧的文件任务包演示保留：

```bash
node control/demo.mjs
```

## 三个层次

| 层次 | 入口 | 职责 |
|---|---|---|
| 长期目标 | `director/cli.mjs` | 不要求用户手写 steps；规划、审查、分派、目标验收、有限重规划与到期维护 |
| 明确计划 | `orchestrator/cli.mjs` | 执行依赖图，管理租约、调用预约、暂停、取消、重试与独立任务审查 |
| 手工交接 | `control/cli.mjs` | 兼容原 JSON 文件任务包协议 |

目标、授权与验收标准不可被运行中的模型改写。计划只是受审查的候选；子任务全部完成仍须对照原目标单独验收。自我改进可以输出建议或补丁方案，本版不自动替换生产代码或提升权限。

## 运行一个长期目标

把状态放到自己选定的私有目录，先看 CLI 帮助：

```bash
node director/cli.mjs --help
node director/cli.mjs doctor
node director/cli.mjs create --file director/examples/demo-mission.json
node director/cli.mjs run --interval-ms 100 --max-ticks 12
node director/cli.mjs show project DEMO-MISSION-001
```

上述命令使用默认的用户私有状态目录，可通过 `CIAOMIND_DATA_DIR` 或 `--db` 指定另一私有位置。默认 registry 只有 `demo-worker` 和 `demo-reviewer`；示例显式 `mode:demo`。真实目标默认 `mode:live`，不会接受 demo 工人冒充真实目标实现。

实际部署时配置私有 worker JSON，设置 `CIAOMIND_CONFIG` 或传入 `--config`。Codex 与 Gemini 适配器必须同时在配置中启用，并设置 `CIAOMIND_ENABLE_WORKERS=1` 才能运行。授权通过各家的官方登录/凭据流程处理，不能粘贴到 Issue、代码或配置示例中。Codex 默认拒绝 API-key 模式；Gemini 还要求明确审查其本地设置。详细命令、示例、阻塞恢复与服务模板见 [OPERATIONS](../../docs/alliance-agent/OPERATIONS.md)。

`run` 串行轮询，不需要用户逐次输入“继续”；进程必须真实运行才能主动唤醒。systemd 模板仅是安装材料，不会自动安装、启用或保证当前工作区永久在线。

## 自然语言入口

Eve 的本地终端界面提供中文对话入口。先独立配置其模型授权，再运行：

```bash
npm ci
npm run dev
```

Eve 模型开关为 `CIAOMIND_ENABLE_MODEL=1`；与 worker 开关和账号认证分别管理。当前模型保留框架默认 `openai/gpt-6-luna-fast`。Codex CLI 登录不证明 Eve Gateway 已授权。

已编写十个 typed tools：长期目标 create/status/manage、明确计划 create/status/manage、工人状态，以及原三个文件任务工具。默认通用工具和根代理复制关闭。Eve 只登记和查询受限契约，工人执行由独立 director/daemon 完成。

## 持久状态和边界

默认状态目录为 `CIAOMIND_DATA_DIR`，或用户主目录下 `.local/share/ciaomind`。个人与项目使用显式 namespace；这是单用户逻辑范围，不是多租户身份认证或加密隔离。实际 worker 工作目录、凭据和资料访问范围也须分别配置。

数据库、原始记忆、头像、录音、结果文件、凭据和私有配置都留在 Git 之外。GitHub 保存代码、通用协议和可审查的变更记录。只读适配器限制直接写操作，但不声称操作系统级工作目录隔离或所有宿主配置均已审查。

`max_calls` 限制的是总控预约的适配器调用次数，包含规划、审查和子任务；不是美元硬上限，也不等于工人内部模型调用次数。超时/取消不撤销已经发生的外部动作。失去租约的结果不能覆盖新轮次；不确定副作用不自动重复。

本版自动目标执行只开放已批准的只读能力。第二厂家实际认证、个人长期记忆检索、写入型执行及受控上线升级须分别接入与验收，不能从本地演示推定已完成。

## 验证与协议

```bash
npm test
npm run typecheck
npm run build
```

协议见 [PROTOCOL](../../docs/alliance-agent/PROTOCOL.md)，运维见 [OPERATIONS](../../docs/alliance-agent/OPERATIONS.md)，实际验证状态见 [VERIFICATION](../../docs/alliance-agent/VERIFICATION.md)。Eve 实现以安装版本 `node_modules/eve/docs/README.md` 及工具指南为依据。
