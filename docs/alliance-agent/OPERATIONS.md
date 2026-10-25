# 长期目标总控运行说明

本说明对应 `apps/alliance-agent/director/` 与 `orchestrator/`。上层 director 接收不含手写步骤的自然语言主旨；下层 orchestrator 执行经过审查的依赖计划。两层使用本机私有 SQLite 状态与串行轮询，模型和工人通过独立适配器接入。代码可运行、账号已登录、真实任务完成和生产常驻是不同状态；实际验证结果以 PR 中的运行记录为准。

## 推荐入口：一次目标，自动规划与推进

从应用目录执行零参数演示：

```bash
cd apps/alliance-agent
node director/demo.mjs
```

这条链展示计划、独立计划审查、子目标执行、原始主旨验收与数据库重开恢复；demo 的计划和数字计算是固定合成逻辑，不是自然语言模型推理，也不证明远端厂商已连接。

若要保留 demo 的状态和事件，使用私有目录运行：

```bash
export CIAOMIND_DATA_DIR="$HOME/.local/share/ciaomind"
node director/cli.mjs create --file director/examples/demo-mission.json
node director/cli.mjs run --namespace project --interval-ms 100 --max-ticks 8
node director/cli.mjs show project DEMO-MISSION-001
node director/cli.mjs events project DEMO-MISSION-001
node director/cli.mjs calls project DEMO-MISSION-001
```

自然目标输入只需 `mission_id`、范围、`objective`、原始 `acceptance`、允许能力、规划者、独立审查者、允许工人名单和上限，不需要手写 `steps`。真实目标使用 `mode: live`；live 拒绝 demo 适配器。参考 [PROTOCOL.md](PROTOCOL.md) 的主旨契约，不要把演示模式改名后当成真实规划成功。

运行时依次经历 `plan → plan_review → child → final_review`。子计划做完后，独立审查者还要根据原始目标验收；证据不足时，director 保存缺口并在 `max_cycles` 与 `max_calls` 内重新规划。缺连接或不确定失租会留下具体阻塞，不静默重复模型调用。`pause/resume/cancel/retry NAMESPACE MISSION_ID` 管理主旨；retry 不扩大上限。

默认主旨库为 `$CIAOMIND_DATA_DIR/missions.sqlite`，director 子目标库为同目录 `mission-goals.sqlite`；独立底层 CLI 使用 `goals.sqlite`。可用 director 的 `--db` 与 `--goals-db` 显式指定不同文件。不要让 director 与独立 orchestrator daemon 同时调度同一个子目标库；父层暂停或取消时，应由同一个 director 管理其子目标。`max_cycles` 是包含维护重查在内的累计上限，不会在重启后重置。

## 底层调试：显式步骤闭环

需要 Node.js 24+。下面从仓库根目录进入应用，使用两个明确标注的本地 demo 进程验证依赖步骤与独立角色审查，不需要模型密钥：

```bash
cd apps/alliance-agent
export CIAOMIND_DATA_DIR="$HOME/.local/share/ciaomind"
node orchestrator/cli.mjs doctor
node orchestrator/cli.mjs create --file orchestrator/examples/demo-goal.json
node orchestrator/cli.mjs run --namespace project --interval-ms 100 --max-ticks 8
node orchestrator/cli.mjs show project demo-continuous-goal
node orchestrator/cli.mjs events project demo-continuous-goal
```

示例包含两个有先后依赖的求和步骤；只有前一步通过另一个 demo 角色的审查，后一步才可推进。`run` 在进程内部反复检查，不要求用户逐次发送“继续”。`--max-ticks` 让这个验证进程有明确结束点；它不是执行次数或费用。

重复注册相同 ID、相同契约应返回既有目标；相同 ID 的冲突内容会失败。该 demo 目标完成后不会因再次运行而重新生成任务。要做一次新的独立实验，应使用新目标 ID 和私有数据库目录，并注明实验目的，不用改 ID 掩盖失败。

## 读取状态与管理目标

```bash
node orchestrator/cli.mjs list --namespace project
node orchestrator/cli.mjs pause project demo-continuous-goal
node orchestrator/cli.mjs resume project demo-continuous-goal
node orchestrator/cli.mjs retry project demo-continuous-goal --step first-sum
node orchestrator/cli.mjs cancel project demo-continuous-goal
```

这些是操作语法，不能对同一个已完成目标依次执行并预期全部成功；每个操作受当前状态检查。`retry` 不增加授权或预算，也不清除历史调用预约。先看 `show` 的具体阻塞与 `events`，再处理缺少的连接、权限或输入条件。

所有目标接口都使用 `namespace + goal_id`。`personal` 与 `project` 的查询、工人允许范围和任务上下文分开；这提供逻辑范围检查，不等于多租户身份认证、磁盘加密或不可信用户隔离。初版用于一个可信本机操作者；需要更强隔离时，应使用不同私有数据库目录、进程、凭据和执行节点。

默认数据库位于 `$CIAOMIND_DATA_DIR/goals.sqlite`，未设置时为 `~/.local/share/ciaomind/goals.sqlite`。也可用 `--db /absolute/private/goals.sqlite` 显式选择。真实目标文本、结果、事件、个人记忆、头像、声音和凭据不得进入公共仓库；`show/events` 及 director 的 `calls` 会输出任务内容，应在私有终端使用。

## 配置真实工人

把 `orchestrator/examples/private-config.example.json` 复制到仓库外的私有目录，替换已授权工作目录及实际程序路径。真实适配器默认 `enabled: false`，不会因出现于名册就运行。例如：

