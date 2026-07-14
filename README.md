# wechat-miniapp-re-mcp

Reverse-engineering focused MCP server for PC WeChat WMPF runtimes and `.wxapkg` packages.

Project tracking:

- [Original `/plan` session output](docs/original-plan.md)
- [Implementation plan](docs/plan.md)
- [Progress and acceptance status](docs/progress.md)
- [MCP tool API](docs/api.md)

## Design

- stdio MCP; startup never requires WeChat, Frida, a GUI, or an SSE service
- explicit `session_id` / `context_id` isolation
- lazy Frida attach and a local WMPF protobuf/CDP bridge
- dynamic inspection, breakpoints, network capture, `wx.*` tracing, replay, and evidence export
- pluggable static backends, with Gwxapkg as the default adapter
- clean-room protocol implementation; legacy First profiles can be consumed from an external local directory but are not copied into this repository

## Development

```powershell
& "D:\reverse_ENV\tools\node\npm.cmd" ci
& "D:\reverse_ENV\tools\node\npm.cmd" run check
```

Start the server:

```powershell
& "D:\reverse_ENV\tools\node\node.exe" "D:\reverse_ENV\mcp\wechat-miniapp-re-mcp\build\src\index.js"
```

Useful environment variables:

- `WXMP_WORKSPACE_ROOT`: artifact root; defaults to `<cwd>/workspace`
- `WXMP_PROFILE_DIR`: clean-room profile directory
- `WXMP_LEGACY_PROFILE_DIR`: optional local First-style profile directory
- `WXMP_GWXAPKG`: path to the Gwxapkg executable; the parent repository builds it under `tools/Gwxapkg-runtime/`
- `WXMP_DEBUG_HOST` / `WXMP_DEBUG_PORT`: WMPF bridge listener, defaults to `127.0.0.1:9421`

The repository is private during initial development. Do not commit wxapkg files, extracted source trees, credentials, captures, WeChat profiles, WMPF binaries, or generated evidence.
Reverse-engineering focused WeChat Mini Program and WMPF debugging MCP server
