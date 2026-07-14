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

## WMPF WebSocket URL

WMPF hardcodes its debug endpoint as `ws://127.0.0.1:9421` (confirmed from First tool source: `src/cli.py` line 5: `DEBUG_PORT = 9421`). This port cannot be changed without patching the WMPF binary.

## Frida API Deprecation

`Module.findBaseAddress()` is deprecated in Frida >= 17. Use `Process.findModuleByName(name).base` instead. Our `hook-source.ts` already uses the correct API.

## Gwxapkg publicLib

The WMPF `publicLib.wxapkg` (shared library package) cannot be decompiled by Gwxapkg as a standalone package. It requires the main package context for proper extraction. The adapter correctly reports this as an empty-output error.

## Mini-game Process Visibility

Mini-game JS contexts are embedded within `preload-*` renderer processes and do not appear as separate `WeChatAppEx.exe` processes with distinct appIds in `--wmpf-appid=`. Context detection relies on `Runtime.executionContextCreated` CDP events (implemented in `cdp-channel.ts`).

## Clean-room vs Legacy Profiles

Our MCP uses a clean-room profile schema (schemaVersion: 1) but loads legacy First-format profiles (`addresses.{version}.json`) at runtime via `ProfileManager.legacyToProfile()`. The legacy profiles are read from disk but never copied into the repository — the `provenance.source` field is set to `"external-legacy"`.
