# 桌面总控接续试点

任务 `CODEX-DESKTOP-CONTINUITY-20261025-001`，基线源码 `4a0942a9d3d7130aad2a3da52fad965f6f4e1623`。这是桌面真实授权联调之后的下一份试点交付物：把已有回执的一致性核对与总控本地恢复验证组合成可重复执行的任务包。

## 已确认与验证边界

- 前序桌面 live probe 已通过，回执见 [#26](https://github.com/utopia013-droid/openclaw-space/issues/26#issuecomment-6402168932)。该任务已用完两次适配器调用。
- 本包只配置两个 demo 工人，不调用 Codex/Gemini，不重新登录或验证厂商授权；`remote_vendor_authenticated:false` 指本次离线运行。
- 核验前序回执的身份、输入指纹、版本、调用数和验收字段，只能证明回执字段一致。它不是密码学签名、独立厂商认证或完整的人类授权系统。
- 用多个独立 CLI 进程验证 SQLite 保存后的继续执行、暂停、取消、预算和完成后去重。正常进程退出后的恢复不等于在途调用崩溃恢复、主机重启、VM 更换恢复或全天候服务。

## 运行

使用 Node 24+、Git 与独立固定版本源码目录。先读取该源码的 AGENTS.md。输入 `--receipt` 必须是前序真实桌面执行端生成的脱敏回执，不能用云端预检或 synthetic smoke 代替。

```powershell
node .\tasks\desktop-continuity\run.mjs --source 'D:\ABS\pinned-source' --receipt 'D:\PRIVATE\sanitized-desktop-receipt.json' --output 'D:\PRIVATE\new-continuity-report.json'
```

输出必须位于源码之外，使用新的文件名。程序不覆盖已有文件。Windows 应选择已经限制 ACL 的私有目录；POSIX 的文件 mode 不能代替 Windows ACL。SQLite、合成任务输入和显式 demo 配置保留在输出旁的新建 `continuity-state-*` 子目录中，供本机检查，不提交入仓。

成功退出 0，失败退出 2；失败只输出固定分类，不回显输入、环境或 stderr。最多 40 个本地 CLI 进程，新增远端适配器调用额度为 0。报告中的 `calls_reserved` 是 demo 总控内部的本地调用预留，不能计作真实厂商请求或新增费用。

防误用检查：

```powershell
node .\tasks\desktop-continuity\checks.mjs --source 'D:\ABS\pinned-source'
```

## 验收和下一步

参见 `input.json` 和 `VERIFICATION.json`。实际本机证据为合成任务与子任务完成、内部预留 5/10、新增远端调用 0。代码产出方的检查不替代 Muse 的独立回读。

下一阶段真实 Director 目标闭环尚未执行。它包含规划、计划审查、执行和原目标审查，需要单独定义并授权总调用预算；不能沿用已耗尽的两次额度。当前可用执行路径为本机桌面，云端历史 401、Gemini/Grok、常驻宿主仍分别保留原状态。后续交付应包括独立回读、限定的真实主旨任务契约、失败即停策略及主机恢复验收；本包不启用 cron、服务或生产调度，不修改已有控制层，也不新增权限或密钥。
