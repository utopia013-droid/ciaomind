# CIAOMIND AI 任务调度台

状态：任务入口及本地长期目标总控已实现；真实厂商连接与常驻部署以验证记录为准。

## 自建联盟协作代理

依据公开能力独立实现，开发记录见 [Issue #6](https://github.com/utopia013-droid/ciaomind/issues/6)。长期目标层自动生成受限计划、独立审查、调度子任务，再对照原目标验收或重规划；执行层保存状态、调用预约、租约与审计。无需 Dots 账号资格。

Node.js 24+ 可直接运行离线合成演示，无需安装依赖或配置模型：

```bash
cd apps/alliance-agent
node director/demo.mjs
```

演示明确使用本地 demo 工人，不调用外部模型。使用说明见 [代理 README](apps/alliance-agent/README.md)，运行方式见 [运维说明](docs/alliance-agent/OPERATIONS.md)，实际验收见 [验证记录](docs/alliance-agent/VERIFICATION.md)。原有 Issue 打包和文件任务交接继续可用。

## 使用
1. Issues → New issue → AI任务，填写目标与验收条件。公开仓库禁止填写客户资料、财务、家庭信息、密码或密钥。
2. Actions → Prepare task → Run workflow，填写 Issue 编号与执行工具。
3. 下载 task-pack 工件，把 TASK.md 交给已登录的 Codex / Claude Code 等工具。工具是否可用取决于你的账户权限。
4. 执行工具在独立分支工作、提交 PR；检查通过后人工合并。

上述 Actions 工作流只打包任务，不调用模型、不创建订阅、不保证任何第三方已接通。研究与办公任务可使用同一入口，但无需强制生成代码 PR；交付来源、文档与验收结果。

## 下一阶段
接入一个已授权工人，验证任务包 → 实际执行 → 结果 → 独立验收，再增加常驻巡检和有限记忆。API 自动执行需要单独确认凭据、权限和预算，不能假定 ChatGPT 订阅覆盖 API；不同时购买多个工人。

请保留调度记录；不得把 Issue 文本直接拼接到 shell 执行。
