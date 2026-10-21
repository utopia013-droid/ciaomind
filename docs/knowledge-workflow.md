# 私有知识蒸馏与协同运行手册

这是本地、离线优先的首版证据流程。支持 Python 3.10+，仅用标准库，无数据库服务、API 密钥或付费依赖。当前四角色通过已授权工具人工交接；生成任务包不表示已执行模型。未安装后台进程，不自动发布、评论、私信或购买服务。

## 1. 初始化与指定取材范围

在仓库根目录运行。以下路径必须换成你电脑上的绝对路径；source 与 vault 必须相互独立，且不在任何 Git 工作区。程序会拒绝把资料区放进 Git 工作区。不要使用公共同步目录。

```sh
python -m knowledge --vault /absolute/private-vault init
python -m knowledge --vault /absolute/private-vault add-source /absolute/my-notes --authorship self
python -m knowledge --vault /absolute/private-vault sync
```

`self` 表示该目录中的笔记由本人创作，ChatGPT 导出中的 user 消息属于本人。不要对混合收集的文章、共享账号记录或 AI 代写稿使用这一标记。默认 authorship 为 `unclassified`，其材料可用作上下文，但不能支持个人立场。注册后自动处理目录内的新增、修改和删除；只扫描 `.md`、`.txt`、`.json`，跳过隐藏路径、Git 工作区和符号链接。

来源注册的输出是 source ID。新增来源需要显式再次注册，不能由检索到的文档自行扩大权限。不要把数据复制进公开 Issues、Actions 工件、PR 或聊天中不必要的上下文。

GPT 导出：将导出包中的 `conversations.json` 放入 self 目录。只读当前对话分支（如有 current_node），保留 user/assistant 等角色与消息时间；不支持的 JSON 会记录解析失败。图片、音频、PDF 和手机 App 内部数据暂未接入；先导出为可核对文本。Muse 为可替换入口，尚未接通；不能声称可直接访问全部 GPT 历史或手机。

## 2. 四角色交接与结构化结果

```sh
python -m knowledge --vault /absolute/private-vault pack extract
```

输出本地任务目录，包含 TASK.md、input.json、output.example.json。将该目录交给你已授权的研究工具；数据包含原始私人材料，任何外部提供商的使用必须符合你选定的资料范围。模型没有 shell、外部发送、扩权或发布权限。将返回 JSON 保存到资料区之外的私有工作目录：

```sh
python -m knowledge --vault /absolute/private-vault import-result /absolute/private-result.json
python -m knowledge --vault /absolute/private-vault pack verify
# 导入核验结果后，再依次 pack challenge、导入，pack synthesize、导入。
```

提炼结果为 `job_id, phase, claims[]`；每条 claim 有 `statement, kind, evidence[{id,quote}], conditions, counterevidence`。kind 为 principle/judgment/preference/experience/hypothesis。复核结果为 `job_id, phase, assessments[{claim_id,outcome,reason}]`，outcome 为 pass/revise/reject。

系统硬性校验逐字引用、作者角色、作业版本和前置复核；内容真实含义、问题/主张、引用归属、适用边界由复核智能体与本人判断。程序不能证明模型审查正确或确为不同模型。任何一阶段 revise 会进入 needs_revision，重新提取并重新复核；reject 保留为拒绝记录，不自动复活。修改原文会使相关结论失效。一次表达不自动计为长期原则，多份重复材料不用于计算支持票数。

每次生成新 attempt，防止空结果无法重跑。旧快照、重复结果、覆盖不完整的复核会被拒绝；导入事务失败时不留下半条观点。模型返回的 public/confirmed 字段不能绕过人工确认。

## 3. 人工确认与公开边界

```sh
python -m knowledge --vault /absolute/private-vault report
python -m knowledge --vault /absolute/private-vault review CLAIM_ID confirm
# 只有本人明确允许公开时，才另加 --public：
python -m knowledge --vault /absolute/private-vault review CLAIM_ID confirm --public
python -m knowledge --vault /absolute/private-vault export-public
```

三阶段复核均 pass 后才能确认。确认不等于公开授权；默认 private。公开导出只包含已确认且允许公开的主张、类型与 ID，不含原文、路径、复核意见或私人上下文。此文件仍留本地，不等于已发布。修改审核状态会清除旧导出与报告。

`report` 输出 weekly-review.json，包含所有有效候选、待修改/拒绝/已确认观点、复核理由、来源失败和未知项，可在你选择的私有文档系统中阅读。同一命令可每日或每周调用；不会向手机推送。

对经济日报与社媒内容，使用公开许可的主张作表达约束；经济事实仍需另行检索一手来源，保留数据所属期、发布日期、传导机制和不确定性。本模块不包含经济新闻抓取器、自动翻译或社媒发布连接，不能将观点库当成已核实的新闻来源。

## 4. 增量运行、撤销与治理

```sh
python -m knowledge --vault /absolute/private-vault run
python -m knowledge --vault /absolute/private-vault disable-source SOURCE_ID
```

`run` 是一次 sync + extract 任务包，不调用模型。可在实际运行电脑上用系统任务计划每日调用，然后每周调用 report；需设置仓库工作目录和 Python 的绝对路径。不要在公开 GitHub Actions 中运行私料采集。Windows 可用任务计划程序，macOS 可用 launchd；应先手动验证相同命令，机器休眠/关机期间不保证运行。当前未安装这类计划，也没有可用于验证的用户电脑连接。

来源暂不可访问记为失败，不当成用户删除。检测到的文件修改/删除会撤销关联结论、删除旧引文及依赖它的复核，并清理所有旧任务包、报告与导出。禁用来源会执行相同清理，不删除用户原始文件。SQLite 启用 secure_delete，sync/禁用后 VACUUM；这只清理当前数据库的逻辑副本，不承诺清除操作系统备份、云端版本、外部模型记录或 SSD 历史数据。自行交给模型的结果文件、导出副本也需在撤销时手动删除。

公开导出前自动 sync；任何来源错误都阻止本次公开导出，避免继续使用未经核实的来源。私有审查报告可保留失败信息用于排查。默认文件权限为目录 0700、文件 0600（Windows 仍需配置相应账户 ACL）。单写入进程运行，不应多个任务同时操作同一 vault。资料无应用层加密，应配合系统磁盘加密；不要将整个 vault 放进公开云盘。

状态与职责：candidate → verify → challenge → synthesize → 本人 confirmed，public 是独立授权。source 修改/删除 → stale；需要新证据重提炼。核心原则、身份事实、重大立场、新来源和对外规则由本人确认；分类、去重、格式和引用检查由流程完成。

## 5. 验证与下一连接

```sh
python -m unittest discover -s tests -v
```

验收覆盖用户/助手归属、当前分支、增量幂等、伪造引用、陈旧作业、原子导入、重复导入、前置审查、公开授权、撤销、删除清理、路径越界和来源中断。实际模型未通过 authenticated E2E 前，运行状态始终是人工交接。以后接提供商时，只实现读取 task pack 和返回相同 JSON 的适配器；不改变权限和审查门槛。需另行配置身份、预算及数据使用范围，不把 ChatGPT 订阅当 API 额度。

产业/商业方向先以真实资料提炼可服务问题，再验证研究服务、专业社区、产业资源对接。评估指标优先有效回应、合作进展、本人审核时间和维护成本；没有原始资料支持的行业身份保持未知。
