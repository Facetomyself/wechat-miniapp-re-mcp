# v0.5.2 无干预运行时内核与 WMPF 20079 live-gate 暂停分析

- 审计日期：2026-08-23
- 对象：`wechat-miniapp-re-mcp` `refactor/runtime-kernel` @ `42402d3187b4e82abdd2cc30ff622e4aa1ca2b6f`（v0.5.2）
- 类型：已交付内核对照 + 六次真实 WMPF 20079 live-gate 证据
- 结论等级：代码与本地 contract 已落地；v20079 完整 semantic gate 仍为 `runtime-pending`。操作员于 2026-08-23 暂停继续挂载。

## 1. 执行摘要

无干预运行时重构（M0–M7）已经合入子仓分支并推到 PR #18。Agent 默认 18 tools、expert 70 tools、60s parked wait、extractor smoke-promote、expert debugger、index schema v2 均在 `42402d3`。父仓 gitlink `1cb426b` 指向同一 SHA。

真实 WMPF 20079 上证明了两件独立的事，也证明了第三件还没过：

1. **Frida 钩子可重复挂上**（profile hash / AOB / `cdp_filter_attached` / `load_start_attached` / `ready`）。
2. **注入后再关开小程序，9421 可以连上**，CDP Debugger/Network 能工作（一次：`wxmp-1a4846a1`）。
3. **AppService 选择没有过门**。连上 9421 的那次 `session.contexts` 为空：没有 `addJsContext`，只有 CDP execution context 的加减和未知 `setupContext` 信封。

不得把 (1)+(2) 写成 full-semantic pass。`forceDebugTrigger` 仍是 observation-only，不能代替关开。

## 2. 已交付内核（相对 v0.4.0）

| 批次 | 内容 | 公共 schema |
|---|---|---|
| M0–M1 | runtime-contract、session 状态机、parked 语义、seams | 未改 tool 列表 |
| M2 | 默认 60s wait；`waiting_for_runtime`/`disconnected` 不重注 Frida；hook RPC `status`/`forceDebugTrigger` | 无 |
| M3 | agent 可 `evaluate` / `list_scripts` / `correlate` | 16→18 agent |
| M4 | `wmpf-offset-adaptation` 子进程 + Frida smoke attested promote；禁止历史 RVA fallback | 无新 tool |
| M5 | 10 个 expert debugger 原语；logical breakpoint 重连后 `stale` | expert 60→70 |
| M6 | restored-source index schema v2；correlate AppID/URL/initiator/script/route | 无新 tool |
| M7 | `scripts/live-semantic-gate.mjs`：doctor→open、省略 `--wmpf-version` 用当前 main、MCP callTool 超时与 wait 对齐 | 无 |

本地验收（`42402d3` 记录）：158 tests，18/70 contract，stdio smoke。未在本暂停会话重跑 `npm run check`。

未进入 `42402d3` 的工作树：live-gate AppService 默认等待 20s→60s；`wxmp_probe_contexts` 改为 `attempt`；断线或空 context 时先 `wxmp_wait_for_runtime` 再探；只从 `active !== false` 的 context 选 AppService。

## 3. 20079 目标与证据落点

| 项 | 值 |
|---|---|
| WMPF | 20079 |
| 主进程 PID | 23104（暂停时仍在） |
| `flue.dll` SHA-256 | `b28ec2d547e8771aeebe94ba77bc618941c0ce0794ef443f905666f0668f5d2b` |
| Profile | `data/profiles/clean-room/windows-20079.json` |
| 证据根 | `workspace/live-verification-m7/wechat-miniapp/` |
| 子仓 PR | https://github.com/Facetomyself/wechat-miniapp-re-mcp/pull/18 |
| 父仓 gitlink | `1cb426b` → `42402d3` |

## 4. 六次 live-gate

| 时间 (UTC) | Summary | Session | 首个失败 | 要点 |
|---|---|---|---|---|
| 05:39 | `...-1787463569747.json` | 无 | MCP `-32001` | `wxmp_open` 被 SDK 默认 60s 杀掉；随后 runner 已把 `callTool` timeout 对齐 |
| 05:41 | `...-1787463719355.json` | `wxmp-9aa4b27d` | `runtimeBridge` | Frida ready，`loadStartEntered=0` |
| 08:27 | `...-1787473658071.json` | `wxmp-76211fe6` | `runtimeBridge` | 同上 |
| 08:30 | `...-1787473826436.json` | `wxmp-c325a5f8` | `runtimeBridge` | 同上 |
| 08:35 | `...-1787474159248.json` SHA-256 `1aa5d57a...` | `wxmp-1a4846a1` | `appserviceContext` | 注入后关开成功；9421+CDP；无 WMPF context |
| 08:44 | `...-wmpfauto-1787474668258.json` SHA-256 `0badd124...` | `wxmp-db6c0696` | `runtimeBridge` | 钩子 08:44:33 ready；两分钟内 LoadStart 仍为 0 |

