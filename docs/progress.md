# Progress and Acceptance Status

Last updated: 2026-07-15

Current working state:

- Child branch: `main`
- Package version: `0.3.1`
- v0.3.0 remediation is delivered through PR #6; v0.3.1 closes the repeatable WMPF v19977 semantic gate and is delivered through PR #7. Parent gitlink/document synchronization is tracked by `reverse_ENV` PR #3.
- Overall implementation completion: about 96%.
- Original acceptance completion: about 92%.

The project is not marked 100% complete. Transport connectivity, tool invocation, and semantic capability success are tracked separately.

## v0.3.0 review remediation

- Runtime capability flags now depend on successful CDP domain probes or non-zero installed wrappers.
- Added `wxmp_probe_contexts`; contexts record role, library metadata, `hasWx`, origin, confidence, and context-scoped capabilities.
- Script and request indexes retain their WMPF `contextId`; source retrieval, script breakpoints, request body retrieval, and replay use the originating context.
- Trace start rejects `wrapped=0`; runtime evaluation exceptions become structured errors.
- Request hooks now cover `wx.request`, `fetch`, and `XMLHttpRequest`; hook-backed API inventory reads the correct CDP return value and context.
- DevTools proxy remaps request IDs per client and broadcasts events without leaking internal command responses.
- Evidence reads/summaries stream NDJSON; per-session event/byte caps, oversized-event previews, malformed-line findings, write-error recovery, and explicit flush were added.
- Tool arguments are validated against their published JSON Schemas before handler execution; numeric/boolean parsers are strict.
- Static index/repack paths reject missing input and no-output success cases.
- Profile/AOB parsing rejects trailing garbage and malformed signature bytes.
- Bundled `data/profiles/clean-room/windows-19977.json` and `aob-signatures.json` are discovered automatically.
- Third-party copied WMPF profile data was removed from Git; external legacy profiles remain runtime-only fallback inputs.
- CI now runs the complete gate on Node.js 20 and 22.

## v0.3.1 live runtime closure

- Context probing resolves `wx` from `globalThis`, `nav.wxFrame`, parent/top candidates, and bounded accessible child frames.
- `wxmp_call_wx_api`, cloud calls, trace injection, and request hooks use the same runtime resolver and expose `wxRuntimePath`.
- Empty WMPF event `contextId` values are normalized as unscoped; source, breakpoint, body, and replay operations fall back to the selected context.
- The WMPF v19977 live semantic gate passed AppService selection, evaluate, a real breakpoint location, 727 trace wrappers, `wx.request`/fetch/XHR hook installation, fixture hook events, API inventory, Network body retrieval, replay, same-session restart/reconnect, detach, and evidence export.
- Live summary: `workspace/live-verification/wechat-miniapp/live-semantic-gate-v031-1784111644618.json`; session evidence: `sessions/wxmp-72a7c884-209a-4533-ab75-560495360c8a/` below that project root.

## Phase status

| Phase | Status | Completion | Verified evidence | Remaining gate |
|---|---|---:|---|---|
| 0. Repository and governance | Complete | 100% | Child repository, submodule boundary, MIT license, ignore rules, clean-room/legacy separation | — |
| 1. Lightweight MCP core | Implementation complete | 100% | stdio cold start, schema validation, structured errors, codec/bridge tests, reconnect ownership, evidence persistence | Official MCP conformance remains optional follow-up |
| 2. Dynamic reverse workflow | v19977 acceptance complete | 98% | AppService selection, evaluate, bound breakpoint, trace/hook events, inventory, Network body, replay, reconnect, detach, evidence export | Repeat the same gate on a second WMPF version |
| 3. Static reverse workflow | Implementation complete | 95% | main/plugin/subpackage/minigame fixtures previously decompiled/indexed; path/no-output guards covered | Add reproducible real Gwxapkg subprocess fixture to CI |
| 4. Profile lifecycle | Gated | 90% | canonical v19977 reviewed profile, module SHA-256 gate, candidate promotion, default AOB database wiring | Validate clean-room AOB/profile on a second real WMPF version |
| 5. Parent integration | Delivered | 100% | `reverse_ENV` PR #3 updates the gitlink and integration documentation for v0.3.1 | — |
| 6. Git delivery | Complete | 100% | PR #6 carries v0.3.0; PR #7 carries v0.3.1 with automated and live evidence; parent delivery is tracked by `reverse_ENV` PR #3 | — |

## Automated verification

- TypeScript strict typecheck and build.
- Node test suite: 80 passing tests covering bridge, codec, CDP state, nested WMPF `wx` resolution, context/request indexing, originating/unscoped-context source and replay behavior, request hooks, proxy client ID/context isolation, evidence count/byte overflow and write recovery, profile gates, static guards, server schema validation, and target discovery.
- MCP contract checks required tools, prefix, duplicates, and minimum inventory.
- stdio smoke verifies initialize, list-tools, and `wxmp_health` without WeChat.
- Production dependency audit reports no known vulnerabilities at the time of this update.

## Real-target evidence status

Verified on WMPF v19977 by the v0.3.1 live semantic gate:

- main-process discovery and Frida hook load;
- WMPF protobuf/CDP bridge connection;
- nested-frame AppService/`wx` discovery with `wxRuntimePath` evidence;
- script enumeration, source retrieval, and a non-empty `Debugger.setBreakpoint` location;
- 727 wrapped `wx.*` methods and recorded trace events;
- installed `wx.request`, fetch, and XHR wrappers plus controlled fixture hook records;
- Network request/response body retrieval and in-runtime replay;
- same-session disconnect/requeue/reconnect;
- evidence bundle export and detach.

The remaining real-target gap is a second WMPF module/version for cross-version AOB, hash-binding, attach, and detach validation.

## Known limitations and next actions

1. Obtain a second WMPF binary and validate AOB uniqueness, hash binding, attach, and detach.
2. Add a small distributable static fixture or controlled backend stub for CI subprocess verification.
3. Keep the mini-program selector available before attach; the WMPF debug filter remains lifecycle-triggered.

## Update rule

Update this document whenever a real acceptance gate changes, a public tool schema changes, or Git delivery state changes. Code existence, a returned CDP response, or a local-only pass is not sufficient evidence for 100% completion.
