# OpenClaw / DeepSeek Harness 隔离安装记录

实际镜像 `ciaomind-node-runtimes:20261024` 安装 OpenClaw `2026.10.7` 与 DeepSeek Harness `0.2.1-rc.2`。后者是 developer preview。各包的上游 npm metadata、完整性值和此次安装生成的传递依赖锁文件保存在同目录。

Dockerfile记录实际安装步骤，固定Node基础镜像digest和两个顶层包版本。REA的构建使用npm ci；这里的原始安装步骤使用npm install，未来重建可能解析到不同的传递依赖，复现须利用本次导出的package-lock核对完整依赖图，不可只比较顶层版本。

所有依赖生命周期脚本先禁用；仅在无网络构建层运行已审阅的OpenClaw官方postinstall，完成它要求的本地生命周期。没有运行onboarding、gateway或模型任务。原生/可选功能未全面验收。

构建需保持当前环境代理与CA信任：

```bash
docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" -t ciaomind-node-runtimes:20261024 integrations/node-runtimes
```

CLI检查在无网络、非root、只读镜像和独立可写tmpfs HOME中运行；结果见 [node-runtime-verification.json](../../docs/node-runtime-verification.json)。版本/help通过只说明本地CLI能启动，不代表模型、渠道、私有上下文或后台工人已接通。
