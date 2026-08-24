# Progress and Acceptance Status

Last updated: 2026-08-23 (paused)

Current working state:

- Child branch: `refactor/runtime-kernel` @ `42402d3187b4e82abdd2cc30ff622e4aa1ca2b6f` (v0.5.2 unattended runtime kernel)
- Package version: `0.5.2`
- Public PR: https://github.com/Facetomyself/wechat-miniapp-re-mcp/pull/18 (OPEN vs `main`)
- Parent gitlink: `reverse_ENV` `1cb426b` points at the same child SHA
- Last recorded local check at `42402d3`: 158 tests, 18 agent / 70 expert contract and stdio smoke
- Pause: 2026-08-23 operator stopped further live-gate attempts. Do not claim a v20079 full-semantic pass.
- Working tree (not in `42402d3`): live-gate AppService wait raised to 60s with `wxmp_wait_for_runtime` retry on empty/`RUNTIME_NOT_CONNECTED`; this pause's progress/lessons/review documents. Analysis: [`reviews/2026-08-23-wmpf20079-unattended-runtime/report.md`](reviews/2026-08-23-wmpf20079-unattended-runtime/report.md)
- Strongest v20079 live evidence: `workspace/live-verification-m7/wechat-miniapp/live-semantic-gate-v0.5.2-wmpf20079-1787474159248.json` (SHA-256 `1aa5d57aed2e380530d474c14439a70286dbab16d6668f97dbbcd27181610516`) — Frida + 9421 + CDP Debugger/Network passed; AppService probe returned zero WMPF contexts.

Historical working state at v0.4.0:

- Child branch: `fix/project-review-p0` (uncommitted v0.4.0 implementation; local static/unit/contract gates complete, real WMPF workflow runtime-pending)
- Package version: `0.4.0`
- Repository visibility: `public` after a working-tree, reachable-history, pull-request, and Actions-log sensitive-data audit.
- v0.3.0 remediation is delivered through PR #6; v0.3.1 closes the repeatable WMPF v19977 semantic gate through PR #7; WMPF v20079 profile/AOB/hash-binding closure is delivered through PR #11; public delivery status is recorded by PR #12. Parent gitlink/public-status synchronization is merged through `reverse_ENV` PR #6.
- The v0.4.0 agent-first implementation is static/unit/contract verified locally; its new real-target workflow remains runtime-pending.
- Future product work and acceptance priorities are tracked in [`roadmap.md`](roadmap.md); this file records achieved capability gates only.

The project is not marked complete by a percentage. Transport connectivity, tool invocation, semantic capability success, and repeatability are tracked as separate gates.

## v0.5.2 unattended runtime kernel

Delivered on `refactor/runtime-kernel` (M0–M7, committed as `42402d3`):

- Session wait default is 60s. Parked `waiting_for_runtime` / `disconnected` sessions resume with the same `session_id` and do not re-inject Frida.
- Missing injectable Profiles: `wxmp_open` copies `flue.dll`, runs `wmpf-offset-adaptation`, smoke-attests Frida RPC, and promotes `extractor+runtime-smoke`. Historical RVAs are not a fallback.
- Agent surface stays 18 tools (`wxmp_evaluate` / `wxmp_list_scripts` / `wxmp_correlate` included). Expert is 70 tools.
- Expert debugger primitives: paused state, scoped variables, call-frame evaluate, XHR/exception breakpoints, initiator, WebSocket frames, WASM save. Reconnect marks logical breakpoints `stale`.
- Restored-source index schema v2 plus correlate of AppID/URL/initiator/script/route. Gwxapkg remains a subprocess adapter.
- Live runner calls `wxmp_doctor` then `wxmp_open`, auto-selects the current main WMPF when `--wmpf-version` is omitted, and uses a 60s MCP/tool timeout.

### 2026-08-23 WMPF 20079 live campaign (paused)

Target: WeChatAppEx main PID `23104`, WMPF `20079`, `flue.dll` SHA-256 `b28ec2d547e8771aeebe94ba77bc618941c0ce0794ef443f905666f0668f5d2b`, bundled profile `data/profiles/clean-room/windows-20079.json`. Project: `workspace/live-verification-m7`.

