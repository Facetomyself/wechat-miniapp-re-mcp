# Agent 使用体验与 WMPF 协议深度审计

- 审计日期：2026-07-28
- 审计对象：`wechat-miniapp-re-mcp` `fix/project-review-p0` @ `6de6b79`
- 审计类型：代码、MCP contract、既有 live evidence、外部实现对标
- 结论等级：代码事实已确认；涉及真实 WMPF 行为的未复核项单独标记为 `runtime-pending`

## 1. 执行摘要

当前项目是一个测试扎实、证据纪律不错的 WMPF transport/CDP 原语集合，但还不是一个 agent-first 的微信小程序领域 MCP。用户觉得“手动步骤多、不像 MCP”是准确反馈，不是文档没看明白。

根因有三层：

1. **产品面错位**：server 只发布 53 个平铺 tools，没有 initialize instructions、prompts、resources、structured output 或 tool annotations。README 中的推荐工作流不会自动进入模型上下文，Agent 只能自己拼接状态机。
2. **协议面没有学习闭环**：本地 codec 只声明 4 个 protobuf message；对未知 WMPF category 只保留 `seq` 和 `compressAlgo`，原始 payload、长度、hash、`after`、`originalSize` 全部丢失。协议未知不是最大问题，未知数据被扔掉才是。
3. **领域面太薄**：上下文模型混合了 WMPF logical context 与 CDP execution context，没有 AppService/WebView/Worker/page/app 的图关系；runtime probe 主要返回布尔值，静态 index 主要靠 regex，无法直接回答“当前是哪个小程序、哪一页、有哪些分包/组件/API、动态请求对应哪段源码”。

因此下一版不应继续以 tool 数量或验收脚本为主，而应先交付一个 `wxmp_open`/`wxmp_bootstrap` 入口，把 target、Profile、attach、runtime wait、context graph、passive capture 和 app snapshot 收口为一次确定性调用。漏洞判断继续留给 skill，但生命周期与领域取证编排必须回到 MCP core。

## 2. 已复核基线

| 项目 | 结果 | 证据 |
|---|---:|---|
| Tool 数量 | 53 | `README.md:356-366`、本地 `buildTools()` 实测 |
| `tools/list` JSON 大小 | 21,769 bytes | 本地 SDK 对 `buildTools()` 序列化实测 |
| Required 参数总数 | 73 | 本地 schema 汇总实测 |
| `outputSchema` / annotations / title | 0 / 0 / 0 | `src/tools/helpers.ts:13-15` 与本地 tool metadata 汇总 |
| Server capability | 仅 `tools` | `src/server.ts:14-19` |
| 当前验证 | 99 tests，typecheck、contract、acceptance、smoke 全通过 | 本轮 `npm run check` |
| 当前分支相对 `main` | +2,755 / -105 | `git diff --stat main...HEAD` |
| v19977 live gate | passed | `D:\reverse_ENV\workspace\live-verification\wechat-miniapp\live-semantic-gate-v031-1784111644618.json` |
| v20079 完整 semantic gate | pending | `README.md:134-138` |

当前分支的主要增量是 acceptance manifest、live runner、测试和文档治理。它提升了“能否证明底层原语工作”的可信度，但没有减少用户调用次数，所以体验没有改善符合代码事实。

## 3. Findings 总览

