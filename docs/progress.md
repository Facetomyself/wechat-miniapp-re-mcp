# Progress and Acceptance Status

Last updated: 2026-07-14

Current branches:

- Child: `main` with reviewed delivery/status commits
- Parent: `feat/wechat-miniapp-re-mcp-integration`

Current overall completion: approximately 90%. This number reflects acceptance gates, not file count.

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
| 1. Lightweight MCP core | Complete | 100% | TypeScript stdio server; structured errors; Windows target discovery; session/context model; evidence store; protobuf/CDP bridge; 46 tools; cold-start list-tools/health smoke; 41 unit tests covering codec, bridge, CDP channel, config, errors, evidence, expressions, trace, profile, security, session manager, static adapter, and target discovery | Continue regression coverage as APIs evolve |
| 2. Dynamic reverse workflow | In progress | 75% | Real WMPF `19977` process discovery; external profile probe; Frida attach; hook events; clean detach; bridge CDP connection (66 scripts parsed, 2192 events, 3 execution contexts captured); CDP context tracking via `Runtime.executionContextCreated` wired to session manager; 10 CDP channel unit tests; DevTools proxy code complete | Controlled mini-program open/reload after attach to verify context→evaluate→breakpoint→Network→trace→replay chain; WMPF bridge disconnects on fresh mini-program load (known behavior, needs reconnection handling) |
| 3. Static reverse workflow | In progress | 95% | Gwxapkg `v2.7.4` pinned; reproducible parent build; plaintext fixture verified; real-world main package (438 files, `wx49b99bcdc8104823`), plugin (`__PLUGINCODE__`, 33 files), and subpackage (330 files, `wxca8d4b8e8feedc2a`) all decompiled successfully; search (155 wx.request hits), buildIndex (469 URLs, 41 APIs, 21 routes), and repack verified end-to-end; 7 unit tests | Mini-game fixture (no game wxapkg available on current system) |
| 4. Profile lifecycle | In progress | 60% | Profile schema, legacy runtime conversion, module SHA-256 and bounds probe, wildcard AOB candidate generation; profile unit tests (2 tests) for AOB signature matching | Clean-room signature database, disassembly evidence, second WMPF version and runtime candidate validation |
| 5. Parent integration | Complete | 100% | Gwxapkg wrapper/runtime ignore, on-demand Codex config, MCP/tool docs, reverse-coordinator route, parent config parse, workspace audit, final diff review, and parent PR opened | Operational activation remains tied to the Phase 2 real CDP gate rather than this integration phase |
| 6. Git delivery | Complete | 100% | Child implementation and status PRs merged; parent gitlink points to child `main`; parent PR [Facetomyself/reverse_ENV#1](https://github.com/Facetomyself/reverse_ENV/pull/1) **merged** on 2026-07-14; all referenced commits remotely obtainable; child repo has 4 post-delivery commits (docs, tests, CDP context tracking, progress); MCP promoted to default cold-start in `.mcp.json`, `.codex/config.toml`, and `~/.claude.json` | - |

## Current automated verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Node test suite: 43 tests passed (up from 9).
- MCP contract: 46 `wxmp_*` tools, required tools present, no duplicate names.
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
| `transport/bridge-server` | 1 | Pending session assignment, bidirectional CDP routing |
| `transport/cdp-channel` | 10 | Command/response, timeout, script/network indexing, paused state, trace extraction, close rejection, raw listeners, context creation/destruction, minigame detection |
| `config` | 4 | Workspace root, debug port env, invalid port fallback, package roots |
| `errors` | 4 | WxmpError code/message/details, Error wrapping, non-Error, null |
| `evidence/store` | 1 | NDJSON write, credential redaction, three-piece artifact export |
| `runtime/expressions` | 6 | Replay, wx API, cloud function, trace script categories, syntactic validity |
| `runtime/profile` | 2 | AOB wildcard matching, malformed byte rejection |
| `security` | 2 | Credential key redaction, workspace traversal rejection |
| `sessions/manager` | 5 | Empty session list, get error, bridge info, profile manager, publicStatus shape |
| `static/adapter` | 7 | Scan/discover, limit, info, search, buildIndex, decompile error, missing-root error |
| `runtime/target-discovery` | 1 | Main/renderer metadata parsing |

## Real-target verification

Environment observed:

- WMPF version: `19977`
- Main process discovery: passed.
- Module: `flue.dll`
- Profile offset bounds: passed.
- Frida attach: passed.
- Hook events observed: `module`, `cdp_filter_attached`, `load_start_attached`, `ready`.
- Detach and local evidence cleanup: passed.
- **Bridge CDP connection: passed.** 66 Debugger.scriptParsed events, 2192 evidence events, `Runtime.executionContextCreated` captured (3 contexts, `https://servicewechat.com`), Console API call stacks with full JS invocation chains.
- Static fixtures: main (438 files), plugin (33 files), subpackage (330 files) all decompiled; search (155 hits), buildIndex (469 URLs, 41 APIs, 21 routes), repack all pass.
- Known behavior: WMPF bridge disconnects when a mini-program load triggers a new scene during an active debug session. Workaround: restart WeChat, open mini-program FIRST, then attach MCP.

## Known limitations and next actions

1. Restart WeChat + open mini-program first, then attach MCP to avoid bridge teardown; verify evaluate/breakpoint/Network/trace/replay end-to-end.
2. Find a mini-game wxapkg for the last remaining Phase 3 fixture type.
3. Validate a second WMPF version profile (e.g. `19841`) with live runtime — `addresses.19841.json` exists.

## Update rule

Update this document whenever a phase crosses an acceptance gate, a real-target capability changes, or a PR is opened/merged. Do not increase completion based only on newly added code.
