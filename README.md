# CIAOMIND AI 任务调度台

状态：任务入口和本地私有知识流程可用；模型自动执行尚未接通。

## 使用
1. Issues → New issue → AI任务，填写目标与验收条件。公开仓库禁止填写客户资料、财务、家庭信息、密码或密钥。
2. Actions → Prepare task → Run workflow，填写 Issue 编号与执行工具。
3. 下载 task-pack 工件，把 TASK.md 交给已登录的 Codex / Claude Code 等工具。工具是否可用取决于你的账户权限。
4. 执行工具在独立分支工作、提交 PR；检查通过后人工合并。

此版本只打包任务，不调用模型、不创建订阅、不保证任何第三方已接通。研究与办公任务可使用同一入口，但无需强制生成代码 PR；交付来源、文档与验收结果。

## 下一阶段
先验证一个 Codex 任务完成 Issue → 分支 → PR → 检查，再接一个低价 API；不要同时购买多个工人。API 自动执行需要单独的密钥和预算配置，不能假定 ChatGPT 订阅覆盖 API。

请保留调度记录；不得把 Issue 文本直接拼接到 shell 执行。

## 私有知识与世界观提炼

新增离线 Python CLI：指定目录增量导入、GPT 导出角色区分、四角色任务包、引用校验、本人确认、公开授权、撤销和周报。仅用 Python 标准库，无付费 API。资料必须存放在所有 Git 工作区之外，不上传到本公开仓库。

```sh
python -m knowledge --help
python -m unittest discover -s tests -v
```

完整初始化、交接 JSON、审核、定时运行方式和边界见 [运行手册](docs/knowledge-workflow.md)。`run` 只执行一次同步并准备提炼任务；不会自动调用模型、发布或访问手机。四角色可交给已授权工具执行，实际连接须通过认证后的端到端任务验证。


## 免费与付费算力协同

[低成本协同方案](docs/low-cost-compute.md) 汇总官方免费层/营销额度边界、已有产品权益、任务分工与三轮试验。只读规划器按授权、配额、预算和独立样本质量提出路线建议，不执行模型请求：

```sh
python -m knowledge.routing examples/routing-input.json
```

默认预算为零、未登记已验证提供商，因此示例排队。实际账号权益、余额、质量样本和认证状态必须在私有配置中核验；产品积分、tokens和neurons分别计量，模拟成绩不能替代真实模型验证。

## 重要决议存档

[决议治理规则](docs/decision-governance.md)：每个重要决定保留正文、依据、取舍、状态及复审条件。私有档案按版本追加，支持索引导出和哈希链核验；来源/审核操作自动记录，其他重要决定由执行智能体显式归档。建议不自动视为用户确认，实际决议不进入本公开仓库。

```sh
python -m knowledge.decisions --vault /absolute/private-vault export
python -m knowledge.decisions --vault /absolute/private-vault verify
```
