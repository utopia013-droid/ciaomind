# 离线任务底座

Node.js 24+，仅使用内置模块。运行不依赖模型凭据；`dispatch` 只输出 JSON 任务包，不启动 Codex、Dots、shell 或其他工人。

```bash
node control/cli.mjs --help
node --test control/core.test.mjs
node control/demo.mjs
```

`demo` 用临时私有数据库、合成数字和本地计算验证协议，随后删除临时数据。它验证重开恢复和状态闭环，不代表真实智能体已接通或独立身份已认证。

## 人工文件交接

数据库和任务包放在仓库之外的私有目录。以下命令从 `apps/alliance-agent` 执行；先由用户选择真实私有目录，示例使用 `$CIAOMIND_DATA_DIR`。

```bash
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" create --file control/examples/task.json
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" dispatch CIAO-LOCAL-001 > "$CIAOMIND_DATA_DIR/packet.json"
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" show CIAO-LOCAL-001
```

已授权工人读取 `packet.json` 后交付 `result.json`。结果必须包含原包的 `task_id`、`input_version`、`input_sha256`、`attempt_id`，且 `producer` 与原包的 `worker` 一致，另有 `output` JSON 与非空 `evidence` 字符串数组。例如把结果的身份字段从真实任务包复制，不能使用下方占位符提交：

```json
{
  "task_id": "CIAO-LOCAL-001",
  "input_version": 1,
  "input_sha256": "COPY_FROM_PACKET",
  "attempt_id": "COPY_FROM_PACKET",
  "producer": "manual",
  "output": {"total": 16},
  "evidence": ["3 + 5 + 8 = 16; synthetic input only"]
}
```

```bash
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" submit --file "$CIAOMIND_DATA_DIR/result.json"
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" review CIAO-LOCAL-001 --attempt ACTUAL_ATTEMPT --reviewer muse --decision accept --evidence 'Independent recomputation confirmed 16'
node control/cli.mjs --db "$CIAOMIND_DATA_DIR/tasks.sqlite" events CIAO-LOCAL-001
```

身份字符串只是可信本地操作者提供的审计标签，不能验证是谁执行或审查。底座拒绝相同标签的自验收，但独立验收仍需由真实另一操作者完成；不得把这个接口直接开放给不可信网络调用者。Eve 适配层不应向模型暴露验收权限。

## 协议

- 路由由显式 `kind` 决定：`code → codex`、`office → workbuddy`、`research → manual`；`sensitive → human` 且保持 blocked。此分类不是内容风险识别器，任务包也没有执行权限。
- `input_sha256` 是键排序的规范 JSON `{input_version,kind,input}` 的 UTF-8 SHA256；所有字段与数组顺序保留。任务输入不可变；相同 ID/输入创建幂等，改变输入必须使用新任务 ID。
- 输入只接受普通 JSON 数据属性；对象/数组上的 getter、setter、symbol、额外数组属性及非枚举数据均被拒绝，不调用 `toJSON`。先规范化输入快照，再从同一快照计算摘要与保存数据。
- 按 UTF-8 编码后的规范 JSON 计算大小：输入上限 900,000 字节，完整派发包上限 1,100,000 字节，结果和审计明细上限 1,000,000 字节。输入与包的不同上限为派发字段留出空间；超限输入在创建前拒绝，不留下无法派发的 queued 任务。
- `queued → dispatched → review → done`。派发使用 SQLite `BEGIN IMMEDIATE` 原子事务，重试派发返回相同 attempt，不重复发事件；文件包的实际领取仍为手工。
- 输入摘要、版本、当前 attempt 或 producer 不符时拒绝结果。结果不可变，相同结果重复提交幂等；不同结果须经 reject、显式 retry、新 attempt。
- `pause` 阻止新的派发、提交与验收；`resume` 恢复原状态。暂停不能撤销已经交给外部工人的工作，因为本版没有外部进程控制。
- `retry` 仅用于 dispatched/blocked，需明确原因；它清除当前派发并使后续派发生成新 attempt，旧结果将被拒绝。工人可能已执行副作用，因此本版只用于文件交接与无副作用任务，不自动重试外部动作。
- `reject` 保留结果与审计事件，进入 blocked；sensitive 任务不能通过通用 resume/retry 解锁。
- 数据库内保存任务输入、结果和审计元数据，应放在用户选定的私有目录。测试和演示只用合成数据。

## 嵌入接口

从 `control/core.mjs` 导入 `ControlPlane`；完整 TypeScript 签名见 `control/core.d.mts`。

```js
const plane = new ControlPlane({ dbPath: '/private/data/tasks.sqlite' });
try {
  plane.createTask({ task_id: 'CIAO-001', kind: 'research', input: { goal: '...' } });
  const packet = plane.dispatch('CIAO-001');
} finally { plane.close(); }
```

实现依据：[Node.js v24.19.0 SQLite 官方文档](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)。使用同步连接、参数绑定、事务与文件数据库；不启用扩展加载。