| ID | 优先级 | 状态 | 发现 |
|---|---|---|---|
| AX-001 | P0 | confirmed | 缺少单一 agent entrypoint，确定性生命周期编排泄漏给调用者 |
| AX-002 | P0 | confirmed | 未知 WMPF envelope payload 被丢弃，协议无法持续演进 |
| AX-003 | P0 | confirmed | WMPF context 与 CDP execution context 混为一个平面 map |
| AX-004 | P0 | confirmed | script breakpoint 忽略 `actualLocation`，真实绑定仍报告 0 |
| AX-005 | P0 | confirmed | API inventory 以 `drain()` 读取 hook，读操作会消费后续证据 |
| AX-006 | P1 | confirmed | replay 无论来源都改用 `fetch`，不保留 `wx.request` transport 语义 |
| AX-007 | P1 | confirmed | Network capability 是 session 级，trace/hook 是 context 级，状态粒度不一致 |
| AX-008 | P1 | confirmed | 微信领域 snapshot 缺失，AppID、launch、page stack、storage 等不能直接获得 |
| AX-009 | P1 | confirmed | 静态 index v1 只做 URL/API/route regex，没有解析小程序 manifest 语义 |
| AX-010 | P1 | confirmed | 默认暴露维护型与重复 tools，扩大模型选择面和 schema 成本 |
| AX-011 | P1 | confirmed | 成功/错误都是 text JSON，错误不携带统一恢复语义 |
| AX-012 | P2 | runtime-pending | `scriptId`/`requestId` 仅按 ID 建索引，多 WMPF context 下碰撞边界未验证 |

结构化版本见 [`findings.json`](findings.json)，待实机验证项见 [`triage.md`](triage.md)。

## 4. 根因一：协议合规，但不是 agent-first MCP

### 4.1 README 工作流没有进入 MCP 上下文

`src/server.ts:14-19` 只声明 `{ capabilities: { tools: {} } }`，没有 server instructions，也没有 prompts/resources capability。`src/tools/helpers.ts:13-15` 只生成 `name + description + inputSchema`；`src/tools/helpers.ts:59-60` 把成功结果包成 text JSON。

模型真正收到的是 53 个 tool schema，而不是 `README.md:249-272` 的推荐流程。当前标准动态链至少需要：

```text
health
  -> list_targets
  -> attach
  -> wait_for_runtime（可能）
  -> probe_contexts
  -> select_context
  -> capture/trace/hook
  -> query
  -> stop
  -> export
  -> detach
```

这不是“保留底层控制力”，而是把确定性状态机转嫁给 Agent。更讽刺的是，`scripts/live-semantic-gate.mjs:335-435` 已经实现 attach、wait、循环 probe、二次 runtime probe、候选选择和 select，但这套成熟编排只服务 CI，不服务 MCP 用户。

### 4.2 MCP 与 skill 的边界划错了

`docs/roadmap.md:75-76` 正确地把 IDOR/auth/sign 等启发式判断留给 skill，但路线图没有把“确定性领域编排”单独列出来，MCP 体验只在 P1 处理 structured contract 和 debugger 原语（`docs/roadmap.md:83-88,137-188`）。

建议按下面的边界执行：

| 应在 MCP core | 应在 skill/report pipeline |
|---|---|
| target discovery/selection | 选择研究目标和攻击面 |
| Profile gate 与 attach/reconnect | 解释 Profile 风险与版本策略 |
| context graph 构建与默认选择 | 决定深挖哪个业务 context |
| bounded capture window | 设计业务触发场景 |
| app/page/runtime snapshot | 解释页面和状态的安全含义 |
| package/runtime correlation | 判断签名、鉴权、IDOR 等候选 |
| provenance、cursor、evidence export | 汇总结论与证据链 |

判断标准很简单：输入和状态相同就应得到确定结果的编排，放 MCP；需要研究假设和漏洞判断的编排，放 skill。

## 5. 根因二：协议未知数据被丢弃

### 5.1 本地协议面

`src/transport/codec.ts:6-24` 只声明：

- `WARemoteDebug_DebugMessage`
- `WARemoteDebug_ChromeDevtools`
- `WARemoteDebug_AddJsContext`
- `WARemoteDebug_RemoveJsContext`

这足以转发 CDP 和接收最基本 context lifecycle，但不等于掌握 WMPF remote debug protocol。

