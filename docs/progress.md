# Progress and Acceptance Status

Last updated: 2026-07-15

Current working state:

- Child branch: `feat/complete-runtime-gates`
- Package version: `0.3.0`
- v0.3.0 remediation is delivered through PR #6 with green Node 20/22 CI; the parent gitlink update and repeatable live semantic gates remain pending.
- Overall implementation completion: about 90%.
- Original acceptance completion: about 84%.

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

## Phase status

| Phase | Status | Completion | Verified evidence | Remaining gate |
|---|---|---:|---|---|
| 0. Repository and governance | Complete | 100% | Child repository, submodule boundary, MIT license, ignore rules, clean-room/legacy separation | — |
| 1. Lightweight MCP core | Implementation complete | 100% | stdio cold start, schema validation, structured errors, codec/bridge tests, reconnect ownership, evidence persistence | Official MCP conformance remains optional follow-up |
| 2. Dynamic reverse workflow | Gated | 85% | v19977 bridge, evaluate, source enumeration, Network events, disconnect/reconnect observed; semantic guards implemented | Repeat live v0.3 gate for AppService selection, bound/hit breakpoint, non-zero trace/hook event, replay result, detach |
| 3. Static reverse workflow | Implementation complete | 95% | main/plugin/subpackage/minigame fixtures previously decompiled/indexed; path/no-output guards covered | Add reproducible real Gwxapkg subprocess fixture to CI |
| 4. Profile lifecycle | Gated | 90% | canonical v19977 reviewed profile, module SHA-256 gate, candidate promotion, default AOB database wiring | Validate clean-room AOB/profile on a second real WMPF version |
| 5. Parent integration | Pending refresh | 90% | existing on-demand config and Gwxapkg integration remain compatible | Restart/re-enable parent MCP with v0.3.0 build and update parent docs/gitlink |
| 6. Git delivery | Complete | 100% | PR #6 carries v0.3.0; Node 20 and Node 22 checks are green | — |

## Automated verification

- TypeScript strict typecheck and build.
- Node test suite: 73 passing tests covering bridge, codec, CDP state, context/request indexing, originating-context source/replay behavior, request hooks, proxy client ID/context isolation, evidence count/byte overflow and write recovery, profile gates, static guards, server schema validation, and target discovery.
- MCP contract checks required tools, prefix, duplicates, and minimum inventory.
- stdio smoke verifies initialize, list-tools, and `wxmp_health` without WeChat.
- Production dependency audit reports no known vulnerabilities at the time of this update.

## Real-target evidence status

Previously observed on WMPF v19977:

- main-process discovery and Frida hook load;
- WMPF protobuf/CDP bridge connection;
- script enumeration and source retrieval;
- `Runtime.evaluate` responses;
- Network request/response events;
- same-session disconnect/requeue/reconnect;
- evidence bundle export and detach.

The previous evidence does not prove the following semantic gates:

- a breakpoint bound to a non-empty location or produced `Debugger.paused`;
- a trace wrapper count greater than zero and at least one `trace.event`;
- an installed request hook captured a fixture request;
- request replay returned and was recorded;
- a second WMPF module matched the clean-room AOB signatures.

v0.3.0 now reports these gaps instead of treating command responses as success. Completion increases only after new live evidence closes them.

## Known limitations and next actions

1. Restart the currently running stdio server so port `127.0.0.1:9421` uses the v0.3.0 build, then run the complete live semantic gate.
2. Keep the mini-program foreground before attach; the WMPF debug filter remains lifecycle-triggered.
3. Obtain a second WMPF binary and validate AOB uniqueness, hash binding, attach, and detach.
4. Add a small distributable static fixture or controlled backend stub for CI subprocess verification.
5. Update the parent submodule gitlink and integration docs to the merged v0.3.0 child commit.

## Update rule

Update this document whenever a real acceptance gate changes, a public tool schema changes, or Git delivery state changes. Code existence, a returned CDP response, or a local-only pass is not sufficient evidence for 100% completion.
