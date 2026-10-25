# 首版验证记录

日期：2026-10-25。范围：本地任务协议与 Eve 适配编译；未部署或调用外部模型 API。

## 自动检查

从 `apps/alliance-agent` 执行：

| 命令 | 实际结果 |
|---|---|
| `npm test` | 14/14 通过：恢复、并发派发、输入/结果指纹、旧轮次、自验收、暂停恢复、重试、敏感路由、CLI 错误与大小边界 |
| `npm run demo` | 临时数据库重开恢复，合成任务到 done；这是本地协议演示 |
| `npm run typecheck` | 通过 |
| `EVE_TELEMETRY_DISABLED=1 npm run build` | Eve 0.83.2 构建通过 |
| `EVE_TELEMETRY_DISABLED=1 npm exec -- eve info --json` | 0 错误、0 警告；只有 create_task、dispatch_task、task_status，无 subagents/schedules |
| `git diff --check` | 通过 |

独立代码审查发现并修复了输入被读取两次可能产生摘要不一致、输入边界与派发包边界不一致两项问题。原始复现及最大合法输入已独立复核，补入回归测试。

## 当前会话的独立代理文件交接

主代理从实际 SQLite 底座导出 `CIAO-CODEX-FILE-001`，交给一个未编写底座的协作代理读取任务包、重算输入摘要并生成结果文件；另一协作代理用独立 Python 计算复核。主代理先提交结果进入 review，收到独立接受回执后才记录验收。

- 合成输入：`[8,3,5,3,-2]`。
- 输入指纹：`8bc5a31c491c18791715728705f4748d5d175262a5514abcd4149fab4df7f887`，按任务包完整 `{input_version,kind,input}` 计算；输入包括目标说明和 expected_fields。
- 实际结果：`count=5`，`sum=17`，`sorted_unique=[-2,3,5,8]`。
- 实际事件：created → dispatched → result_submitted → reviewed；最终 done。
- 原始包、生产结果、独立回执、数据库留在本次工作区的私有运行目录，不提交数据库或完整会话。

这验证了当前会话中独立代理的手动本地文件交接。工人和审查者确实是不同的协作代理；控制面的身份字段仍是本地声明，不能证明远端服务身份，也没有建立自动 worker 适配、Windows 桌面连接或 Dots 实例。

## 仍待验证

Eve 的真实模型调用与工具往返、自动工人接入、后台轮询、长期记忆、部署恢复、联网身份认证与预算执行均未验证。模型启用开关只是显式运行门槛，类型检查、构建和手工回执不替代这些验收。
