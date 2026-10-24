# Hermes 完整官方镜像的本地单层安装

已核验的上游amd64镜像为：

```text
nousresearch/hermes-agent@sha256:fd822bae0a61bf023450737edbeaeea5fc6460f17cb4ee240a7e67b306ed63fb
```

官方文档中的`0.22.5`标签当时返回manifest unknown，因此按stable的不可变digest取完整内容，再由实际CLI核验版本。实测版本为`Hermes Agent v0.22.5 · upstream bf0203a7`，Python3.14.9。

当前Docker使用vfs，多层镜像拉取会产生大量重复文件。此次使用按GitHub发布校验和验证的crane0.22.1导出正确合并的完整rootfs tar（3,081,224,192字节），再docker import为单层；上游Env/User/WorkingDir/Entrypoint/Cmd按公开Config保留并回读核对。导出和导入记录在本目录。

本地镜像`ciaomind-hermes-flat:20261024`的ID与上游OCI digest分别记录。这是本地重打包，不是原上游镜像digest，也没有删依赖来模拟安装。临时rootfs tar在成功导入后删除；不修改daemon存储驱动或清理其他项目镜像。

普通overlay存储的独立环境可直接拉取上述固定digest，无需此处的vfs处理。此次安装和CLI测试证据见 [hermes-verification.json](../../docs/hermes-verification.json)。执行禁网、非root、只读镜像、tmpfs独立HOME且不挂宿主文件；未登录模型、启动聊天/gateway或导入个人历史。
