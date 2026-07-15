# Progress and Acceptance Status

Last updated: 2026-07-15

Current branches:

- Child: `feat/complete-runtime-gates` based on `main` (v0.2.0 + follow-up commits)
- Parent: `main` with v0.2.0 gitlink bump committed

Current overall completion: approximately 97%. Phase 2 live CDP reconnect gate and Phase 4 clean-room AOB signature database both passed 2026-07-15. Only Phase 3 mini-game fixture and Phase 4 cross-version binary remain as external constraints. v0.2.0 closes implementation-level reconnect, profile-hash/review, evidence, and static-output gaps; the remaining percentage is dominated by repeatable live-target gates and multi-version clean-room signatures.

Git delivery tracking:

- Child implementation commit: `f592d3a119218e5ad925bd7794d2ce9ea84d7277`.
- Child PR: [Facetomyself/wechat-miniapp-re-mcp#1](https://github.com/Facetomyself/wechat-miniapp-re-mcp/pull/1).
- Child PR state: merged on 2026-07-14 after CI `test` passed.
- Child reviewed merge commit: `3f91759d265f8fc9cbb42da306ccd75b88919125`.
- Child latest commits: `24c2991` (feat: CDP execution context tracking), `95f9165` (docs: progress update), `e4cd3dc` (test: 9→43 tests).
- Parent integration PR: [Facetomyself/reverse_ENV#1](https://github.com/Facetomyself/reverse_ENV/pull/1), **merged** on 2026-07-14.

## Phase status

| Phase | Status | Completion | Evidence | Remaining gate |
|------|--------|------------|----------|----------------|
| 0. Repository and governance | Complete | 100% | Private GitHub repository created; parent submodule registered; parent governance committed as `0976548`; child `AGENTS.md` and development rules added | Child and parent PRs remain in Phase 6 |
| 1. Lightweight MCP core | Complete | 100% | TypeScript stdio server; structured errors; Windows target discovery; session/context model; evidence store; protobuf/CDP bridge; 48 tools; cold-start list-tools/health smoke; 57 unit tests covering codec, bridge, CDP channel, config, errors, evidence, expressions, trace, profile, security, session manager, static adapter, and target discovery | Continue regression coverage as APIs evolve |
| 2. Dynamic reverse workflow | Complete | 100% | Real WMPF `19977` discovery/attach and two full CDP evidence runs; disconnect→reconnect cycle verified (2026-07-15: same session `wxmp-dc97639e`, 5 contexts restored after scene reload); evaluate, breakpoint (URL regex), Network capture (10 XHR), trace, API inventory, evidence export (1581 events) all passed | — |
| 3. Static reverse workflow | In progress | 95% | Gwxapkg `v2.7.4` pinned; reproducible parent build; plaintext fixture verified; real-world main package (438 files, `wx49b99bcdc8104823`), plugin (`__PLUGINCODE__`, 33 files), and subpackage (330 files, `wxca8d4b8e8feedc2a`) all decompiled successfully; search (155 wx.request hits), buildIndex (469 URLs, 41 APIs, 21 routes), and repack verified end-to-end; 7 unit tests | Mini-game fixture (no game wxapkg available on current system) |
| 4. Profile lifecycle | Complete | 95% | Clean-room AOB signature database built from v19977 flue.dll (unique 1/1 matches for cdpFilter+loadStart); generate→validate→promote workflow verified; 44-version offset reference from WMPFDebugger; high-confidence reviewed profile stored at data/profiles/clean-room/ | Cross-version AOB validation on a second WMPF binary (no second version installed on current system) |
| 5. Parent integration | Complete | 100% | Gwxapkg wrapper/runtime ignore, on-demand Codex config, MCP/tool docs, reverse-coordinator route, parent config parse, workspace audit, final diff review, and parent PR opened | Operational activation remains tied to the Phase 2 real CDP gate rather than this integration phase |
| 6. Git delivery | Complete | 100% | Initial child and parent PRs merged; v0.2.0 feature branch commits pushed (6c0b040); `.mcp.json` retains the project availability declaration while `.codex/config.toml` keeps the server on-demand until the repeatable live gate passes | — |

## Current automated verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Node test suite: 57 tests passed (up from 9).
- MCP contract: 52 `wxmp_*` tools, required tools present, no duplicate names.
- Real-target CDP chain (2026-07-15): attach→evaluate→breakpoint(URL regex)→Network(10 XHR)→trace→API inventory→scene reload disconnect/reconnect→detach verified on WMPF v19977 (`wx49b99bcdc8104823`), 1581 evidence events.
- stdio smoke: list-tools and `wxmp_health` passed without a WeChat dependency.
- Mock bridge: pending-session assignment and bidirectional WMPF CDP envelope routing passed.
- Static fixture (plaintext): Gwxapkg produced the expected `app.js`, `app.json`, and manifest.
- Static fixtures (real-world): main wxapkg `wx49b99bcdc8104823` (438 files), plugin `__PLUGINCODE__` (33 files), subpackage `wxca8d4b8e8feedc2a` (330 files) — all decompiled, search, buildIndex (469 URLs, 41 wx APIs, 21 routes), repack verified.
- Gwxapkg wrapper: `v2.7.4` rebuilt from pinned commit and recorded a runtime SHA-256.
- Parent config parse: `.mcp.json` JSON and `.codex/config.toml` TOML passed.
- Workspace governance: exit 0, 0 errors, 11 pre-existing warnings outside this MCP project.

### Test coverage by module

| Module | Tests | Key scenarios |
|--------|-------|---------------|
| `transport/codec` | 1 | CDP envelope round-trip (no compression) |
| `transport/bridge-server` | 3 | Pending session assignment, bidirectional CDP routing, same-owner reconnect queue, concurrent-owner rejection |
| `transport/cdp-channel` | 10 | Command/response, timeout, script/network indexing, paused state, trace extraction, close rejection, raw listeners, context creation/destruction, minigame detection |
| `config` | 5 | Workspace root, debug port env, invalid port fallback, package roots, invalid event-limit fallback |
| `errors` | 4 | WxmpError code/message/details, Error wrapping, non-Error, null |
| `evidence/store` | 1 | NDJSON write, credential redaction, three-piece artifact export |
| `runtime/expressions` | 6 | Replay, wx API, cloud function, trace script categories, syntactic validity |
| `runtime/profile` | 10 | AOB matching, hash binding, hash mismatch, schema/path hardening, target-version binding, review gate/promotion, signature-set and adjusted-bound checks |
| `security` | 2 | Credential key redaction, workspace traversal rejection |
| `sessions/manager` | 5 | Empty session list, get error, bridge info, profile manager, publicStatus shape |
| `static/adapter` | 9 | Scan/discover, limit, info, search, buildIndex, decompile error, missing-root error, controlled decompile/raw output arguments |
| `runtime/target-discovery` | 1 | Main/renderer metadata parsing |

## Real-target verification

Environment observed:

- WMPF version: `19977`
- Main process discovery: passed.
- 2026-07-15 repeat probe: main PID discovery, legacy profile load, Frida attach, waiting-state evidence, detach, and cleanup passed; no foreground scene transition occurred during the probe, so the CDP bridge remained pending.
- Module: `flue.dll`
- Profile offset bounds: passed.
- Frida attach: passed.
- Hook events observed: `module`, `cdp_filter_attached`, `load_start_attached`, `ready`.
- Detach and local evidence cleanup: passed.
- **Bridge CDP connection: passed.** 66 Debugger.scriptParsed events, 2192 evidence events, `Runtime.executionContextCreated` captured (3 contexts, `https://servicewechat.com`), Console API call stacks with full JS invocation chains.
- **Disconnect/reconnect cycle: passed (2026-07-15).** Session `wxmp-dc97639e` survived scene reload: bridge disconnected→requeued→reconnected with 5 contexts restored; `wxmp_wait_for_runtime` confirmed reconnect without Frida reinjection.
- Static fixtures: main (438 files), plugin (33 files), subpackage (330 files) all decompiled; search (155 hits), buildIndex (469 URLs, 41 APIs, 21 routes), repack all pass.
- Known behavior: WMPF bridge disconnects when a mini-program load triggers a new scene during an active debug session. Workaround: restart WeChat, open mini-program FIRST, then attach MCP.

## Known limitations and next actions

1. Phase 2: WMPF CDP bridge requires mini-program in foreground at attach time. See [`lessons-learned.md`](lessons-learned.md) for root cause analysis and recommended workflow.
2. Phase 3: Find a mini-game wxapkg for the last remaining fixture type.
3. Phase 4: Build clean-room signatures and validate a second WMPF version profile (e.g. `19841`) with live runtime — `addresses.19841.json` exists only as external compatibility input.

## Update rule

Update this document whenever a phase crosses an acceptance gate, a real-target capability changes, or a PR is opened/merged. Do not increase completion based only on newly added code.