```bash
mkdir -p "$HOME/.config/ciaomind"
cp orchestrator/examples/private-config.example.json "$HOME/.config/ciaomind/worker-config.json"
chmod 600 "$HOME/.config/ciaomind/worker-config.json"
export CIAOMIND_CONFIG="$HOME/.config/ciaomind/worker-config.json"
```

实际调用需要同时满足：

- 私有配置中明确启用该工人；其 `namespaces` 允许目标范围。
- 目标的 `grants` 包含步骤能力，审查还需 `review`；工人声明支持对应能力。
- 本机设置 `CIAOMIND_ENABLE_WORKERS=1`，且账号认证和可用额度确实满足该平台条件。
- 独立审查者与产出者使用不同工人 ID；更换 ID 不代表换成了另一家模型。

```bash
node orchestrator/cli.mjs --config "$CIAOMIND_CONFIG" doctor
node orchestrator/cli.mjs --config "$CIAOMIND_CONFIG" create --file /private/path/goal.json
node orchestrator/cli.mjs --config "$CIAOMIND_CONFIG" run --namespace project
```

`CIAOMIND_CONFIG` 应是用户已选定的私有配置文件路径。以上命令不会替用户创建账号、购买额度或保存密钥；应按提供方的官方登录流程或运行环境凭据处理。不要在配置示例、聊天、Issue 或日志中粘贴密钥。

适配器状态以 `doctor` 的配置、程序安装、认证类型和具体原因分别显示；doctor 不调用模型，也不证明端到端成功。

| 适配器 | 运行路径与当前边界 |
|---|---|
| Codex | 使用正式非交互 CLI、结构化输出和只读沙箱。实现关闭可关闭的应用、插件、钩子、浏览器、电脑、图像与子代理能力，并忽略用户配置；保留正常身份认证和规则。`allowApiKey` 默认 false，不默认转用 API key 计费。已登录仍需一次真实任务与独立复核来确认可用性。 |
| Gemini | 使用 headless JSON 输出、plan 模式与 sandbox；需额外 `reviewedConfig: true`，表示操作者已审查本机扩展和 MCP 配置。plan 模式本身不等于操作系统隔离。未安装或未认证时保持具体阻塞，不用另一厂家冒充成功。 |
| demo | 本地子进程处理合成数字，ID 必须以 `demo-` 开头；用于协议验证，不是外部模型或跨厂商连接证据。 |

调用能力与认证配置不会从当前聊天插件自动转移到新建服务。Codex、Gemini、Eve 对话模型需要分别核验。

本次已观察到的认证边界：Codex CLI 0.163.0 的 login metadata 显示 ChatGPT 登录，但最小真实只读探针返回 HTTP 401 / `AUTH_REQUIRED`。因此本次不能标为 Codex 已接通，也没有用新登录、付费 key 或其他厂家代替成功。Gemini 尚无真实安装与认证回执。修复后需重新拿到实际任务、结果与独立验收证据。

## 常驻、退出与重启

不加 `--max-ticks` 的 `run` 按配置的 `poll_interval_ms` 连续检查；同一个进程不会重叠启动两次 tick。日志只输出计数与错误数量，具体任务内容留在私有状态库。缺连接的目标应进入可见阻塞，其他无依赖目标仍可推进。

按 Ctrl+C 或发送 SIGTERM 会停止新领取，并通过取消信号结束当前调用。等待超过 `shutdown_timeout_ms` 会报错，让进程守护程序处理。取消或超时不能撤回已经发生的外部操作；重启应先核对持久化状态与租约，不盲目重做结果不明的动作。

`orchestrator/deploy/` 中的 `systemd --user` 模板只生成文件，没有被自动安装、启用或启动。主旨服务应启动 `director/cli.mjs run`；`ciaomind-goals.service.example` 只推进下层显式计划，不能代替主旨规划循环。先替换 Node、仓库、私有配置和数据目录的绝对路径，保持每个子目标库只有一个调度 owner，完成目标主机的账号与运行验收后，再由操作者安装相应服务。模板的 `Restart=on-failure` 不能替代持久磁盘、备份、主机在线与故障恢复验证。

本次开发云环境不是已交付的长期托管环境；不能承诺聊天结束后它仍持续在线。对外宣布常驻前，需要在实际目标主机上验证退出登录、进程崩溃、重启和网络中断后的恢复。

## 自然语言入口与后续扩展

Eve 的 `create_mission`、`mission_status`、`manage_mission` 处理用户主旨，`worker_status` 查看适配器就绪状态；底层 `create_goal` 接收包含步骤、验收与受限能力的契约，`goal_status` 读指定范围，`manage_goal` 处理用户明确要求的暂停、恢复、重试或取消。执行工人的循环由独立 daemon 承担，登记本身不代表工人正在运行。旧的三个文件交接工具保留兼容，共十个工具；没有给模型开放通用 shell 或自行验收权限。

Eve 对话模型的启用门槛为 `CIAOMIND_ENABLE_MODEL=1`，还需其实际模型路径的认证。Codex CLI 登录不自动证明 Eve 的 Gateway 或其他模型连接已就绪。仅运行离线 demo、CLI 和 daemon 不需要启动 Eve。

下层 daemon 推进明确登记的依赖步骤，上层 director 可在原始主旨、授权与上限内重新规划。两者都不能自行扩张权限、放宽原始验收或更改生产代码。自我改进可作为工人输出的提案，仍需固定评测、独立审查与可回滚的发布流程。完整协议与状态边界见 [PROTOCOL.md](PROTOCOL.md)。
