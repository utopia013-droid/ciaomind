# 长期目标总控验证记录

日期：2026-10-25。此记录对应本次 PR 的长期目标层、执行层、CLI/daemon 和工人适配。

## 实现与检查

| 检查 | 实际结果 |
|---|---|
| `npm test` | **92/92 通过**：包含原文件交接、目标/DAG、mission 规划与重规划、租约并发、暂停/取消、预算预约、namespace、真实本地进程、CLI 重启与适配器 fixture；追加终止性授权诊断和全局配置边界回归 |
| `npm run typecheck` | 通过 |
| `npm run demo:mission` | 5 次自动 tick 达到 completed；计划阶段后关闭并重新打开数据库，接续成功 |
| `npm run build` | Eve 构建通过；未调用模型 |
| `eve info --json` | 0 错误、0 警告；发现十个 typed tools，无额外 subagents/schedules |
| `git diff --check` | 通过 |
| 独立只读审查 | 内层及 director 审查通过；发现的暂停、失租、预算、授权接线和维护恢复问题已补回归 |

本地 demo 由明确标识的两个子进程工人生成固定合成计划与结果，并不使用大模型。通过演示只说明程序链路可执行，不能证明真实模型的规划质量或跨厂商协作。

## 独立 CLI 运行与重开

在仓库之外的私有目录登记两项目标后，实际启动 director CLI 运行八轮，期间无需用户继续输入：

- 合成 mission 完成，调用预约总数为 5。
- 缺少连接的 live mission 明确 blocked，未消耗调用预约。
- 阻塞目标未阻止合成目标推进。
- 新进程再次运行后，已完成目标没有重复调用，调用数仍为 5。
- mission-goals.sqlite 与独立执行层的 goals.sqlite 分开，避免默认两个 daemon 抢同一子任务库。

所有输入、数据库、完整调用原包/结果和运行日志只保留在本次工作区的私有目录。公共仓库不保存用户个人资料、头像、声音、凭据、原始聊天或私有链接。

## 真实厂商连接：未通过

当前环境存在 Codex CLI 0.163.0，`codex login status` 显示 ChatGPT 登录。使用只读沙箱、关闭可选外部工具、禁止审批升级及临时会话进行最小结构化任务时，实际请求返回 **HTTP 401 / AUTH_REQUIRED**，没有取得成功的模型结果。

另一次最小诊断确认同样的 401 后停止重试，没有自动登录、切换计费 API key 或放宽权限。登录状态不等于有效推理授权。后续需在实际运行主机按官方流程重新建立有效授权，再做受限目标联调。

追加排查从 CLI 的失败事件中识别到账号身份一致性检查失败。已对照 [0.163.0 官方源码](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/login/src/auth/manager.rs#L2485)：原账号 ID 缺失，或重新载入后的账号 ID 缺失/不同，均可能触发该终止性刷新错误；不能据此断言用户真的切换过账号。

本机官方 `account/read(refreshToken:true)` 返回成功后，最小只读推理仍返回 401。刷新 RPC 成功不证明实际令牌刷新或推理授权恢复；没有开始新登录或手工读取、复制、覆盖凭据。当前也没有可复用的共享 daemon。`codex doctor --json` 的 HTTP 可达性与缓存检查不能替代真实推理验收。

适配器现将这条固定 CLI 消息额外分类为本地 `auth_failure_reason: account_identity_mismatch`，提示 `recovery_action: sign_in_again`，保留原 HTTP 状态和公开错误码。原日志没有 HTTP 码时仍为 `null`，不伪造成服务返回的 401。该错误仍为不可自动重试的 `AUTH_REQUIRED`；原实现已经阻止这条固定消息自动重试，本次补齐的是诊断分类与恢复提示，不能称为已经修复授权。

另一运行环境已对前一诊断版本 `4f98022` 回传 69/69 文件指纹一致、88 项测试及 demo 成功；真实工人联调仍 blocked，跨 VM 替换恢复尚未验证。

桌面接入准备另发现全局配置误拦：当工作目录位于用户主目录内时，原先对所有祖先的检查会将标准全局配置误当成项目配置。现已按 [官方项目配置发现实现](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/config/src/loader/mod.rs#L1720)仅排除已被 `--ignore-user-config` 忽略的全局目录，保留其他项目配置检查。合成回归覆盖 Windows 风格的 home/AppData/Local/Temp 路径、非全局祖先拦截及项目文件硬链接不获豁免；这些是当前 Linux 环境中的测试，不等于 Windows 真机或桌面授权已验证。

Gemini CLI/认证尚未配置，因此跨厂商协作未验证。Eve 的模型授权也与 Codex CLI 分开；类型检查和构建不能证明 Eve 对话已可用。

## 生产边界

- 两个 systemd user service 模板已生成，未安装、enable 或 start。
- 当前云工作区没有被认定为持续在线的生产主机。
- 本版自动执行只接受明确批准的只读能力，写入执行、生产代码升级、私人长期记忆检索需另设验收。
- 调用预约不是美元硬预算或工人内部推理次数上限；超时与取消不能撤回已发生的外部动作。
- 个人/项目 namespace 是单用户逻辑隔离，未实现多租户身份认证或加密隔离。

协议与运行步骤见 [PROTOCOL.md](PROTOCOL.md)、[OPERATIONS.md](OPERATIONS.md)。