外部 clean-room 调研参考 `evi0s/WMPFDebugger` 固定提交 `7763acb878d3b45533cae7eefd06f5570475399d`：其提取的 generated protobuf 文件包含 55 个 `WARemoteDebug_*` constructor；category 常量有 19 个，包括 `setupContext`、`callInterface`、`evaluateJavascript`、`ping/pong`、`domOp/domEvent`、`networkDebugAPI`、`connectJsContext`、`engineEvent/engineOp`、`customMessage`。该仓库是 GPL-2.0，只能作为协议词汇和行为对照，不能复制实现进 MIT core。

### 5.2 真正阻断协议进化的是 recorder 缺失

`src/transport/bridge-server.ts:76-90` 解出 envelope 后，只记录：

```json
{
  "seq": 1,
  "compressAlgo": 0
}
```

只有 `chromeDevtoolsResult`、`addJsContext`、`removeJsContext` 会继续 decode。其他 category 的 payload、`after`、`originalSize`、decoded length 和 hash 都没有进入 evidence。

已有 v19977 live evidence 实际观察到：

- `wmpf.setupContext`: 3
- `wmpf.customMessage`: 51
- `wmpf.chromeDevtoolsResult`: 982

也就是说，运行时已经把协议样本送到门口，recorder 自己把最有价值的两类未知 payload 扔了。这会让每个新版本都回到“凭历史项目猜结构”的原点。

### 5.3 P0 协议 recorder contract

先别急着实现 55 个 message。第一步应让每个未知 envelope 都可追溯：

```ts
interface WmpfEnvelopeEvidence {
  sessionId: string;
  runtimeVersion: number;
  observedAt: string;
  seq: number;
  after: number;
  category: string;
  compressAlgo: number;
  originalSize: number;
  decodedSize: number;
  sha256: string;
  previewBase64?: string;      // bounded
  artifactPath?: string;       // full payload, workspace only
  truncated: boolean;
  decoder: 'known' | 'unknown' | 'failed';
}
```

要求：

- 默认 metadata + hash 全量保留；payload 受 byte/event 上限控制；
- 原始 payload 只写受控 workspace，不进入 Git；
- evidence manifest 记录 category histogram、版本、hash、decoder 状态；
- known decoder 失败时仍保存原始 bytes，不能只留异常文本；
- 基于 sanitized fixture 建立 round-trip、property 和 fuzz tests；
- 新 category 必须由真实 capture 证明后再加入 versioned registry。

协议实现顺序建议：

1. 已观察：`setupContext`、`customMessage`；
2. lifecycle：`connectJsContext`、`ping/pong`；
3. 领域能力：`domOp/domEvent`、`networkDebugAPI`；
4. fallback/兼容：`callInterface`、`evaluateJavascript`、engine categories。

## 6. 根因三：缺少微信小程序领域模型

### 6.1 Context 平面化导致错误选择

`src/transport/cdp-channel.ts:19-21` 和 `:133-165` 把 CDP `Runtime.executionContextCreated` 直接写入 `contexts`；`src/sessions/manager.ts:24-25` 又把 session context 作为同一种实体管理。外层 WMPF `jscontextId` 与内层 CDP `executionContextId` 没有显式 edge。

v19977 live gate 中，context `1/3/4/5/6` 全部被判为：

- `role=appservice`
- `hasWx=true`
- route=`pages/home/index`
- 同一个 `page-frame.html` href

live runner 还需要再对每个 context 运行自定义 probe 才能挑候选（`scripts/live-semantic-gate.mjs:367-435`）。这说明“能枚举 context”不等于“能建立 context identity”。

建议改成图模型：

```text
WMPF process
  -> WMPF logical context (jscontextId)
      -> CDP execution context (executionContextId)
          -> role: AppService | WebView | Worker | Game
          -> app: appId / version / baseLibrary
          -> page: route / webviewId / pageInstanceId
          -> artifacts: scripts / requests / trace / DOM
```

每条 edge 都要带 `source`、`confidence`、`observedAt`。缺证据时保留 `unknown`，不要因为 `hasWx=true` 就把五个 context 都叫 AppService。

### 6.2 Runtime probe 只够做 capability probe

