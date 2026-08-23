# Runtime Contract

> Status: canonical source for the unattended-runtime refactor.
>
> Last updated: 2026-08-23
>
> Baseline: `0.5.2` / `refactor/runtime-kernel`. Public MCP tool schemas are 18
> agent / 70 expert tools after M5. M6 upgraded restored-source index schema to v2.

`docs/roadmap.md` remains the historical 0.4.x backlog. When this contract and
that file disagree about later work, this file wins.

## 1. Product bar

An agent completes one reverse session with:

```text
wxmp_doctor -> wxmp_open -> inspect tools -> wxmp_close
```

It must not set `WXMP_TOOLSET=expert`, must not invent `context_id` values, and
must not hand-author a Profile when the extractor + AOB path can attest one.

Irreducible human steps:

- PC WeChat is running.
- The target mini-program has been opened at least once, or the operator follows
  one explicit `userAction` (foreground / reload).

Everything else is a runtime defect: 3-5s attach timeouts, expert-only
`evaluate`, version lock on 19977/20079, and LLM-driven attach/wait/probe loops.

## 2. Session state machine

Existing `SessionState` values are the on-the-wire states. Do not rename them in
M0/M1.

| State | Meaning |
|---|---|
| `created` | Session record exists; Frida not attached |
| `attaching` | Bridge reserved, Frida inject in flight |
| `waiting_for_runtime` | Hooks loaded; 9421 has no owner socket yet (**parked**) |
| `connected` | WMPF socket accepted; CDP probes may still be partial |
| `disconnected` | Socket lost; Frida/session retained (**parked**) |
| `detaching` | Cleanup in progress |
| `closed` | Terminal success/cleanup |
| `failed` | Terminal or attach-failure; may pass through `detaching` |

Legal transitions (same-state is a no-op):

```text
created              -> attaching | failed | detaching | closed
attaching            -> waiting_for_runtime | connected | disconnected | failed | detaching
waiting_for_runtime  -> connected | disconnected | failed | detaching
connected            -> disconnected | failed | detaching
disconnected         -> connected | waiting_for_runtime | failed | detaching
detaching            -> closed | failed
failed               -> detaching | closed
closed               -> (none)
```

Parked states: `waiting_for_runtime`, `disconnected`.
Terminal states: `closed`, `failed`.
Waitable states: all except `closed`, `detaching`, `failed`.

`connected` proves transport only. `capabilities.cdp` / `debugger` / `network`
require successful domain probes. `wxTrace` / `requestHook` require non-zero
wrappers on a specific WMPF context.

## 3. Workflow phases

Orchestrator phases are not MCP states. Map them from session + capabilities:

| Phase | When |
|---|---|
| `discover` | No session yet |
| `profile` | Target known, Profile not injectable |
| `attach` | `created` / `attaching` |
| `wait_runtime` | parked, Frida alive |
| `probe` | `connected`, AppService not selected |
| `observe_bootstrap` | context selected, hook/snapshot in flight |
| `ready` | `connected` + CDP + selected context |
| `parked` | parked states |
| `failed` / `closed` | terminal |

`wxmp_open` owns the loop through `ready` or `parked`. A parked result keeps the
same `session_id`. Resume calls `wxmp_open({ session_id })` and must not
re-inject Frida.

Default attach wait inside the orchestrator is 60s (allowed range 30-90s). The
public `connect_timeout_ms` argument remains and is honored when supplied.

## 4. Extractor candidate schema

External offset extractors (default: `wmpf-offset-adaptation`) are subprocess
adapters, same isolation rule as Gwxapkg. MCP core does not embed IDA or copy
third-party `addresses.{version}.json`.

Candidate fields (v1):

```json
{
  "schemaVersion": 1,
  "platform": "windows",
  "wmpfVersion": 0,
  "moduleName": "flue.dll",
  "moduleSha256": "64-hex",
  "cdpFilterOffset": "0x...",
  "loadStartOffset": "0x...",
  "sceneOffsets": [0, 0, 0, 0, 0, 0],
  "extractor": { "name": "wmpf-offset-adaptation", "version": "string", "outputPath": "string" },
  "evidence": ["workspace-relative paths"],
  "confidence": "candidate"
}
```

Auto-promote to injectable `medium` only when all of the following hold:

1. Module SHA-256 bound and matched.
2. Both hook RVAs inside the module.
3. Unique AOB match per hook **or** extractor structure evidence for both hooks
   plus `SceneOffsets`.
4. Production Frida script emits `module`, `cdp_filter_attached`,
   `load_start_attached`, and `ready` without crash. The RPC snapshot must
   report non-empty `moduleName` plus `cdpFilterAttached` / `loadStartAttached`
   / `ready`.
5. Provenance is `extractor+runtime-smoke`. Historical offsets are never a
   fallback.

Missing extractor, ambiguous AOB, or failed smoke stays fail-closed with a
structured next action. Ordinary `wxmp_attach` still rejects candidates;
only `wxmp_open` may set `allowCandidateSmoke` for this attested path.

Environment:

- `WXMP_OFFSET_EXTRACTOR` — extractor script. `.js` / `.mjs` / `.cjs` run
  under Node; other extensions run under Python.
