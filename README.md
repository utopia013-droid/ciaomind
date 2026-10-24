# CIAOMIND AI 任务调度台

状态：任务入口可用；模型自动执行尚未接通。

## 使用
1. Issues → New issue → AI任务，填写目标与验收条件。公开仓库禁止填写客户资料、财务、家庭信息、密码或密钥。
2. Actions → Prepare task → Run workflow，填写 Issue 编号与执行工具。
3. 下载 task-pack 工件，把 TASK.md 交给已登录的 Codex / Claude Code 等工具。工具是否可用取决于你的账户权限。
4. 执行工具在独立分支工作、提交 PR；检查通过后人工合并。

此版本只打包任务，不调用模型、不创建订阅、不保证任何第三方已接通。研究与办公任务可使用同一入口，但无需强制生成代码 PR；交付来源、文档与验收结果。

## 下一阶段
先验证一个 Codex 任务完成 Issue → 分支 → PR → 检查，再接一个低价 API；不要同时购买多个工人。API 自动执行需要单独的密钥和预算配置，不能假定 ChatGPT 订阅覆盖 API。

请保留调度记录；不得把 Issue 文本直接拼接到 shell 执行。

## 开源工具层

已提供 MarkItDown 文档转换、Trafilatura 本地 HTML 正文提取、DuckDB 本地 CSV 概况的统一适配器。执行者可在任务中调用，输入/结果以任务 ID、版本和 SHA256 回读。版本由 `uv.lock` 锁定，不调用模型 API。

安装、示例与实际验收边界见 [开源工具协同](docs/oss-tools.md)。它补充当前任务入口；常驻执行、Windows 桌面领取与模型 API 接入仍需各自验证。

## 全站高星前 20 与 REA

[2026-10-24 全站前20逐项融合记录](docs/github-top20-20261024.md)列明星数快照、实际许可、用途和验证状态。源码参考、本地技能资料、隔离 CLI 与已完成任务分别记录。

```bash
python scripts/project_catalog.py list
python scripts/project_catalog.py route --capability code_review
python scripts/mirror_projects.py --root /tmp/ciaomind-project-sources
python scripts/project_catalog.py search --root /tmp/ciaomind-project-sources --query database --limit 5
```

REA 的 Linux/Docker 任务适配器见 [REA 使用说明](docs/rea-integration.md)，输入与结果沿用任务ID、版本及SHA256契约。它可对经过筛选的本地JS/TS源码做静态分析；解析失败和覆盖不足会保留在回执中。