`src/runtime/wx-runtime.ts:83-92` 主要返回 `hasWx`、`hasWxRequest`、`hasWxConfig`、`hasGetCurrentPages`、runtime path 和 href。这适合判断“能不能调用”，不适合回答用户真正的问题。

`wxmp_open` 完成后至少应返回：

- AppID、WMPF 版本、基础库版本、帐号/环境信息；
- launch options、enter options、page stack、current route；
- 当前 page data 的 bounded snapshot；
- component/DOM tree 摘要与可交互元素；
- storage key inventory，可选 bounded value preview；
- subpackage/plugin/cloud function/API inventory；
- AppService/WebView/Worker 配对结果；
- 每个字段的 provenance 和 confidence。

`TargetProcess` 已有 `appId`（`src/types.ts:13`，解析见 `src/runtime/target-discovery.ts:20-31`），但 `SessionManager.publicStatus()` 在 `src/sessions/manager.ts:318-340` 不返回它；默认 attach 又优先 main browser process，通常未必携带 renderer AppID。应通过 process tree、runtime config、servicewechat URL 和 package roots 交叉解析，而不是只信一个来源。

### 6.3 静态能力没有真正理解小程序结构

`src/static/adapter.ts:152-182` 的 index v1 只做：

- URL regex；
- `wx.*` regex；
- navigation call regex。

它没有解析 `app.json`、`pages`、`subPackages`、`plugins`、`usingComponents`、permission、cloud、tabBar，也没有将 source location 与 runtime script/request 关联。`wxmp_build_index` 当前更像 grep summary，不是小程序结构索引。

静态 index v2 应先解析 JSON/manifest，再用 AST adapter 做可选增强。最低 schema：

```text
app -> pages -> components
    -> subpackages -> independent/plugin
    -> permissions/cloud/storage/API
    -> files/symbols/references/source locations
```

然后由 `wxmp_correlate_runtime_static` 把 runtime appId、script URL、request initiator、route 与静态节点关联。

## 7. 已确认的具体行为缺陷

### 7.1 Breakpoint 返回语义错误

`src/tools/dynamic.ts:148-156` 对 `Debugger.setBreakpoint` 和 `Debugger.setBreakpointByUrl` 统一只读 `result.locations`。CDP 的 script-location 变体返回 `actualLocation`，所以真实已绑定时仍可能得到 `boundLocations: 0`。

`live-semantic-gate.mjs:479-496` 已经被迫单独读取 `actualLocation` 绕过 MCP 返回值。修复时应统一 normalize：

```text
boundLocations = locations ?? [actualLocation].filter(Boolean)
pending = breakpointId exists && boundLocations.length === 0
```

并为两个 CDP method 分别加 contract test。

### 7.2 “读取 inventory”会消费 hook 证据

`src/tools/dynamic.ts:310-349` 在 `include_hooks=true` 时调用 `__wxmpRequestHook.drain()`；`wxmp_get_hooked_requests` 在 `:231-245` 也调用同一个 `drain()`。先看 inventory，后取明细，明细可能已经没了。

应改为 append-only ring buffer + monotonic cursor：

```text
peek(cursor?, limit?) -> records + nextCursor
ack(cursor)            -> optional explicit release
```

inventory 只能 non-destructive read；stop 时再释放 buffer。

### 7.3 Replay 改变原 transport

`src/tools/dynamic.ts:370-388` 把 CDP request 转给 `buildReplayExpression()`；`src/runtime/expressions.ts` 的 replay 固定使用 `fetch`。原请求即便来自 `wx.request`，重放也不再具备微信 API 的 options、回调、header/cookie/基础库行为。

应在 request record 中保留 `transport: wx.request | fetch | xhr | cdp` 和 transport-specific options。默认同 transport replay；无法同传输时返回 `semanticDowngrade`，不能悄悄改 transport。

### 7.4 状态粒度不一致

