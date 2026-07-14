# Repository Rules

## Boundaries

- This repository contains only the MCP server and clean-room protocol/runtime code.
- Third-party binaries, wxapkg samples, extracted projects, WMPF binaries, profiles copied from other tools, captures, cookies, and credentials must stay outside Git.
- Runtime artifacts must be written below the configured workspace root.
- Do not add a GUI, SSE dependency, or an always-on daemon. The stdio process must start without WeChat or Frida targets.

## Architecture

- MCP tools use the `wxmp_*` prefix.
- Dynamic operations require an explicit `session_id`; context-specific operations also require `context_id`.
- Frida is imported lazily by the runtime adapter.
- Static engines are isolated behind adapters; do not embed GPL implementations into the MIT core.
- Unsupported runtime capabilities must return structured evidence, never synthetic success.

## Development

- UTF-8 and LF for text files.
- Use the project Node runtime supplied by the parent repository.
- Before commit run: `npm run check`, `git diff --check`, and `git status --short`.
- New tools require contract tests and README/API updates.
- Changes to public tool schemas require a version bump.

## Git

- Default branch: `main`; feature work goes through pull requests.
- Never commit generated `build/`, `node_modules/`, runtime logs, evidence, package payloads, or secrets.
- Commit messages must describe the actual behavior delivered.
