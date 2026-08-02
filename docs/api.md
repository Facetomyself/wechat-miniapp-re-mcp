# MCP API

`wechat-miniapp-re-mcp` v0.4.0 提供两层 tool surface：默认 `agent` 暴露 16 个高频工具，`WXMP_TOOLSET=expert` 暴露全部 59 个工具。所有工具使用 `wxmp_*` 前缀，同时返回 text JSON 与 `structuredContent`，并声明 `title`、`outputSchema`、`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。

成功结果统一为：

```json
{ "ok": true, "data": {} }
```

错误结果统一为：

```json
{
  "ok": false,
  "error": { "code": "RUNTIME_NOT_CONNECTED", "message": "...", "details": {} },
  "retryable": true,
  "needsUserAction": true,
  "missingCapability": "runtimeBridge",
  "userAction": "Foreground or reload the target mini-program once.",
  "nextActions": ["wxmp_open"]
}
```

## 默认 Agent surface

正常分析从 `wxmp_doctor` 或 `wxmp_open` 开始。`wxmp_open` 统一完成 target 选择、Profile load/probe、Frida attach、runtime wait/reconnect、WMPF context 探测、request hook、app snapshot 和可选 wxapkg AppID 关联。首次 attach 已完成等待后不会在同一次调用中重复等待；runtime 尚未触发时返回 `resumeTool=wxmp_open` 与原 session 的 `resumeArguments`。动态后续调用仍显式携带 `session_id`；高层工具默认选择已验证的 WMPF logical context，不要求 agent 手工猜 `context_id`。

### Workflow

- `wxmp_doctor`
- `wxmp_open`
- `wxmp_status`
- `wxmp_app_snapshot`
- `wxmp_observe_window`
- `wxmp_close`

`wxmp_open` 未在等待窗口内收到 WMPF runtime 时不会销毁 session，而是返回 `state=needs_user_action`、同一个 `sessionId` 与重试动作。`wxmp_observe_window` 同时收集 cursor-based request-hook 记录、新 CDP Network 请求和可选 app snapshot；读取不会消费 Hook buffer。`wxmp_close` 恢复 wrapper、detach 并导出 evidence 三件套。

### Health, runtime evidence, and static correlation

- `wxmp_health`
- `wxmp_search_sources`
- `wxmp_list_requests`
- `wxmp_get_request`
- `wxmp_get_api_inventory`
- `wxmp_replay_request`
- `wxmp_scan_packages`
- `wxmp_decompile`
- `wxmp_static_search`
- `wxmp_export_evidence`

`wxmp_replay_request` 默认保持记录中的 `wx.request`、`fetch` 或 XHR transport。CDP Network 只能观察、不能确定调用方 transport，因此 CDP-only 记录回退到 `fetch`，并显式返回 `semanticDowngrade`。

## Expert surface

设置 `WXMP_TOOLSET=expert` 后，以上 Agent tools 与下列底层原语同时可用。Expert 模式用于 raw CDP、断点单步、手工 context/Profile 管理、静态 adapter 和 DevTools proxy，不是默认工作流。

### Session and WMPF logical context

- `wxmp_list_targets`
- `wxmp_list_sessions`
- `wxmp_attach`
- `wxmp_detach`
- `wxmp_session_status`
- `wxmp_wait_for_runtime`
- `wxmp_list_contexts`
- `wxmp_select_context`
- `wxmp_probe_contexts`
- `wxmp_get_runtime_info`

WMPF `jscontextId` 与 CDP `Runtime.executionContextId` 分开存储。context graph 以 `process -> WMPF logical context -> CDP execution context` 建边，并记录 provenance/confidence；数字相同不代表同一个 context。script/request 索引使用 `WMPF context + local ID` 复合键，无 context 的歧义查询返回结构化错误。

### Runtime, source, and debugger

- `wxmp_evaluate`
- `wxmp_raw_cdp`
- `wxmp_list_scripts`
- `wxmp_get_source`
- `wxmp_set_breakpoint`
- `wxmp_remove_breakpoint`
- `wxmp_pause_info`
- `wxmp_pause`
- `wxmp_step_over`
- `wxmp_step_into`
- `wxmp_step_out`
- `wxmp_resume`

`wxmp_set_breakpoint` 同时规范化 `locations[]` 与 `actualLocation`。URL/regex breakpoint 无绑定位置时返回 `pending=true`；script breakpoint 的 `actualLocation` 计为真实绑定。

### Trace, hook, network, and runtime API

- `wxmp_trace_start`
- `wxmp_trace_query`
- `wxmp_trace_stop`
- `wxmp_hook_wx_request`
- `wxmp_get_hooked_requests`
- `wxmp_unhook_wx_request`
- `wxmp_capture_start`
- `wxmp_capture_stop`
- `wxmp_call_wx_api`
- `wxmp_call_cloud_function`

`wxmp_get_hooked_requests(cursor, limit)` 返回 `records`、`nextCursor`、`oldestCursor`、`latestCursor`、`dropped` 和 `capacity`，不会清空记录。`wxmp_get_api_inventory(include_hooks=true)` 使用同一 non-destructive peek。Hook stop 才恢复原方法并释放 buffer。

### Human DevTools bridge

- `wxmp_devtools_proxy_start`
- `wxmp_devtools_proxy_stop`

### Static adapter

- `wxmp_unpack`
- `wxmp_build_index`
- `wxmp_repack`
- `wxmp_raw_adapter`

所有输出被限制在 configured workspace；caller-controlled `-out` 被拒绝。Gwxapkg 仍通过外部 adapter 调用，不进入 MIT core。

### WMPF Profile lifecycle

- `wxmp_detect_wmpf`
- `wxmp_profile_probe`
- `wxmp_profile_generate`
- `wxmp_profile_validate`
- `wxmp_profile_promote`

generated candidate 必须绑定 module SHA-256，通过 bounds/AOB 唯一性验证，并记录 reviewer、timestamp、evidence 与 promotion decision 后才能注入。外部 legacy Profile 仅作为兼容输入并产生 hash-unbound finding。

## Protocol evidence

已知 codec 当前覆盖 `chromeDevtools`、`chromeDevtoolsResult`、`addJsContext`、`removeJsContext`。未知或 decode-failed WMPF envelope 不再丢弃 payload：evidence 记录 `seq`、`after`、category、compression/original size、decoded size、SHA-256、bounded Base64 preview、artifact path、truncation 和 decoder 状态。二进制 artifact 只写 configured workspace，默认单项上限 8 MiB。

## Prompts

- `wxmp-recon`：agent-first runtime/API reconnaissance。
- `wxmp-protocol-recovery`：按 category/sequence/hash/action 关联未知 WMPF envelope。
- `wxmp-static-runtime-correlation`：按 AppID/route/script/request 关联静态与运行时证据。

## Resources

- `wxmp://server/status`
- `wxmp://session/active`
- `wxmp://session/{id}/status`
- `wxmp://session/{id}/context-graph`
- `wxmp://session/{id}/evidence/manifest`

资源均返回 `application/json` 文本。evidence manifest resource 是实时容量/计数摘要；正式导出仍使用 `wxmp_export_evidence` 或 `wxmp_close`。