### 4.1 已证明：9421 依赖注入后的生命周期

`wxmp-db6c0696` 事件顺序：

- `08:44:33.669` module / `cdp_filter_attached` / `load_start_attached` / `ready`
- `force_debug_trigger` `cdpFilterEntered=0` `loadStartEntered=0` `attemptedNativeCall=false`
- `08:45:33` `session.attach_result` `connected=false`
- `08:46:33` `runtime.wait_result` `connected=false`

对比 `wxmp-1a4846a1`：`frida.message=893`、`runtime.connected=3`、`agent.open_completed=1`。操作差异是注入**之后**关掉再打开同一个小程序。提前关开或窗口内没有 LoadStart，结果就是 `runtimeBridge` 失败。

### 4.2 已证明：连上 9421 不等于有 AppService

`wxmp-1a4846a1` 导出会话 `report.md` 计数（2512 events）：

```text
runtime.connected=3
runtime.disconnected=2
context.execution_added=4
context.execution_removed=4
cdp.event.Debugger.scriptParsed=174
cdp.event.Network.requestWillBeSent=46
wmpf.chromeDevtoolsResult=682
wmpf.setupContext=3
wmpf.customMessage=175
wmpf.domEvent=41
```

没有 `context.added`。`wxmp_probe_contexts` 在约 20s 窗口后返回 `selectedContextId=""`、`contexts=[]`。

原因拆成两层，不得混为一谈：

1. **Runner 缺陷（已有补丁，未提交）**：`probeContexts` 在 socket 断开时抛 `RUNTIME_NOT_CONNECTED`；当时 live-gate 用 `call()` 直接 fatal，且默认只等 20s。重连抖动（connected 3 / disconnected 2）足以打空这个窗口。
2. **协议事实（待验证）**：即使等到 context，WMPF logical context 只来自 `addJsContext`。本次 capture 没有该类事件，却有 3 个未知 `setupContext`。CDP `executionContextCreated` 不能填 `session.contexts`。是否 20079 用 `setupContext` 替代 `addJsContext`，只能标 `insufficient-evidence`，下一步是 clean-room 看已落盘 artifact，禁止从 GPL 仓库抄 decoder。

## 5. Findings 总览

| ID | 优先级 | 状态 | 发现 |
|---|---|---|---|
| RT-001 | P0 | confirmed | 9421 仍由 LoadStart/CDP filter 生命周期触发；注入后未关开则 `loadStartEntered=0` |
| RT-002 | P0 | confirmed | `forceDebugTrigger` 观察桩不能代替关开 |
| RT-003 | P0 | confirmed | 一次 9421 连接后 AppService 选择失败：`session.contexts` 空 |
| RT-004 | P1 | confirmed | live-gate 20s + `call(probe_contexts)` 无法度过 reconnect |
| RT-005 | P1 | insufficient-evidence | `setupContext` 是否为 20079 的 context 登记面 |
| RT-006 | P2 | confirmed | 未知 `customMessage`/`domEvent`/`setupContext` 已按 bounded artifact 保留 |

## 6. 恢复时怎么做

不可再压缩的人步：PC 微信在跑；目标小程序至少打开过一次；**Frida `ready` 之后**再关开一次。

机器侧：

1. 确认工作树含 AppService 60s 等待补丁，或先提交再跑。
2. `node scripts/live-semantic-gate.mjs --project live-verification-m7`（`REVERSE_ENV_ROOT=D:\reverse_ENV`，Node 用 `tools\node\node.exe`，Git 在 PATH）。
3. 看到 `[gate] inject: starting wxmp_open` 且 hookAttach 后，操作员关开小程序并保持前台。
4. 若再次 9421 连通而 context 仍空：不要扩 Frida，先对 `sessions/<id>/artifacts/protocol/` 里 `setupContext` 做 clean-room 字段对照。

不要做：

- 声称 v20079 full-semantic 已通过；
- 把 `forceDebugTrigger` 改成默认 NativeFunction 调用；
- 把 GPL WMPFDebugger 的 protobuf 生成物拷进 MIT core；
- 用历史 RVA 填未知版本。

## 7. 审查门

- claim 均指向 live-gate JSON 或 session `events.ndjson` / 导出 `report.md`。
- 敏感字段未写入本文（无 Cookie、无 token、无协议 payload 原文）。
- 完整 semantic 未宣称完成。
