# Repository Rules

## Boundaries

- This repository contains only the MCP server and clean-room protocol/runtime code.
- Third-party binaries, wxapkg samples, extracted projects, WMPF binaries, profiles copied from other tools, captures, cookies, and credentials must stay outside Git.
- Runtime artifacts must be written below the configured workspace root.
- Do not add a GUI, SSE dependency, or an always-on daemon. The stdio process must start without WeChat or Frida targets.

## Architecture

- MCP tools use the `wxmp_*` prefix.
- Dynamic operations require an explicit `session_id`; context-specific operations also require `context_id`.
- Session history is multi-session, but the shared WMPF `127.0.0.1:9421` runtime slot is fail-safe single-owner because the runtime protocol has no PID/session handshake. Reject concurrent attaches instead of guessing socket ownership.
- Unexpected runtime disconnects must retain the MCP session, requeue the same bridge owner, reset only ephemeral CDP state, and preserve evidence/context listeners for reconnect.
- Frida is imported lazily by the runtime adapter.
- Static engines are isolated behind adapters; do not embed GPL implementations into the MIT core.
- Unsupported runtime capabilities must return structured evidence, never synthetic success.
- A connected bridge proves transport only. Debugger/network require successful CDP probes; trace/request hooks require non-zero installed wrappers and are tracked per context.
- Bundled clean-room profiles use canonical `windows-<version>.json` names and load before external legacy directories. Third-party profile contents remain outside Git.

## Development

- UTF-8 and LF for text files.
- Use the project Node runtime supplied by the parent repository.
- Before commit run: `npm run check`, `git diff --check`, and `git status --short`.
- New tools require contract tests and README/API updates.
- Changes to public tool schemas require a version bump.
- Generated profile candidates must bind to a module SHA-256 and remain non-injectable until their confidence is promoted with review evidence.
- Acceptance claims must be recorded below `data/acceptance/` and pass `npm run acceptance`; do not represent a shallower Profile gate as full semantic verification.
- Real-target validation uses `scripts/live-semantic-gate.mjs`. Keep summaries and session artifacts in the configured workspace, and preserve structured failure evidence when a lifecycle gate does not trigger.

## Git

- Default branch: `main`; feature work goes through pull requests.
- Never commit generated `build/`, `node_modules/`, runtime logs, evidence, package payloads, or secrets.
- Commit messages must describe the actual behavior delivered.