`src/sessions/manager.ts:299-315` 中 trace/request hook 按 context set 管理，Network 却只写 session 布尔值；`src/tools/dynamic.ts:259-270` 对任一 context enable/disable 都覆盖 session 状态。多 context 下，一个 context disable 可能让 capability 显示 false，而另一个 context 仍在 capture。

Network 应与其他 runtime capability 一样按 context/domain activation 记录，session 状态由聚合计算。

### 7.5 默认 toolset 噪声过大

完全重复：

- `wxmp_list_targets` = `wxmp_detect_wmpf`
- `wxmp_session_status` = `wxmp_get_runtime_info`

Profile generate/promote、raw adapter、raw CDP、DevTools proxy 等是维护或 expert 能力，不该默认挤占 Agent 的 tool selection。尤其 `wxmp_profile_generate` 强制调用者提供最难获取的 `scene_offsets`（`src/tools/profile.ts:21-40`），它不是日常入口。

## 8. 建议的 MCP 产品面

### 8.1 默认 agent toolset

默认只发布约 14 个高层工具，原始能力放 `expert` toolset；可通过配置或 capability negotiation 启用，不能删除底层调试能力。

| 默认工具 | 责任 |
|---|---|
| `wxmp_health` | cold-start 能力摘要 |
| `wxmp_doctor` | 只读诊断，并返回是否可自动恢复 |
| `wxmp_open` | 唯一动态入口，完成 bootstrap |
| `wxmp_status` | 当前 session/app/context graph 摘要 |
| `wxmp_app_snapshot` | app/page/runtime/storage/component 摘要 |
| `wxmp_observe_window` | bounded start/wait/collect/stop/summarize |
| `wxmp_navigate_and_observe` | 导航并自动观察变化 |
| `wxmp_list_requests` | cursor-based request 列表 |
| `wxmp_get_request` | 请求、initiator、body artifact |
| `wxmp_replay_request` | same-transport replay |
| `wxmp_search_code` | 统一 runtime/static source search |
| `wxmp_correlate_runtime_static` | AppID/package/runtime 关联 |
| `wxmp_export_evidence` | 导出 evidence bundle |
| `wxmp_close` | stop hooks/capture、export 可选、detach |

Expert toolset 保留 attach/wait/list/select/probe/raw CDP/debugger step/Profile/raw adapter/proxy 等原语。

### 8.2 `wxmp_open` contract

输入只要求 `project_name`，其他字段可选：

```json
{
  "project_name": "target-a",
  "pid": 1234,
  "app_id": "wx...",
  "capture": ["network", "wx.request"],
  "snapshot": true,
  "timeout_ms": 45000
}
```

内部确定性步骤：

```text
target select
  -> Profile resolve/probe
  -> attach
  -> runtime wait/reconnect
  -> protocol handshake observation
  -> context graph build/probe/select
  -> passive Network/request hooks
  -> app/page snapshot
  -> package correlation candidate scan
```

输出必须是 `structuredContent`，text 只做短摘要：

```json
{
  "ok": true,
  "sessionId": "wxmp-...",
  "state": "ready",
  "app": { "appId": "wx...", "route": "pages/home/index" },
  "contextGraph": { "selected": "...", "confidence": "high" },
  "capture": { "network": true, "wxRequest": true },
  "snapshotArtifact": "...",
  "needsUserAction": false,
  "nextActions": ["wxmp_observe_window", "wxmp_search_code"]
}
```

如果 WMPF bridge 必须由前台切换/重载触发，也不要只报 timeout：

```json
{
  "ok": false,
  "retryable": true,
  "needsUserAction": true,
  "missingCapability": "runtimeBridge",
  "userAction": "将目标小程序切到前台或重载一次",
  "resumeTool": "wxmp_open",
  "resumeArguments": { "session_id": "wxmp-...", "resume": true }
}
```

### 8.3 MCP-native guidance

至少发布：

