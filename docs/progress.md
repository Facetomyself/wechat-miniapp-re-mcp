# Progress and Acceptance Status

Last updated: 2026-07-14

Current branches:

- Child: `main` with reviewed delivery/status commits
- Parent: `feat/wechat-miniapp-re-mcp-integration`

Current overall completion: approximately 80%. This number reflects acceptance gates, not file count.

Git delivery tracking:

- Child implementation commit: `f592d3a119218e5ad925bd7794d2ce9ea84d7277`.
- Child PR: [Facetomyself/wechat-miniapp-re-mcp#1](https://github.com/Facetomyself/wechat-miniapp-re-mcp/pull/1).
- Child PR state: merged on 2026-07-14 after CI `test` passed.
- Child reviewed merge commit: `3f91759d265f8fc9cbb42da306ccd75b88919125`.
- Parent integration PR: [Facetomyself/reverse_ENV#1](https://github.com/Facetomyself/reverse_ENV/pull/1), open and mergeable; integration validation passed.

## Phase status

| Phase | Status | Completion | Evidence | Remaining gate |
|------|--------|------------|----------|----------------|
| 0. Repository and governance | Complete | 100% | Private GitHub repository created; parent submodule registered; parent governance committed as `0976548`; child `AGENTS.md` and development rules added | Child and parent PRs remain in Phase 6 |
| 1. Lightweight MCP core | Complete | 100% | TypeScript stdio server; structured errors; Windows target discovery; session/context model; evidence store; protobuf/CDP bridge; 46 tools; cold-start list-tools/health smoke | Continue regression coverage as APIs evolve |
| 2. Dynamic reverse workflow | In progress | 70% | Real WMPF `19977` process discovery; external profile probe; Frida attach; hook module/filter/load-start/ready events; clean detach; mock bidirectional bridge/CDP test | Real runtime WebSocket/context connection, evaluate, breakpoint, Network, trace and replay gates |
| 3. Static reverse workflow | In progress | 85% | Gwxapkg `v2.7.4` pinned as parent submodule; reproducible parent build wrapper passed; ignored runtime metadata contains source commit/SHA-256; generated plaintext fixture decompiled to `app.js`/`app.json`; adapter detects empty-output false success | Encrypted/subpackage/plugin/mini-game fixtures and index/repack gates |
| 4. Profile lifecycle | In progress | 55% | Profile schema, legacy runtime conversion, module SHA-256 and bounds probe, wildcard AOB candidate generation | Clean-room signature database, disassembly evidence, second WMPF version and runtime candidate validation |
| 5. Parent integration | Complete | 100% | Gwxapkg wrapper/runtime ignore, on-demand Codex config, MCP/tool docs, reverse-coordinator route, parent config parse, workspace audit, final diff review, and parent PR opened | Operational activation remains tied to the Phase 2 real CDP gate rather than this integration phase |
| 6. Git delivery | In progress | 90% | Child implementation and status PRs merged; parent gitlink points to child `main`; parent PR [Facetomyself/reverse_ENV#1](https://github.com/Facetomyself/reverse_ENV/pull/1) is open; all referenced commits are remotely obtainable | Review and merge the parent PR, then record Git delivery complete |

## Current automated verification

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Node test suite: 9 tests passed.
- MCP contract: 46 `wxmp_*` tools, required tools present, no duplicate names.
- stdio smoke: list-tools and `wxmp_health` passed without a WeChat dependency.
- Mock bridge: pending-session assignment and bidirectional WMPF CDP envelope routing passed.
- Static fixture: Gwxapkg produced the expected `app.js`, `app.json`, and manifest.
- Gwxapkg wrapper: `v2.7.4` rebuilt from pinned commit and recorded a runtime SHA-256.
- Parent config parse: `.mcp.json` JSON and `.codex/config.toml` TOML passed.
- Workspace governance: exit 0, 0 errors, 11 pre-existing warnings outside this MCP project.

## Real-target verification

Environment observed:

- WMPF version: `19977`
- Main process discovery: passed.
- Module: `flue.dll`
- Profile offset bounds: passed.
- Frida attach: passed.
- Hook events observed: `module`, `cdp_filter_attached`, `load_start_attached`, `ready`.
- Detach and local evidence cleanup: passed.
- Runtime debug WebSocket connection: pending because no post-attach mini-program reload/open occurred during the automated gate.

The current implementation therefore proves target discovery and hook injection, but it does not yet claim real-target CDP debugging completion.

## Known limitations and next actions

1. Complete a controlled post-attach mini-program open/reload and verify WMPF connection/context mapping.
2. Exercise evaluate, script source, breakpoint/stack, Network capture/body, trace, request replay, wx API, and cloud calls against that live context.
3. Add static fixtures for encrypted packages, subpackages, plugins, and mini games.
4. Add a clean-room signature set and validate a second WMPF version.
5. Review and merge parent PR [Facetomyself/reverse_ENV#1](https://github.com/Facetomyself/reverse_ENV/pull/1), then mark Phase 6 complete.

## Update rule

Update this document whenever a phase crosses an acceptance gate, a real-target capability changes, or a PR is opened/merged. Do not increase completion based only on newly added code.