- `WXMP_OFFSET_EXTRACTOR_PYTHON` — Python interpreter for non-Node scripts.
- Defaults probe `REVERSE_ENV_ROOT` (`skill/wmpf-offset-adaptation/scripts/extract_wmpf_offsets.py`
  and `.venv/Scripts/python.exe`).

Promoted profiles are written to
`<workspace>/<project>/wechat-miniapp/profiles/windows-<version>-reviewed.json`
and reused on later `wxmp_open` / `wxmp_doctor` calls.

M4 delivered this adapter.

## 5. Agent surface (M3 delivered)

Current public surface is 18 agent / 70 expert tools. M5 added expert debugger
primitives; the default agent surface is unchanged:

- Session: `wxmp_doctor`, `wxmp_open`, `wxmp_status`, `wxmp_close`
- Runtime: `wxmp_evaluate`, `wxmp_app_snapshot`, `wxmp_observe_window`,
  `wxmp_search_sources`, `wxmp_list_scripts`
- Network: `wxmp_list_requests`, `wxmp_get_request`, `wxmp_get_api_inventory`,
  `wxmp_replay_request`
- Static: `wxmp_scan_packages`, `wxmp_decompile`, `wxmp_static_search`,
  `wxmp_correlate`
- Evidence: `wxmp_export_evidence`

`wxmp_wait_for_runtime` becomes an internal orchestrator step. Expert keeps raw
CDP, breakpoints, Profile internals, and adapter escape hatches.

M5 expert debugger primitives:

- `wxmp_get_paused_state` / `wxmp_get_scope_variables` / `wxmp_evaluate_on_call_frame`
- `wxmp_list_breakpoints` / `wxmp_break_on_xhr` / `wxmp_set_pause_on_exceptions`
- `wxmp_get_request_initiator` / `wxmp_list_websockets` /
  `wxmp_get_websocket_messages` / `wxmp_save_wasm`

Logical breakpoints survive reconnect as `stale`; CDP IDs are never reused as if
they were still valid. Scope dumps, WebSocket frames, and WASM bytecode are
paged or written as workspace artifacts.

M6 restored-source index:

- `wxmp_build_index` writes schema v2 plus a route/API summary artifact.
- Structure evidence comes from `app.json` / `game.json` / `plugin.json`
  (pages, subPackages, tabBar, usingComponents, workers, plugins, permissions).
- Heuristic URL/API/route/storage/cloud hits keep `file:line` and
  `confidence=heuristic`.
- `wxmp_correlate` joins runtime AppID, request URL, initiator, script, and
  route to that index. Unmatched items stay `confidence=none` with a reason.
- Gwxapkg remains a subprocess adapter. MCP core does not embed an unpacker.

M7 live runner:

- `scripts/live-semantic-gate.mjs` targets the current main WMPF process when
  `--wmpf-version` is omitted.
- Default attach/open wait is 60s. The runner calls `wxmp_doctor` then
  `wxmp_open`; missing Profiles use extractor smoke-promote instead of
  historical RVAs.
- A parked session or bridge timeout is `runtimeBridge` failed, not attach
  success. Failure evidence is still exported.
- 2026-08-23 WMPF 20079 live run (`live-verification-m7`): health/profile/AOB/
  Frida hookAttach/detach/evidenceExport passed; `runtimeBridge` failed after
  60s because `127.0.0.1:9421` never accepted a WMPF owner. Full-semantic
  remains runtime-pending until the target mini-program is foregrounded or
  reloaded once.

## 6. Architecture seams

M0 injects seams without moving files. M1 relocates modules behind them.

| Seam | Default | Test use |
|---|---|---|
| `now()` | `() => new Date()` | Deterministic timestamps |
| `discoverTargets()` | Windows CIM query | Empty/fixed process lists |
| `resolveTarget()` | first main WMPF process | Forced PID |
| `frida` | lazy `FridaRuntimeAdapter` | Fake attach/RPC |
| `createBridge()` | `WmpfBridgeServer` | Fake 9421 owner |

Frida hook RPC (M2): `status()` and `forceDebugTrigger()`. The latter starts as
an observation stub; NativeFunction calls are opt-in and must not crash WeChat.

## 7. Non-goals

- Copying GPL WMPFDebugger source or version address tables
- Streamable HTTP / SSE / GUI as the product entry
- Concurrent owners on handshake-free `127.0.0.1:9421`
- Heuristic pentest tools (`find_idor_*`, Vuex patchers)
- MCP SDK v2 and macOS runtime claims
- Public tool schema changes in M0/M1

## 8. Batch lock

| Batch | Allowed | Forbidden |
|---|---|---|
| M0 | contract, seams, state-machine tests | tool rename, hook semantics |
| M1 | file moves behind seams | public schema, live-only code |
| M2 | orchestrator wait/parked + Frida RPC | auto-promote, new agent tools |
| M3 | agent surface 2.0, version bump | extractor auto-promote, debugger dump |
| M4 | extractor adapter + attested promote (delivered) | GPL profiles, historical RVA fallback |
| M5 | debugger primitives (delivered) | static index rewrite |
| M6 | Gwxapkg report index + correlate (delivered) | embedding unpackers |
| M7 | live gate on current WMPF + gitlink (runner delivered; full-semantic runtime-pending) | SDK v2, macOS support claim |
