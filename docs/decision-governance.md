# 决议归档与追溯

每个重要决定必须形成一份决议文本。重要决定包括：目标与范围、核心立场确认、资料来源和外发权限、预算与订阅、提供商及模型/提示策略切换、质量门槛、发布与对外动作、部署/合并、以及推翻既有决定。日常去重与格式整理不单独制造决议。

## 决议内容与确认边界

每份记录包含：编号、记录时间、责任人、记录者、决议正文、理由与取舍、依据、备选方案、范围、生效条件、复审触发点、关联主张、拟替代决议、状态和确认依据。

状态：proposed建议待确认；accepted已记录明确确认依据；implemented实施记录；needs_review证据失效待复审；rejected拒绝；revoked撤销；superseded被后续决议替代。实施记录可来自已授权的技术操作，不能据此声称本人确认了核心观点。程序校验确认依据是否填写，不能独立认证操作者身份或判定该依据真实有效。

预算、新提供商、扩大资料范围、降低质量门槛、核心立场和对外规则仍需明确确认。没有确认的建议不能因“已经归档”自动生效。决议状态不直接配置API、提高预算或发布内容。

## 私有存档与命令

决议保存在私有vault的SQLite追加历史中，导出到独立的decision-archive目录，不进入公开Issues、PR、Actions工件或Git文件。公开仓库仅存通用程序与模板说明。

```sh
python -m knowledge.decisions --vault /absolute/private-vault record /absolute/private-decision.json --actor local-operator --reason '创建决议草案'
python -m knowledge.decisions --vault /absolute/private-vault export
python -m knowledge.decisions --vault /absolute/private-vault verify
```

输入JSON字段：title、decision、rationale、scope、owner、authority、effective_when为非空文本；basis、alternatives、review_triggers、related_claim_ids、replaces为文本数组；status为上列状态。basis与review_triggers至少一项。accepted额外要求approval_reference。不要把大段原始对话、客户信息或密钥复制进永久决议，尽量保留依据指针。

更新状态需指定`--id DEC-... --expected-revision 1`，防止覆盖刚发生的修订。已确认/实施后的实质内容变化需要新建决议，通过replaces关联旧决议。该关联只是“拟替代”，不会因草案创建就自动废止旧决定；新决定生效后再显式追加旧记录的superseded状态。撤销、拒绝、已替代的记录不能直接复活。

每条历史含前序哈希与自身哈希，可用verify检测内容修改、链断裂与修订异常。当前哈希链没有外部可信锚点、独立签名或防删尾设施，不能宣称绝对防篡改或法定签署；它主要用于本地一致性与追溯。

导出index.md为入口，每份最新决议有独立Markdown；history.jsonl保存全部版本和哈希，便于后续迁移与核对。Markdown是可重建视图，SQLite是记录源。导出拒绝归档目录/目标文件的符号链接，仅原子替换自身生成的视图，不删除同目录的其他文件。请将备份留在受控私有位置；本文不把本地追加历史等同于永久云端保存。

## 自动记录与执行规则

目前自动记录：资料源登记、资料源停用、核心主张confirm/reject及公开许可操作。只保存ID和操作详情，不复制原始证据段落。来源变化使已关联的主张失效时，相应accepted/implemented决议自动追加needs_review，保留历史且不继续作为当前生效依据。新的人工审核操作会显式替代旧操作记录；审核结果或公开许可改变时，依赖旧状态的实质决议同步标记needs_review。重复相同审核不使无变化的实质决议失效。

自动记录与操作处于同一数据库事务，记录失败会阻止该操作提交。之后重建文本索引；若导出失败，可重新export，不会抹去已提交的历史。资料清理不会删除决议档案；因此决议正文应避免复制可撤销来源的敏感内容。误写私料需另行设计受控清理及链重建，不能偷偷删除历史。

其余重要决定由承担该任务的智能体在执行前或实施交付时显式record；已在AGENTS.md中确立。当前不能自动捕捉所有App/未来聊天的决定，也没有为所有外部动作设置统一拦截器，不能声称已经实现全应用自动归档。

本阶段未实施外部发布、自动合并或采购。相关动作真正发生前，必须有相应决议和授权；记录动作本身不赋予额外权限。
