# wechat-miniapp-re-mcp

Reverse-engineering focused MCP server for PC WeChat WMPF runtimes and `.wxapkg` packages.

Project tracking:

- [Original `/plan` session output](docs/original-plan.md)
- [Implementation plan](docs/plan.md)
- [Progress and acceptance status](docs/progress.md)
- [MCP tool API](docs/api.md)
- [Lessons learned & known behaviors](docs/lessons-learned.md)

## Design

- stdio MCP; startup never requires WeChat, Frida, a GUI, or an SSE service
- explicit `session_id` / `context_id` isolation with one fail-safe active WMPF runtime slot
- lazy Frida attach and a local WMPF protobuf/CDP bridge
- disconnect/reconnect retention plus `wxmp_wait_for_runtime` without reinjecting Frida
- evidence-backed capability probing; transport connection alone does not advertise debugger/network/trace success
- AppService/WebView/mini-game context probing with automatic strongest-context selection
- PC WMPF `wx` runtime resolution across `globalThis`, `nav.wxFrame`, parent windows, and accessible child frames
- dynamic inspection, breakpoints, context-scoped network capture, `wx.*` tracing, request hooks, replay, and evidence export; unscoped WMPF events fall back to the selected context
- pluggable static backends, with Gwxapkg as the default adapter
- hash-bound generated profile candidates with explicit review-evidence promotion before injection
- bundled v19977/v20079 clean-room profiles and a cross-version AOB signature database, discovered automatically from the package
- clean-room protocol implementation; legacy First profiles can be consumed from an external local directory but are not copied into this repository

## Development

```powershell
& "D:\reverse_ENV\tools\node\npm.cmd" ci
& "D:\reverse_ENV\tools\node\npm.cmd" run check
```

The check gate uses a controlled Node backend fixture to exercise the real static `execFile` decompile/repack subprocess path on Node.js 20 and 22. Package inputs, restored files, and repacked `.wxapkg` outputs are generated below the OS temporary directory at test time; no package fixture is committed.

Start the server:

```powershell
& "D:\reverse_ENV\tools\node\node.exe" "D:\reverse_ENV\mcp\wechat-miniapp-re-mcp\build\src\index.js"
```

Useful environment variables:

- `WXMP_WORKSPACE_ROOT`: artifact root; defaults to `<cwd>/workspace`
- `WXMP_PROFILE_DIR`: additional clean-room profile directories; the bundled `data/profiles/clean-room` directory is loaded automatically
- `WXMP_LEGACY_PROFILE_DIR`: optional local First-style profile directory
- `WXMP_SIGNATURE_DB`: additional clean-room AOB signature database paths
- `WXMP_GWXAPKG`: path to the Gwxapkg executable; the parent repository builds it under `tools/Gwxapkg-runtime/`
- `WXMP_DEBUG_HOST` / `WXMP_DEBUG_PORT`: WMPF bridge listener, defaults to `127.0.0.1:9421`
- `WXMP_EVENT_LIMIT`: maximum events returned by one evidence query, defaults to `5000`
- `WXMP_MAX_EVIDENCE_EVENTS`: maximum persisted events per session before overflow is recorded, defaults to `100000`
- `WXMP_MAX_EVIDENCE_BYTES`: maximum persisted NDJSON bytes per session, defaults to `268435456` (256 MiB); oversized individual events are stored as bounded previews

The GitHub repository is public. The package keeps `"private": true` only to block accidental npm publication. Do not commit wxapkg files, extracted source trees, credentials, captures, third-party profiles, WMPF binaries, or generated evidence.