| Summary | Session | First failure | Evidence |
|---|---|---|---|
| `...-1787463569747.json` | (none) | `wxmp_open` MCP `-32001` 60s timeout | runner timeout vs 60s attach wait |
| `...-1787463719355.json` | `wxmp-9aa4b27d-...` | `runtimeBridge` | Frida ready; `loadStartEntered=0`; no 9421 |
| `...-1787473658071.json` | `wxmp-76211fe6-...` | `runtimeBridge` | same: inject without post-hook reload |
| `...-1787473826436.json` | `wxmp-c325a5f8-...` | `runtimeBridge` | same |
| `...-1787474159248.json` | `wxmp-1a4846a1-...` | `appserviceContext` | 9421 connected; CDP/Network live; `session.contexts=[]` |
| `...-wmpfauto-1787474668258.json` | `wxmp-db6c0696-...` | `runtimeBridge` | Frida ready; `loadStartEntered=0` for the full 120s wait |

Proven on 20079 (session `wxmp-1a4846a1-e376-43fc-a6f4-abbb2ff187f5`):

- health 0.5.2 / 70 expert tools;
- profile schema, module hash, unique AOB (or extractor structure);
- Frida `cdp_filter_attached` + `load_start_attached` + `ready`;
- `runtime.connected=3`, `Debugger.scriptParsed=174`, `Network.requestWillBeSent=46`, `wmpf.chromeDevtoolsResult=682`.

Not proven (do not claim):

- WMPF `addJsContext` / AppService selection / `wx` evaluate;
- breakpoint, trace, request-hook, inventory, body, replay, reconnect;
- `forceDebugTrigger` as a substitute for the operator reload (`attemptedNativeCall=false`).

Operator pause is recorded. Resume procedure is in the review report and `docs/lessons-learned.md`.

## v0.4.0 agent-first MCP optimization

- Default `WXMP_TOOLSET=agent` exposes 16 high-frequency tools; `WXMP_TOOLSET=expert` preserves all 59 tools. `wxmp_open` owns target/Profile/attach/runtime/context/hook/snapshot/package-correlation orchestration, and `wxmp_close` restores wrappers, detaches, and exports evidence.
- MCP initialization now publishes usage instructions. Three prompts and status/context-graph/evidence resources are available through native MCP capabilities.
- Every tool has a title, output schema and four behavior annotations. Success and error responses expose `structuredContent` while preserving text JSON compatibility; recovery fields include retry/user-action/capability/next-actions.
- Unknown or failed WMPF envelopes retain `seq`, `after`, sizes, SHA-256, bounded preview and bounded workspace binary artifacts. Known and unknown decoder states are explicit.
- WMPF logical contexts and CDP execution contexts are separate graph nodes. script/request indexes use `WMPF context + local ID`; ambiguous unscoped lookups fail instead of guessing.
- Request-hook reads use non-destructive cursor-based `peek`; API inventory no longer drains captures. Hook records persist transport metadata, and replay preserves `wx.request`/fetch/XHR where known or reports CDP-to-fetch `semanticDowngrade`.
- `wxmp_app_snapshot` captures bounded identity/account/base-library/launch/enter/page/storage/config state. `wxmp_observe_window` combines Hook, CDP, cursor and snapshot evidence.
- Breakpoint normalization accepts both `locations[]` and `actualLocation`; target status exposes AppID/process metadata; Network capability is tracked by WMPF context route.
- Local verification currently passes 107 tests, strict typecheck, 16/59 exact tool contracts, acceptance records, and dual-toolset stdio smoke. The MCP SDK is pinned by the lockfile to `1.30.0`; patched transitive dependencies close the current production audit at `0 vulnerabilities`. The live runner explicitly selects the expert toolset while the product default remains agent-first. A new live WMPF semantic run has not yet been performed, so these v0.4.0 runtime claims remain `runtime-pending` beyond fixture coverage.

### 2026-07-29 local validation closure

- `scripts/live-semantic-gate.mjs` now explicitly starts the server with `WXMP_TOOLSET=expert`, because the acceptance sequence intentionally uses low-level runtime primitives outside the default 16-tool agent surface. The product default remains `agent`.
- A newly attached `wxmp_open` call no longer performs a second runtime wait in the same invocation. If the WMPF lifecycle still needs a foreground/reload transition, it retains the session and returns `resumeTool: "wxmp_open"` plus `resumeArguments.session_id` for machine-readable continuation.
- An explicitly supplied `context_id` is now a strict lookup. A missing or incorrect ID fails in that context instead of silently falling back to another WMPF context; only an omitted context may use the selected-context path.
- Recovery metadata now distinguishes retryable runtime transitions from required user action. Missing reviewed Profiles return a concrete hash-bound Profile action, and tool annotations were corrected against actual read/write and idempotency behavior.
- Node.js `20.20.2` and `22.23.1` both pass all `107/107` tests. Contract verification reports exactly `16` agent tools and `59` expert/API tools; agent and expert stdio smoke, two acceptance records, the expert live-gate dry run, and child/parent diff checks pass.
- The dependency baseline is MCP SDK `1.30.0`, Hono Node adapter `2.0.12`, `fast-uri 3.1.4`, and `brace-expansion 5.0.8`; the production audit reports `0 vulnerabilities`.
- This closure is local static/unit/contract evidence only. It does not replace the historical v0.3.1 v19977 live evidence and does not claim that the new v0.4.0 workflow has passed a real WMPF target.

