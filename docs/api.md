# MCP Tool API

All tools use the `wxmp_*` prefix. Dynamic tools require `session_id`; tools that operate on a specific WMPF JavaScript context also accept `context_id`.

## Health and sessions

- `wxmp_health`
- `wxmp_list_targets`
- `wxmp_list_sessions`
- `wxmp_attach`
- `wxmp_detach`
- `wxmp_session_status`
- `wxmp_list_contexts`
- `wxmp_select_context`
- `wxmp_get_runtime_info`

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
- `wxmp_capture_start`
- `wxmp_capture_stop`
- `wxmp_list_requests`
- `wxmp_get_request`
- `wxmp_replay_request`
- `wxmp_call_wx_api`
- `wxmp_call_cloud_function`

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

## WMPF Profile workflow

- `wxmp_detect_wmpf`
- `wxmp_profile_probe`
- `wxmp_profile_generate`
- `wxmp_profile_validate`

Generated profiles have candidate confidence and are never injected automatically. `wxmp_attach` requires an explicit valid profile from the clean-room profile directory, an explicit path, or a configured external legacy directory.

## Evidence

- `wxmp_export_evidence`

The export contains `evidence-manifest.json`, `report.md`, `findings.json`, `triage.md`, and the session NDJSON event stream. Credential-shaped fields are redacted, and large source/capture data is returned through artifact paths.
