# 联盟协作代理

依据公开功能独立开发的 CIAOMIND 任务协作底座，开发任务为 [#6](https://github.com/utopia013-droid/ciaomind/issues/6)。本项目不依赖 Dots 资格，不使用其私有接口；当前交付本地单用户原型。

## 无模型启动

Node.js 24+；从本目录执行：

```bash
node control/demo.mjs
node --test control/core.test.mjs
node control/cli.mjs --help
```

演示只使用内置模块、临时私有 SQLite 数据库和合成数据，运行后清理临时数据。它展示创建、幂等派发、重开恢复、结果提交及独立角色验收的协议；没有调用模型，也没有认证远端工人。实际任务的文件交接见 [CLI 说明](control/README.md)。

路由为 `code → codex`、`office → workbuddy`、`research → manual`；`sensitive → human` 并保持 blocked。任务包只是数据，不运行命令或发起外部动作。输入不可变；重复派发返回同一轮次，过期结果被拒绝。

## 可选的模型调度适配

已使用 Eve 0.83.2 搭建三个工具：`create_task`、`dispatch_task`、`task_status`。模型可以登记和查看任务、导出交接包；提交结果、暂停/重试及验收留给本地操作者。默认工具集和子代理复制已关闭，没有 shell、网页、消息或自动验收工具。

```bash
npm ci
npm run typecheck
npm run build
```

构建不是模型运行验证。只有在确认可用模型凭据、调用权限与预算后，才在本机设置 `CIAOMIND_ENABLE_MODEL=1` 并执行 `npm run dev`。不在聊天或仓库里粘贴密钥；按 Eve 终端的官方登录流程处理。选用的模型保留框架默认值 `openai/gpt-6-luna-fast`，可在 `agent/agent.ts` 中审查。当前没有完成真实模型调用测试。

开关在会话创建和各模型步骤选择时检查，关闭后阻止后续步骤选择；它不是凭据验证器、成本硬上限，也不会取消已经发出的调用。仅运行离线 CLI/演示时不需要设置开关或安装 Eve。

适配默认把数据库写到用户主目录下 `.local/share/ciaomind/tasks.sqlite`，可用 `CIAOMIND_DATA_DIR` 指定另一个私有目录。CLI 则要求显式 `--db`。任务输入、结果及审计记录都留在数据库中；真实模型使用任务工具时，其返回内容会进入该模型的上下文。当前以合成数据验收。

## 当前边界

- 单机可信操作者使用；`producer`、`reviewer` 是本地审计标签，不提供身份认证或多用户隔离。
- SQLite 与 Eve 适配仅针对有持久磁盘的本机环境；拒绝 Vercel 环境，未部署为公网服务。
- 没有自动连接 Codex/WorkBuddy、GitHub 写回、常驻巡检、个人长期记忆或电脑控制。
- 生成物先进任务分支与 PR，由现有治理验收；原型不自动合并或部署。

实测范围见 [验证记录](../../docs/alliance-agent/VERIFICATION.md)，后续按 [ROADMAP](../../docs/alliance-agent/ROADMAP.md) 逐阶段验证。框架实现依据安装版本的 `node_modules/eve/docs/README.md`、`tools/overview.mdx`、`concepts/built-in-tools.md` 和 `agent-config.md`。
