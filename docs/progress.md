# Progress and Acceptance Status

Last updated: 2026-07-18

Current working state:

- Child branch: `main`
- Package version: `0.3.1`
- Repository visibility: `public` after a working-tree, reachable-history, pull-request, and Actions-log sensitive-data audit.
- v0.3.0 remediation is delivered through PR #6; v0.3.1 closes the repeatable WMPF v19977 semantic gate through PR #7; WMPF v20079 profile/AOB/hash-binding closure is delivered through PR #11; public delivery status is recorded by PR #12. Parent gitlink/public-status synchronization is merged through `reverse_ENV` PR #6.
- The original delivery phases are complete except for the full second-version mini-program semantic gate.
- Future product work and acceptance priorities are tracked in [`roadmap.md`](roadmap.md); this file records achieved capability gates only.

The project is not marked complete by a percentage. Transport connectivity, tool invocation, semantic capability success, and repeatability are tracked as separate gates.

## v0.3.2 acceptance contract foundation

- Added `data/acceptance/schema-v1.json`, an exact record index, and reviewed records for WMPF v19977 `full-semantic` and v20079 `profile-runtime` depth.
- `npm run acceptance` validates record schema, Profile file SHA-256, module SHA-256, Profile metadata, evidence references, index drift, and the gates required by the claimed depth.
- The MCP contract now also checks package/lock/source/build version agreement, README tool-count markers, and exact `docs/api.md` tool inventory.
- Added the tracked `scripts/live-semantic-gate.mjs` runner with controlled output paths, target/version selection, AOB regeneration, canonical gate names, reconnect control, sanitized summaries, and failure evidence export.
- On 2026-07-18 the current v19977 process passed health/Profile/module/AOB/Frida attach and clean detach, but its lifecycle did not enter the WMPF debug filter during the run; `runtimeBridge` failed and the remaining semantic gates were recorded as `not-run`. Failure summary: `workspace/live-verification/wechat-miniapp/live-semantic-gate-v0.3.1-wmpf19977-1784349870424.json`, SHA-256 `32d88592c39c829d3c93b4fe792d2b82e56f89ffe10d888e68a5bd47c7648f00`. This is runner/failure-closure evidence, not a new successful v19977 acceptance run.
- No WMPF v20079 runtime is currently active on this machine, so the second-version semantic gate remains pending.

## Project review P0 remediation

- Windows default package discovery now includes current `radium/users/<user>/applet/packages` trees while retaining the legacy `radium/Applet/packages` root; the default stdio `wxmp_scan_packages` call finds cached packages on the reviewed xwechat installation.
- A connected bridge now proves transport only. `capabilities.cdp` becomes true only after `Runtime.enable` succeeds, while Debugger and Network probes retain independent partial-capability results across reconnect activation.
- Frida script creation/loading failures unload any owned script and detach the process session. Unexpected Frida detach also stops the DevTools proxy, with a structured finding and evidence event if proxy cleanup fails.
- Node.js 20 and 22 both pass `99` tests, `53`-tool contract/acceptance/smoke gates; Node.js 22 line coverage is `76.79%` overall, `34.64%` for `sessions/manager.js`, `62.69%` for `frida-adapter.js`, and `54.11%` for `dynamic.js`.

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
| 1. Lightweight MCP core | Implementation complete | stdio cold start, schema validation, structured errors, codec/bridge tests, reconnect ownership, evidence persistence | Official MCP conformance remains optional follow-up |
| 2. Dynamic reverse workflow | v19977 acceptance complete | AppService selection, evaluate, bound breakpoint, trace/hook events, inventory, Network body, replay, reconnect, detach, evidence export; v20079 hook attach/detach passed | Repeat the full mini-program semantic gate on v20079 or another second WMPF version |
| 3. Static reverse workflow | Acceptance complete | prior main/plugin/subpackage/minigame evidence plus reproducible backend subprocess decompile/search/index/repack and failure/no-output gates | — |
| 4. Profile lifecycle | Complete | canonical v19977/v20079 reviewed profiles, per-module SHA-256 binding, unique cross-version AOB matches, candidate review gate, v20079 production attach/detach | — |
| 5. Parent integration | Complete | `reverse_ENV` PR #6 advances the gitlink to child `7504046` and records Public/cross-version/workspace governance status | — |
| 6. Git delivery | Complete | PR #6 carries v0.3.0; PR #7 carries v0.3.1; PR #11 carries WMPF v20079 profile/AOB/hash-binding closure; PR #12 records public delivery; parent integration is merged through `reverse_ENV` PR #6 | — |

## Automated verification

- TypeScript strict typecheck and build.
- Node test suite: 99 passing tests covering acceptance records, live-runner dry-run/path guards, bridge, codec, CDP state and activation probes, nested WMPF `wx` resolution, context/request indexing, originating/unscoped-context source and replay behavior, request hooks, proxy client ID/context isolation and detach cleanup, Frida script-init cleanup, current xwechat package discovery, evidence count/byte overflow and write recovery, profile gates, cross-version AOB/profile fixtures, static guards and real backend subprocess behavior, server schema validation, and target discovery.
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

The remaining real-target gap is a full second-version mini-program semantic gate. Cross-version AOB uniqueness, profile hash binding, production hook attachment, and detach are closed on WMPF v20079.

## Known limitations and next actions

1. Run the v19977 AppService/CDP/Network/trace/request-hook/replay/reconnect semantic sequence on WMPF v20079 or another reviewed second version.
2. Keep the mini-program selector available before attach; the WMPF debug filter remains lifecycle-triggered.

## Update rule

Update this document whenever a real acceptance gate changes, a public tool schema changes, or Git delivery state changes. Code existence, a returned CDP response, or a local-only pass is not sufficient evidence for 100% completion.
