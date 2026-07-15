import { WxmpApp } from '../build/src/app.js';
import { buildTools } from '../build/src/tools/registry.js';

const app = new WxmpApp();
const tools = buildTools(app);
const names = tools.map((entry) => entry.tool.name);
const required = [
  'wxmp_health', 'wxmp_list_targets', 'wxmp_attach', 'wxmp_detach', 'wxmp_session_status', 'wxmp_wait_for_runtime',
  'wxmp_list_contexts', 'wxmp_evaluate', 'wxmp_raw_cdp', 'wxmp_list_scripts', 'wxmp_get_source',
  'wxmp_set_breakpoint', 'wxmp_pause_info', 'wxmp_trace_start', 'wxmp_capture_start',
  'wxmp_replay_request', 'wxmp_call_wx_api', 'wxmp_call_cloud_function', 'wxmp_scan_packages',
  'wxmp_decompile', 'wxmp_static_search', 'wxmp_profile_generate', 'wxmp_profile_validate', 'wxmp_profile_promote',
  'wxmp_export_evidence',
];

const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
const missing = required.filter((name) => !names.includes(name));
const invalid = names.filter((name) => !name.startsWith('wxmp_'));
if (duplicates.length || missing.length || invalid.length || tools.length < 35) {
  console.error(JSON.stringify({ duplicates, missing, invalid, count: tools.length }, null, 2));
  process.exit(1);
}
await app.shutdown();
console.log(JSON.stringify({ ok: true, count: tools.length }));
