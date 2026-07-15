# Implementation Plan

## Objective

Deliver a lightweight, reverse-engineering focused MCP server for PC WeChat WMPF runtimes and `.wxapkg` packages. The server must start over stdio without WeChat, a GUI, an SSE service, or an active Frida target, and load target-specific components only when requested.

## Locked decisions

- Repository: `Facetomyself/wechat-miniapp-re-mcp`, public after the pre-release working-tree/history/Actions audit; npm publication remains disabled.
- Parent mount: `D:\reverse_ENV\mcp\wechat-miniapp-re-mcp` as a Git submodule.
- Runtime: TypeScript, project Node.js, `@modelcontextprotocol/sdk`.
- MCP prefix: `wxmp_*`.
- Platform: Windows complete first; macOS remains an adapter boundary.
- Session model: explicit `session_id`; context-sensitive calls also accept `context_id`. Historical sessions remain isolated, while the handshake-free shared WMPF bridge allows one active/pending runtime owner and rejects concurrent ownership.
- Dynamic actions are available by default and written to the evidence audit stream.
- Static backend: MIT-licensed Gwxapkg through an isolated adapter; the MCP core does not embed GPL static engines.
- Protocol and hook implementation: clean-room core. External First-style offset profiles may be loaded locally for compatibility testing but are not copied into this repository.
- Mini programs receive the complete dynamic workflow. Mini games receive complete static handling and capability-gated dynamic support.

## Delivery phases

### Phase 0: Repository and governance

- Create the child repository privately, complete the sensitive-data audit, then publish it and continue feature work through pull requests.
- Mount it below the parent `mcp/` directory.
- Add repository-level `AGENTS.md`, development rules, MIT license, and Git exclusions.
- Update parent governance before implementation code.

Acceptance: both repositories have isolated branches, the audited child remote is public, and the parent references a remotely obtainable child commit.

### Phase 1: Lightweight MCP core

- Implement stdio startup and structured tool errors.
- Add Windows WMPF process discovery and runtime metadata parsing.
- Add explicit multi-session and context state.
- Add controlled workspace paths, evidence NDJSON, artifact pagination, and redaction.
- Implement the minimum WMPF protobuf/CDP codec and local bridge.

Acceptance: typecheck/build pass; MCP list-tools and health work without WeChat; codec and bridge mock tests pass.

### Phase 2: Dynamic reverse workflow

- Lazy-load Frida and inject the WMPF debug hook.
- Provide evaluate, raw CDP, script enumeration/source retrieval/search, breakpoints, pause/step/resume, and optional Chrome DevTools proxy.
- Provide Network capture, request indexing/body retrieval/replay.
- Provide reversible `wx.*`, cloud, navigation, storage, and network tracing.
- Export evidence-backed report/findings/triage artifacts.

Acceptance: a real supported WMPF build completes attach, hook-ready, runtime WebSocket connection, context discovery, evaluate, breakpoint, network, trace, replay, and detach.

### Phase 3: Static reverse workflow

- Pin Gwxapkg as a parent-repository tool dependency and build it into an ignored runtime directory.
- Provide package discovery, unpack/decompile, search, API/route index, repack, and raw adapter tools.
- Keep all generated source and reports inside the configured workspace.

Acceptance: encrypted/plain main-package, subpackage, plugin, and mini-game fixtures produce expected trees and indexes; no generated target material enters Git.

### Phase 4: WMPF Profile lifecycle

- Validate schema, module hash, and offset bounds.
- Support explicit AOB signatures and wildcard candidate scanning.
- Persist generated profiles as candidates only.
- Bind clean-room/generated profiles to the expected module SHA-256 and block candidate injection until review promotion.
- Record reviewer identity, review time, and evidence references in promoted generated profiles; reject target/profile version mismatches.
- Add a clean-room signature database and runtime validation workflow.

Acceptance: known versions reproduce stable candidates; ambiguous candidates never auto-inject; at least two WMPF versions pass runtime validation.

### Phase 5: Parent integration

- Add reproducible Gwxapkg build wrapper and ignored runtime path.
- Update project MCP configuration, service documentation, tool inventory, and reverse-coordinator routing.
- Keep `tools/First` as a deprecated reference without modifying its existing working tree.
- Keep the MCP on-demand until the complete real-target dynamic gate passes.

Acceptance: parent JSON/TOML configuration validates, workspace governance has zero errors, and a fresh submodule checkout can install/build/test using project-local runtimes.

### Phase 6: Git delivery

- Run child repository gates and create a child PR to `main`.
- Merge or otherwise establish the reviewed child commit on the remote.
- Update the parent gitlink, run parent gates, and create the parent integration PR.

Acceptance: both PRs exist, all referenced commits are remotely obtainable, and both working trees are clean.

## Global completion criteria

- No GUI, SSE, or First process dependency.
- No synthetic success for missing targets, profiles, contexts, or capabilities.
- Large sources and captures return summaries plus artifact paths rather than oversized MCP responses.
- No wxapkg, extracted source tree, WMPF binary, capture, profile copied from another tool, cookie, credential, or generated evidence is committed.
- Child checks, real-target gates, parent config validation, `git diff --check`, and workspace governance all pass.
