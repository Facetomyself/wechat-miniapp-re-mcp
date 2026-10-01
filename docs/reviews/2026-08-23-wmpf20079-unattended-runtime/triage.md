# Triage 与待验证项

审计日期：2026-08-23
状态：操作员暂停 live-gate，不继续挂载。

## 已确认

| ID | 阻塞/缺口 | 下一步有界实验或补丁 | 完成证据 |
|---|---|---|---|
| RT-001 | 注入后未关开则 9421 无 owner | 恢复时严格：Frida ready 后再关开 | `loadStartEntered>=1` 且 `runtimeBridge` passed |
| RT-002 | `forceDebugTrigger` 不能拉起 debug filter | 保持 observation-only | 不得把 NativeFunction 作为默认路径 |
| RT-003 | 9421 连通后 `session.contexts` 为空 | 先用 60s reconnect 再探；仍空则看 setupContext artifact | `appserviceContext` passed 且 `wx` evaluate 返回 hasWx |
| RT-004 | 20s probe + fatal RUNTIME_NOT_CONNECTED | 提交工作树 live-gate 补丁 | dry-run `contextTimeoutMs=60000`；重连不再直接 FATAL |
| RT-006 | 未知 category 已留证 | 无需立刻 decoder | artifact SHA-256 可复核 |

## Runtime-pending

### 1. v20079 完整 semantic gate

未跑：evaluate、breakpoint、apiInventory、trace、requestHook、networkBody、replay、reconnect。v19977 v0.3.1 仍是唯一 full-semantic 参考。

通过标准：`scripts/live-semantic-gate.mjs` `passed=true`，required gates 全绿，导出 findings 无未解析 high。

### 2. `setupContext` 是否替代 `addJsContext`

- 假设：20079 在重连后用 `setupContext` 登记 JS context，本仓库尚未 decode。
- 反假设：`addJsContext` 会在更晚的稳定代发出，20s 窗口不够。
- 实验：下一次 9421 连通后等满 60s；若仍无 `context.added`，对 `protocol/*-setupContext-*.bin` 做 clean-room 字段观察（id/name），对照同一秒的 `Runtime.executionContextCreated`。
- 禁止：从 GPL WMPFDebugger 复制 generated protobuf。
- 通过：要么出现 `addJsContext` 并选出 AppService，要么有 attested 的 `setupContext` decoder 写入 versioned registry。缺一步只能标 `insufficient-evidence`。

### 3. CDP execution context 能否降级作为 AppService 候选

- 当前 `probeContexts` 不把 `context.execution_added` 当成 WMPF logical context。
- 实验：在 `wxmp-1a4846a1` 类 capture 上，对仍 active 的 execution context 做 `wxmp_evaluate` 探测 `wx`。
- 通过：若能稳定找到 `wx.request` 且不串 context，再考虑作为 fallback selector；否则保持 fail-closed。

### 4. v0.5.2 agent-first 在 v19977 上的 repeat

v19977 完整 semantic 是 v0.3.1 runner。v0.5.2 `wxmp_doctor`→`wxmp_open` 链路尚未在 v19977 上 repeat。

## 恢复检查单

1. 微信与一个小程序保持打开。
2. 工作树含 AppService 60s 补丁，或先提交。
3. 启动 live-gate 后等到 Frida `ready`，再说「现在关开」。
4. 关开后保持前台，不要关微信。
5. 无论成败都导出 summary + session 三件套，再更新 `docs/progress.md`。
