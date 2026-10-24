# REA 与现有任务协作

[morluto/rea](https://github.com/morluto/rea) 是 Reverse Engineer Anything，MIT 许可。本次安装正式包 `rea-agents@6.7.0`，接入其无需模型的静态 JavaScript 分析；版本、依赖锁、镜像ID和合成验收见 [rea-verification.json](rea-verification.json)。源码镜像使用的 main 提交与正式 npm release 提交分别记录，不能混用。

## 已实现的工作流

授权源码 → 选择 JS/TS 和 package.json → 生成不可变字节快照 → 断网 REA 容器静态分析 → Evidence、stderr、退出码、覆盖率 → 任务回执 → 独立审查与实现任务。

适合：理解既有项目结构、梳理实现线索、对比公开项目的功能方案，给 Codex 后续开发任务提供可引用的证据。Native provider、运行时进程附加、专有应用反编译、MCP 注册和自动生成完整产品本次均未验证。

## 构建隔离镜像

此适配器当前仅在 Linux 与本机 Docker socket 验证。镜像构建材料在 `integrations/rea/`，固定基础镜像 digest 并使用 `npm ci` 与锁文件。构建需要联网；运行分析时关闭网络。

在当前云环境按运行时的 CA/proxy 约定构建（CA 仅经 BuildKit secret 挂载）：

```bash
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t ciaomind-rea:6.7.0 integrations/rea
docker image inspect --format '{{.Id}}' ciaomind-rea:6.7.0
```

其他 Linux 环境须给同名 secret 提供其实际可信 CA bundle，保持 TLS 验证开启。镜像 ID 取本机构建或已核验镜像的完整 `sha256:` 值，不以可变 tag 执行任务。

## 输入与执行

真实源码和 input.json 留在控制仓库外。输入严格只有四字段：

```json
{
  "task_id": "your-task-id",
  "input_version": 1,
  "operation": "javascript_static",
  "source_path": "source-directory"
}
```

`source_path` 相对 input.json 目录解析。操作人另通过命令行提供已安装的本地镜像 ID，任务数据不能选择镜像或命令。使用新的输出目录运行：

```bash
python scripts/rea_worker.py run --input examples/rea/input.json --output /tmp/ciaomind-rea-demo-001 --image sha256:6dba4120bc1f29c251160a99f06766a0f05546fb96f4da9a04fc3318083c6806
```

示例源文件含写文件和 throw 验收标记，只供静态解析。适配器不运行目标代码。

## 产物和限制

输出含 `analysis.json`、`stderr.txt`、`exit-code.txt`、`source-manifest.json`、`tool.json` 和 `result.json`。回执绑定原输入字节 SHA256、已消费源文件清单的规范化树指纹、镜像 ID、真实库版本和各产物 SHA256。

只复制 JS/MJS/CJS/TS/TSX/JSX 与 package.json，不挂原始仓库、.git、node_modules、密钥、其他资料或 Docker socket。最多 2000 个选中文件、25 MiB；拒绝 symlink。容器网络关闭、非root、只读根文件系统、移除全部capability、禁止提权，限制内存/CPU/进程和120秒超时。

已有输出或仓库内输出被拒绝。退出非0、报告无效或缺少可检查覆盖事实时不生成成功回执；解析或图覆盖不完整则返回 `partial`。`completed` 只代表这份选中文件快照的静态分析完成，不等于业务验收完成。原报告可能包含源码或路径，只存本地；PR用合成或脱敏证据。

## 本次验证

- 合成项目：3文件、649字节，解析2个JS，失败0，覆盖complete；目标写文件和throw没有执行，输入/源树/产物指纹已回算。
- 真实CIAOMIND官网：[固定源码版本](https://github.com/utopia013-droid/ciaomind-website/tree/6a1d6e1c11ddd1d8fee09afbf15e2d0435c48b98)共选取52文件、95,086字节，解析51个JS/TS、失败0。因REA结果预算限制，关系图只获得partial覆盖；[回执摘要](website-rea-verification.json)保留遗漏与资源限制，未修改官网或部署。
- Windows桌面领取、后台同步、完整业务还原与其他REA provider仍待各自实测。
