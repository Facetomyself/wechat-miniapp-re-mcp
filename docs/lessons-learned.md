# Lessons Learned & Known Behaviors

## WMPF CDP Bridge Connection Timing

### Root Cause

The WMPF debug WebSocket (hardcoded to `127.0.0.1:9421`) only connects when the CDP filter function inside `flue.dll` is called and returns an allow flag (0). The filter is invoked during specific mini-program lifecycle events — not continuously.

### Verified Working Scenario

**Session 1** (2026-07-14) — full pipeline confirmed:
- WMPF v19977 had mini-programs active in foreground
- CDP filter function was called during a mini-program reload cycle while our hooks were active
- Result: bridge connected, 66 scripts parsed, 2192 CDP events, 3 JS execution contexts, Console API call stacks captured

### Non-reproducible Scenarios

8 subsequent attach attempts after WeChat restart or re-attach failed to trigger the CDP filter. The filter function was simply never entered during the monitoring window (up to 90 seconds), even when mini-programs were opened after hook injection.

### How First Handles This

The First tool (`tools/First/`) uses the same hook offsets and the same 9421 port. Its architecture is identical:
1. Start WebSocket server on 9421
2. Inject Frida hooks (cdpFilter + loadStart)
3. Wait for WMPF to connect
4. Bridge CDP messages through a DevTools proxy on port 62000

First succeeds because it is typically launched **after** WeChat has been running with mini-programs active, which aligns with the timing window where WMPF enters its debug filter path.

### Recommended Workflow

For reliable MCP attach:
1. Start WeChat
2. Open a mini-program and keep it visible/active in the foreground
3. Attach MCP — the running mini-program context may trigger the filter on its next reload cycle
4. If no connection within 30s, detach and re-attach after switching to a different mini-program

### Future Investigation

- Identify the exact trigger for the CDP filter function call (scene transition? context creation? periodic check?)
- Consider a `wxmp_force_debug` tool that actively triggers the filter via direct function call after Frida injection
- Profile the filter call frequency across different WMPF versions

### Implemented Recovery Behavior in v0.2.0+

- An unexpected WMPF socket close keeps the MCP session and Frida attachment alive.
- The bridge requeues the same session as the only eligible runtime owner.
- Ephemeral contexts, scripts, requests, pause state, and pending CDP commands are reset; listeners and evidence state survive.
- `wxmp_wait_for_runtime` waits for a later lifecycle-triggered connection without reinjecting Frida.
- A second concurrent runtime reservation returns `BRIDGE_SESSION_BUSY`; FIFO guessing is no longer used across sessions.

## WMPF WebSocket URL

WMPF hardcodes its debug endpoint as `ws://127.0.0.1:9421` (confirmed from First tool source: `src/cli.py` line 5: `DEBUG_PORT = 9421`). This port cannot be changed without patching the WMPF binary.

## Frida API Deprecation

`Module.findBaseAddress()` is deprecated in Frida >= 17. Use `Process.findModuleByName(name).base` instead. Our `hook-source.ts` already uses the correct API.

## Gwxapkg publicLib

The WMPF `publicLib.wxapkg` (shared library package) cannot be decompiled by Gwxapkg as a standalone package. It requires the main package context for proper extraction. The adapter correctly reports this as an empty-output error.

## Mini-game Process Visibility

Mini-game JS contexts are embedded within `preload-*` renderer processes and do not appear as separate `WeChatAppEx.exe` processes with distinct appIds in `--wmpf-appid=`. Context detection relies on `Runtime.executionContextCreated` CDP events (implemented in `cdp-channel.ts`).

## Clean-room vs Legacy Profiles

The bundled v19977 clean-room profile is loaded before external compatibility directories and is bound to the reviewed `flue.dll` SHA-256. Legacy First-format profiles (`addresses.{version}.json`) remain runtime-only fallback inputs through `WXMP_LEGACY_PROFILE_DIR`; they are not copied into this repository and are reported as hash-unbound findings.

## Capability Semantics in v0.3.0

- `bridgeConnected` proves transport only.
- `debugger` and `network` become true after their CDP enable commands return successfully.
- `wxTrace` requires a selected context with at least one wrapped `wx.*` method.
- request-hook capability is tracked per context and requires an installed `wx.request`, `fetch`, or `XMLHttpRequest` wrapper.
- breakpoint-by-URL with no locations is reported as pending.
- runtime evaluation exception details are returned as structured tool errors instead of MCP success.

## Nested `wx` Runtime Resolution in v0.3.1

PC WMPF page contexts can expose the mini-program logic runtime through an accessible child frame instead of `globalThis.wx`. On v19977 the verified path was `globalThis.frames[1]`; First also uses `window.nav.wxFrame` for the same reason.

The runtime resolver now checks the current global, `nav.wxFrame`, parent/top candidates, and bounded accessible child frames. Context probing, `wx.*` calls, cloud calls, trace injection, and request hooks all use the same resolver and report `wxRuntimePath` as evidence.

Some WMPF `Debugger.scriptParsed` and Network events arrive with an empty `jscontextId`. These records remain explicitly unscoped, while source retrieval, breakpoints, response bodies, and replay fall back to the selected context instead of treating the empty string as a valid context.
