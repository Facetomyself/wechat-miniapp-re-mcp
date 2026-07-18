# Development and PR Workflow

1. Keep transport, runtime, evidence, static adapters, and MCP tool registration separated.
2. Add unit fixtures before changing the wire codec or profile schema.
3. Validate cold startup without WeChat, then mock bridge behavior, then real WMPF attach.
4. A real-target failure must be recorded as a capability gap with reproducible evidence.
5. Push the child repository commit before updating the parent repository gitlink.
6. Exercise disconnect/reconnect and reject concurrent bridge ownership in contract tests; the WMPF endpoint has no session handshake.
7. Treat generated profiles as candidates: target-version/hash-bound, validation-visible, and blocked from attach until `wxmp_profile_promote` records explicit review evidence.
8. Treat capability flags as verified state: CDP domain enablement, context probes, wrapper counts, breakpoint locations/hits, and replay results must be asserted semantically.
9. Keep third-party offset/profile data outside Git. Compatibility profiles are loaded only from `WXMP_LEGACY_PROFILE_DIR`.
10. Tool handlers require JSON Schema validation plus focused behavior tests for success, structured failure, and cleanup.
11. Context-owned scripts and requests must keep using their originating WMPF context; do not silently reroute them through the currently selected context.
12. Large MCP responses must replace the raw nested CDP value after artifact extraction, and evidence persistence must remain within both event-count and byte caps.
13. Acceptance claims live in `data/acceptance/`; a verified record must pass schema, profile hash, module hash, evidence-reference, inventory, and depth gates.
14. Use `scripts/live-semantic-gate.mjs` for real-target closure. Temporary `.wxmp-workspace` runners are historical evidence only and must not become the maintained workflow.

## Acceptance commands

```powershell
& "D:\reverse_ENV\tools\node\npm.cmd" run check
& "D:\reverse_ENV\tools\node\npm.cmd" run live-gate:dry -- --wmpf-version 20079
git diff --check
git status --short --branch
```

CI runs the same gate on Node.js 20 and 22. A PR is not delivery-complete while either matrix job is red or absent.
The test command uses `scripts/run-tests.mjs` to enumerate compiled test files explicitly; passing the `build/test` directory directly is not portable across Node 20/22 on Windows.

Real-target acceptance is intentionally separate from CI. Run `npm run live-gate -- --wmpf-version <version>` only with the target mini-program open and lifecycle-triggerable. A bridge timeout is a failed `runtimeBridge` gate, not a successful attach; the runner must still detach and export failure evidence.
