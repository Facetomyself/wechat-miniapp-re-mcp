# MCP Tool API

All tools use the `wxmp_*` prefix. Dynamic tools require `session_id`; tools that operate on a specific WMPF JavaScript context also accept `context_id`.

## Health and sessions

- `wxmp_health`
- `wxmp_list_targets`
- `wxmp_list_sessions`
- `wxmp_attach`
- `wxmp_detach`
- `wxmp_session_status`
- `wxmp_wait_for_runtime`
- `wxmp_list_contexts`
- `wxmp_select_context`
- `wxmp_probe_contexts`
- `wxmp_get_runtime_info`

`wxmp_probe_contexts` evaluates a small metadata probe in every observed context, records `role`, `contextType`, `envType`, `hasWx`, and probe confidence, then selects the strongest AppService/wx-capable context. Context capability lists are evidence-backed; a connected socket alone does not imply debugger, network, or trace support.

## Runtime and source debugging

- `wxmp_evaluate`
- `wxmp_raw_cdp`
- `wxmp_list_scripts`
- `wxmp_get_source`
- `wxmp_search_sources`
- `wxmp_set_breakpoint`
- `wxmp_remove_breakpoint`
- `wxmp_pause_info`
- `wxmp_pause`
- `wxmp_step_over`
- `wxmp_step_into`
- `wxmp_step_out`
- `wxmp_resume`

## Trace and network

- `wxmp_trace_start`
- `wxmp_trace_query`
- `wxmp_trace_stop`
- `wxmp_hook_wx_request`
- `wxmp_get_hooked_requests`
- `wxmp_unhook_wx_request`
- `wxmp_capture_start`
- `wxmp_capture_stop`
- `wxmp_list_requests`
- `wxmp_get_request`
- `wxmp_get_api_inventory`
- `wxmp_replay_request`
- `wxmp_call_wx_api`
- `wxmp_call_cloud_function`

Trace start requires at least one wrapped `wx.*` method; `wrapped=0` returns `TRACE_TARGET_UNAVAILABLE`. The request hook supports `wx.request`, `fetch`, and `XMLHttpRequest` and retains bounded body previews plus call stacks. Script and request indexes retain their WMPF `contextId`; source retrieval, breakpoint-by-script, response-body retrieval, and replay default to the originating context.

Breakpoint-by-URL results expose `boundLocations` and `pending`. An empty location list means the breakpoint is waiting for a matching future script, not that binding has already been verified.

## Human DevTools bridge

- `wxmp_devtools_proxy_start`
- `wxmp_devtools_proxy_stop`

## Static package workflow

- `wxmp_scan_packages`
- `wxmp_unpack`
- `wxmp_decompile`
- `wxmp_static_search`
- `wxmp_build_index`
- `wxmp_repack`
- `wxmp_raw_adapter`

`wxmp_raw_adapter` requires `project_name`; caller-supplied `-out` arguments are rejected and backend output is forced below the configured workspace.

## WMPF Profile workflow

- `wxmp_detect_wmpf`
- `wxmp_profile_probe`
- `wxmp_profile_generate`
- `wxmp_profile_validate`
- `wxmp_profile_promote`

Generated profiles include the target module SHA-256, have candidate confidence, and are rejected by `wxmp_attach` until `wxmp_profile_promote` records a reviewer, timestamp, evidence references, and a `medium`/`high` promotion decision. Explicit profiles must match the target WMPF version. Clean-room/generated profiles must bind to `moduleSha256` and carry a promoted review decision before injection; external legacy profiles remain compatibility inputs and are reported as hash-unbound findings.

The bundled `data/profiles/clean-room/windows-19977.json` profile is discovered automatically. `wxmp_profile_generate` accepts explicit signatures or loads a version-verified pair from the configured AOB signature database when `signatures` is omitted.

## Evidence

- `wxmp_export_evidence`

The export contains `evidence-manifest.json`, `report.md`, `findings.json`, `triage.md`, and the session NDJSON event stream. Credential-shaped fields are redacted, and large source/capture data is returned through artifact paths. Event reads and summaries stream the NDJSON file; event-count/byte overflow, oversized-event truncation, malformed lines, and write failures become explicit findings.