- server instructions：默认先 `wxmp_open`，不要手动 list/attach/probe/select；
- prompts：`wxmp-recon`、`wxmp-protocol-recovery`、`wxmp-static-runtime-correlation`；
- resources/resource templates：
  - `wxmp://session/active`
  - `wxmp://session/{id}/status`
  - `wxmp://session/{id}/context-graph`
  - `wxmp://session/{id}/evidence/manifest`
- tool annotations：read-only、destructive、idempotent、open-world；
- `outputSchema` + `structuredContent`；
- error fields：`retryable`、`nextActions`、`needsUserAction`、`missingCapability`。

SDK v1.29.0 已支持这些基础能力，不需要等待 SDK v2，也不需要引入 GUI、SSE 或 always-on daemon。

## 9. Before / After 调用预算

### 当前

```text
1 health
2 list_targets
3 attach
4 wait_for_runtime
5 probe_contexts
6 select_context
7 capture_start / hook / trace_start
8 用户手动触发业务动作
9 list/get/query
10 capture_stop / trace_stop / unhook
11 export
12 detach
```

### 建议

```text
1 wxmp_open
2 wxmp_observe_window（工具内部 bounded wait + collect）
3 wxmp_close(export=true)
```

真正不可自动化的只剩“微信运行时必须由用户切到前台/触发某个业务动作”这类外部状态变化；MCP 应明确返回一次 user action 和可恢复 continuation，而不是让用户管理 session/context/hook 状态。

## 10. 分阶段改造路线

### P0：先像一个 MCP

1. 增加 server instructions、structured outputs、annotations 和统一 error envelope。
2. 实现 `wxmp_doctor`、`wxmp_open`、`wxmp_close`，将 live gate 中已验证的生命周期编排迁入 domain service。
3. 默认 agent toolset 收敛到 12-18 个；重复和维护型工具进入 expert。
4. 建立 unknown envelope recorder、category histogram 和 versioned protocol registry。
5. 引入 context graph，默认工具不再要求调用者提供 `context_id`。
6. 修复 breakpoint normalize、hook non-destructive cursor、same-transport replay。
7. 增加调用预算验收：从 MCP initialize 到首个 app snapshot/request 不超过 2 次 tool call。

建议拆成三个 PR，别整一个巨无霸：

- PR-A：MCP contract + entrypoint + error/recovery；
- PR-B：protocol recorder + context graph；
- PR-C：三项行为修复 + call-budget/live acceptance。

### P1：补微信领域闭环

1. AppID/版本/launch/page stack/current page/page data/storage snapshot。
2. `wxmp_observe_window` 与 `wxmp_navigate_and_observe`。
3. DOM/component/action loop：优先验证 WMPF `domOp/domEvent`，否则使用 CDP DOM/Input 或 `wx.*` fallback，并返回 provenance。
4. active AppID -> package scan -> main/subpackage selection -> decompile -> index v2 一键关联。
5. 静态 index v2 解析 manifest、subpackage、plugin、component、cloud、permission 和 source location。
6. request initiator、WebSocket、XHR breakpoint、paused scopes 等高频 debugger 能力。

### P2：协议与版本生态

1. 按真实 capture 实现 setup/connect/ping、DOM、NetworkDebugAPI、engine/custom message decoder。
2. 建立跨 WMPF 版本、脱敏后的 protocol corpus manifest；原始 bytes 留 workspace。
3. round-trip、property、fuzz、malformed、compression bomb 和 size-limit tests。
4. v19977/v20079 运行时同序列 semantic gate；新版本先 record/triage，不回退历史 offset。
5. 仅对长等待评估 MCP Tasks；不引入 GUI/SSE/daemon。

## 11. 新的验收门槛

功能 tests 继续保留，但产品验收必须增加：

