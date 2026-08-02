# Triage 与待验证项

审计日期：2026-07-28

## 已确认但未修复

| ID | 阻塞/缺口 | 下一步有界实验或补丁 | 完成证据 |
|---|---|---|---|
| AX-001 | 无 agent-first 入口 | 从 live gate 抽取 domain bootstrap service，实现 `wxmp_open/doctor/close` | initialize 后最多 2 次调用得到 snapshot 或明确 user action |
| AX-002 | 未知 envelope payload 丢失 | 先加 bounded recorder，不新增猜测 decoder | v19977 capture 中 `setupContext/customMessage` 有 size/hash/artifact/category histogram |
| AX-003 | context identity 平面化 | 引入 context graph 并保存 provenance/confidence | live gate 不再靠调用者循环 probe/select；五个 context 能区分或明确 unknown |
| AX-004 | breakpoint normalize 错误 | 合并 `locations` 与 `actualLocation` | 两种 CDP breakpoint method 的 contract/live gate 均通过 |
| AX-005 | inventory 消费 hook buffer | 改为 cursor-based peek | inventory 后 detail 仍可读取同一 records |
| AX-006 | replay 固定 fetch | 记录 transport 并实现 same-transport replay | `wx.request`、fetch、XHR fixture 分别保持语义；降级显式返回 |

## Runtime-pending

### 1. 多 context ID 是否碰撞

- 假设：WMPF bridge multiplex 多个 logical context 时，CDP `scriptId`/`requestId` 可能只在 context 内唯一。
- 实验：同时保留两个 context，在两边各创建 sourceURL script 并发起 fixture request，记录 `(contextId, scriptId/requestId)`。
- 通过：证明全局唯一并固化测试，或将 map key 改为 composite key。

### 2. WMPF context 与 CDP execution context 的真实映射

- 假设：`addJsContext.jscontextId`、ChromeDevtools inner `jscontextId` 与 `Runtime.executionContextCreated.context.id` 不是同一命名空间。
- 实验：recorder 同时保存 envelope metadata、inner jscontextId、CDP execution context event，按时间和命令响应做关联。
- 通过：形成一对多/多对多 graph fixture，不再直接合并 ID。

### 3. `domOp/domEvent` 的 UI 能力边界

- 当前只知道 category 名，未保留 payload，不能宣称可做组件树或交互。
- 实验：v19977/v20079 分别录制页面进入、点击、输入、滚动期间的 DOM categories，先做 payload corpus 和字段稳定性分析。
- 通过：有真实 fixture、decoder round-trip、页面 snapshot parity；否则保持 CDP DOM/Input fallback 和 `triage-only` 标记。

### 4. AppID 与 package correlation

- 当前 main browser target 往往没有 `--wmpf-appid`，而 renderer/process tree、servicewechat URL、runtime config、package root 可能各给出候选。
- 实验：对同一 session 同时采集四个来源，比较 AppID 和版本一致性。
- 通过：输出候选、provenance、confidence；冲突时不自动选择。

### 5. v20079 完整 semantic gate

- 当前证据只覆盖 Profile/AOB/hash-binding 和 production attach/detach。
- 实验：复用 v19977 同序列 gate，覆盖 AppService、evaluate、breakpoint、trace、hook、Network body、replay、reconnect、detach、evidence。
- 通过：acceptance manifest 明确标为 full-semantic；未通过前不得宣传同等级支持。

## 外部状态限制

- 真实 WMPF bridge 可能仍要求目标小程序前台切换或 reload；这类外部状态变化可以保留为一次明确的 `needsUserAction`，但 session/context/hook 管理不应再交给用户。
- GPL-2.0 或未声明许可证项目只作行为对标；实现和测试 fixture 必须 clean-room 生成。
- 不引入 GUI、SSE、always-on daemon，也不伪造 handshake-free bridge 的并发能力。