## v0.3.2 acceptance contract foundation

- Added `data/acceptance/schema-v1.json`, an exact record index, and reviewed records for WMPF v19977 `full-semantic` and v20079 `profile-runtime` depth.
- `npm run acceptance` validates record schema, Profile file SHA-256, module SHA-256, Profile metadata, evidence references, index drift, and the gates required by the claimed depth.
- The MCP contract now also checks package/lock/source/build version agreement, README tool-count markers, and exact `docs/api.md` tool inventory.
- Added the tracked `scripts/live-semantic-gate.mjs` runner with controlled output paths, target/version selection, AOB regeneration, canonical gate names, reconnect control, sanitized summaries, and failure evidence export.
- On 2026-07-18 the current v19977 process passed health/Profile/module/AOB/Frida attach and clean detach, but its lifecycle did not enter the WMPF debug filter during the run; `runtimeBridge` failed and the remaining semantic gates were recorded as `not-run`. Failure summary: `workspace/live-verification/wechat-miniapp/live-semantic-gate-v0.3.1-wmpf19977-1784349870424.json`, SHA-256 `32d88592c39c829d3c93b4fe792d2b82e56f89ffe10d888e68a5bd47c7648f00`. This failure-closure evidence was later superseded by the successful post-review repeat recorded below.
- No WMPF v20079 runtime is currently active on this machine, so the second-version semantic gate remains pending.

## Project review P0 remediation

- Windows default package discovery now includes current `radium/users/<user>/applet/packages` trees while retaining the legacy `radium/Applet/packages` root; the default stdio `wxmp_scan_packages` call finds cached packages on the reviewed xwechat installation.
- A connected bridge now proves transport only. `capabilities.cdp` becomes true only after `Runtime.enable` succeeds, while Debugger and Network probes retain independent partial-capability results across reconnect activation.
- Frida script creation/loading failures unload any owned script and detach the process session. Unexpected Frida detach also stops the DevTools proxy, with a structured finding and evidence event if proxy cleanup fails.
- Node.js 20 and 22 both pass `99` tests, `53`-tool contract/acceptance/smoke gates; Node.js 22 line coverage is `76.79%` overall, `34.64%` for `sessions/manager.js`, `62.69%` for `frida-adapter.js`, and `54.11%` for `dynamic.js`.
- After PR #15, a fresh v19977 mini-program lifecycle completed every required live gate: runtime bridge and CDP probes, AppService selection, evaluate, a real breakpoint, 727 trace wrappers, request hooks, API inventory, Network body, replay, same-session restart/reconnect, detach, and evidence export. The runner finished with `passed=true` and no errors; exported findings were resolved. Summary: `workspace/live-verification/wechat-miniapp/live-semantic-gate-v0.3.1-wmpf19977-1784363599773.json`, SHA-256 `efa04133c5352eb83b28fe8bc1b24807ecee1f610d31c91f1d39c677ed8168d1`.

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

## Static subprocess CI closure

- A controlled Node backend fixture now exercises the actual `execFile` boundary without committing package samples or extracted trees.
- CI covers successful decompile, restored-source search/index generation, successful non-empty repack, backend non-zero exit mapping, and successful no-output rejection.
- Scripted `.js`/`.mjs`/`.cjs` backends run through the current Node executable; native Gwxapkg binaries keep the direct executable path.

## WMPF v20079 profile cross-version closure

- The official WMPF v20079 module is bound to SHA-256 `b28ec2d547e8771aeebe94ba77bc618941c0ce0794ef443f905666f0668f5d2b` by the bundled reviewed profile.
- The `cdpFilter` and wildcarded `loadStart` AOB patterns each produced one unique match on reviewed v19977 and v20079 modules and resolved to the independently checked offsets.
- Candidate generation, expected-hash validation, offset bounds, review blocking, reviewed-profile injection readiness, production `FridaRuntimeAdapter` hook attachment, `ready`, and explicit detach passed on v20079.
- The v20079 run did not execute a mini-program AppService/CDP/Network/trace/request-hook/replay/reconnect semantic gate; v19977 remains the full semantic reference.

