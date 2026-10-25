# 桌面 Codex 真实工人联调

任务：`CODEX-DESKTOP-AUTH-20261025-001`。授权、上限、验收和回执字段以同目录 `input.json` 为准。

本任务供实际桌面 Codex 消费。代码包存在、桌面应用可用、CLI 登录元数据、真实工人推理成功是不同的状态。已正常工作的桌面会话先保留，不预先退出或强制重新登录。

## 运行准备

1. 阅读实际源码的 `AGENTS.md` 和 `input.json`，对输入文件原始 UTF-8 字节计算 SHA-256。
2. 将公开源码放入新的隔离工作目录，检出 `input.json.source_commit`；保留原工作项目与未提交文件。不需要私有仓库读取权限才能取得这份公开代码。
3. 使用 Node 24+ 和官方原生 Codex 可执行文件。Windows 需要实际的 `codex.exe`，不能把 npm 的 `codex.cmd` 当作原生程序交给本适配器。优先定位现有官方安装；缺少程序时可在已授权任务目录使用官方的本地/便携安装，不改管理员或全局系统配置，不引入新账号、权限或费用。
4. 检查同目录的 `probe.mjs` 与 `executed-modules.json`。脚本会核对实际运行的适配器模块指纹，再在临时空目录调用原有只读适配器。

## 执行一次真实联调

将任务包中的脚本与清单保留在一起，源码使用独立固定版本的 checkout。参数需替换为实际本机绝对路径：

```text
node /ABSOLUTE/PATH/TO/TASK/probe.mjs --source /ABSOLUTE/PATH/TO/PINNED/SOURCE --binary /ABSOLUTE/PATH/TO/OFFICIAL/codex --output /ABSOLUTE/PRIVATE/PATH/desktop-auth-report.json
```

Windows 使用本机路径和真正的 `codex.exe`。输出选择新的私有文件，保留结果，不上传原始报告或凭据。脚本最多执行两次适配器调用：一个产出、另一个工人 ID 的复核。两个 ID 属于同一厂商，不宣称跨厂商独立；该上限也不等于厂商内部模型/工具调用或费用硬上限。

只用现有官方 ChatGPT 计划登录，API-key 模式不允许。首次失败即停止，不换任务 ID、模型、登录或输出路径反复重试。程序缺失、配置被拦、授权失败和复核不通过分别记录；不能把所有失败笼统写成 401。

如果适配器返回 `AUTH_REQUIRED` 或官方要求重新登录，只在实际工人节点走官方流程，并把必须由账号持有人完成的身份确认交给用户；不手工替换凭据，不把认证文件/令牌/验证码经聊天传递。

`--synthetic-smoke` 只供开发者检查脚本，不调用远端模型，必须记录 `remote_vendor_authenticated:false`，不能作为本任务的桌面真实联调结果或生成 desktop ack。

## 真实桌面回执

实际桌面 Codex 阅读并执行后生成回执，包含 `input.json.required_receipt_fields`。其中 `consumer_type:desktop_codex` 只能由真实桌面执行端声明；云端作者不得代写。

只回传任务 ID、输入版本/指纹、任务包与源码 commit、程序版本、实际执行阶段/退出码、固定诊断分类及合成计算证据，不回传账号标识、私人文件内容、凭据或原始 stderr。若当前桌面会话已经有获授权的项目协作入口，可回写该入口；没有写权限时就在当前桌面会话展示安全摘要，不能为提交回执申请新的仓库权限。

首轮通过只证明这个桌面节点上的真实只读工人调用可用。常驻调度、跨会话/主机恢复、远程自动领取及跨厂商协作仍需分别验证。