| Gate | 通过标准 |
|---|---|
| Time to first useful result | initialize 后最多 2 次调用得到 app snapshot 或明确 user action |
| Context autonomy | 默认流程不要求用户手填 `context_id` |
| Recovery | attach/reconnect 失败返回 machine-readable next action |
| Read semantics | inventory/list/status 不消费 capture buffer |
| Replay fidelity | 默认 same transport；降级显式标记 |
| Protocol observability | 每个未知 category 至少有 count、size、hash、bounded artifact |
| Tool selection | 默认 agent toolset 不超过 18，重复工具为 0 |
| Schema quality | 默认工具全部有 title、annotations、outputSchema |
| Domain snapshot | AppID、route、page stack、context graph 带 provenance |
| Static/runtime loop | runtime appId 能关联 package/index 或返回明确缺口 |
| Version gate | v19977、v20079 分别记录 semantic depth，不用浅 gate 冒充完整支持 |

## 12. 外部对标

数据取于 2026-07-28，使用固定 commit 复核实现；Stars/Forks 是检索时快照。

| 项目 | Stars/Forks | 可借鉴点 | 边界 |
|---|---:|---|---|
| [evi0s/WMPFDebugger](https://github.com/evi0s/WMPFDebugger/tree/7763acb878d3b45533cae7eefd06f5570475399d) | 2380/529 | 55 message、19 category 的协议词汇与 WMPF 行为证据 | GPL-2.0，禁止复制实现 |
| [an7ln/wmpf-mcp-bridge](https://github.com/an7ln/wmpf-mcp-bridge/tree/226c83069c50a3997c3258da133e079c96246700) | 104/14 | `wmpf_start` 一次完成 connect、domain enable、AppService、hooks、snapshot；有 server instructions | MIT；高层漏洞启发式不必照搬 |
| [zhizhuodemao/miniapp-cdp-mcp](https://github.com/zhizhuodemao/miniapp-cdp-mcp/tree/4373a1297dab2efae082ec014ea54122b843ff26) | 123/28 | initiator、XHR breakpoint、paused scopes、WebSocket、WASM | MIT；不含本项目的 WMPF attach/Profile 链 |
| [Chaixueyuan/weapp-agent-mcp](https://github.com/Chaixueyuan/weapp-agent-mcp/tree/117e660531e5a4a6ee16cfddadd9a2149fe2b822) | 14/0 | `mp_ensureConnection`、health/recovery/diagnostics、server guidance、3 个 prompts | MIT；目标是 DevTools automator，不是 WMPF RE |
| [Spade-sec/First](https://github.com/Spade-sec/First/tree/7dc5604958e1fa6f556afe155e328b2cfc1f5e64) | 903/191 | 安全分析工作流和候选发现 | 未声明许可证，不复制代码 |

最值得抄的是产品模式，不是代码：**一个主入口、自动恢复、明确 next action、领域 snapshot、底层原语仍可下钻。**

## 13. 限制与待验证边界

- 本轮没有重新操作真实微信目标；运行时结论复核自 2026-07-15 的 v19977 live evidence。
- v20079 只有 Profile/AOB/hash-binding 与 attach/detach 级证据，完整 AppService/CDP/Network/trace/replay/reconnect 仍是 `runtime-pending`。
- WMPF `domOp/domEvent` 是否能稳定支撑 UI snapshot/action，需先录制目标版本 payload；不能根据 category 名直接宣称可用。
- `scriptId`/`requestId` 是否跨 WMPF logical context 碰撞，需要构造双 context 同时解析/请求的有界实验。
- 外部 GPL/未声明许可证仓库只用于行为对标和 clean-room test hypothesis，不进入源码或 fixture。

## 14. 最终判断

别再往 53 个 tools 上继续摞工具了。当前短板不是“能力少”，而是没有把已经存在的能力组织成 Agent 可自主完成的领域任务，同时协议 recorder 又把未知数据丢了。

正确顺序是：

```text
先收口 wxmp_open / doctor / close
  -> 再保全未知协议与 context identity
  -> 再补 app/page/package 领域 snapshot
  -> 最后按真实证据扩 decoder 和高级 debugger 原语
```

做到 P0 后，它才从“通过 MCP 暴露的一组 WMPF 命令”变成“微信小程序逆向 MCP”。