## Public repository audit

- The current working tree and every reachable Git blob were scanned for credential formats, private-key material, credential-bearing URLs, sensitive filenames, forbidden binary/package extensions, and files larger than 5 MiB; no findings were produced.
- All 10 pull-request titles/bodies and their comment/review collections were checked; no credential-pattern findings were produced.
- All 32 GitHub Actions runs through the PR #12 merge were checked. Logs exposed only GitHub-masked `***` authentication fields; no raw credential pattern was observed.
- `package.json` keeps `"private": true` as an npm publication guard. It does not describe GitHub visibility.

## Phase status

| Phase | Status | Verified evidence | Remaining gate |
|---|---|---|---|
| 0. Repository and governance | Complete | Child repository, submodule boundary, MIT license, ignore rules, clean-room/legacy separation | — |
| 1. Lightweight MCP core | v0.4.0 local gate complete | stdio cold start, 16/59 toolsets, instructions/prompts/resources, schemas/annotations/structured output, codec/bridge/protocol-recorder tests | Official MCP conformance remains optional follow-up |
| 2. Dynamic reverse workflow | v0.3.1 live accepted; v0.5.2 kernel local-complete; v20079 full-semantic runtime-pending | v19977 full semantic; v20079 Frida + one 9421/CDP/Network connect (`wxmp-1a4846a1`) | AppService/`wx` evaluate and the remaining semantic gates on v20079 |
| 3. Static reverse workflow | Acceptance complete | prior main/plugin/subpackage/minigame evidence plus reproducible backend subprocess decompile/search/index/repack and failure/no-output gates | — |
| 4. Profile lifecycle | Complete | canonical v19977/v20079 reviewed profiles, per-module SHA-256 binding, unique cross-version AOB matches, candidate review gate, v20079 production attach/detach | — |
| 5. Parent integration | v0.5.2 gitlink pushed | `reverse_ENV` `1cb426b` points `mcp/wechat-miniapp-re-mcp` at child `42402d3` | Merge child PR #18, then refresh gitlink if later commits land |
| 6. Git delivery | v0.5.2 PR open | PR #18 carries the unattended runtime kernel | Merge #18 after review; working-tree live-gate 60s AppService wait is not in `42402d3` |

## Automated verification

- TypeScript strict typecheck and build.
- Node test suite: 107 passing tests, adding unknown-envelope retention, compound-index ambiguity, breakpoint normalization, non-destructive Hook cursors, transport-aware replay, app snapshot, binary evidence, continuation recovery and MCP capability coverage to the existing acceptance/runtime/static/Profile suite.
- MCP contract checks exact 16-agent/59-expert inventories, required tools, prefix, duplicates, metadata/output schemas, API inventory, README markers and version agreement.
- stdio smoke starts both toolsets without WeChat and verifies initialize, list-tools metadata, `wxmp_health` structured output, prompts and resources.
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

The remaining real-target gaps are the v0.4.0/v0.5.2 agent-first workflow repeat gate on v19977 and a full second-version mini-program semantic gate. Cross-version AOB uniqueness, profile hash binding, production hook attachment, detach, and one post-reload 9421/CDP/Network connect are closed on WMPF v20079. AppService selection is not.

## Known limitations and next actions

1. Resume only with a coordinated live-gate: keep PC WeChat and one mini-program open; start the runner; wait until Frida `ready`; then close and reopen that mini-program; keep it in the foreground. Reloading before inject misses `LoadStart`.
2. Keep the working-tree AppService 60s / reconnect wait (or commit it) before the next 20079 attempt. The 20s `call('wxmp_probe_contexts')` path is a known miss after 9421 connect.
3. If 9421 connects again and `session.contexts` is still empty, inspect captured `wmpf.setupContext` artifacts versus missing `addJsContext` events. Do not copy GPL decoder source; keep unknown envelopes as bounded artifacts until a clean-room decoder is attested.
4. `forceDebugTrigger` remains observation-only. Do not treat it as a substitute for the operator reload.
5. A v19977 repeat of the v0.5.2 agent-first sequence is still outstanding; v19977 v0.3.1 remains the last full-semantic reference.

## Update rule

Update this document whenever a real acceptance gate changes, a public tool schema changes, or Git delivery state changes. Code existence, a returned CDP response, or a local-only pass is not sufficient evidence for 100% completion.
