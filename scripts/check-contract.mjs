import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WxmpApp } from '../build/src/app.js';
import { buildTools } from '../build/src/tools/registry.js';
import { VERSION } from '../build/src/version.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = await readJson('package.json');
const packageLock = await readJson('package-lock.json');
const readme = await readText('README.md');
const apiDocument = await readText('docs/api.md');
const sourceVersion = extractSourceVersion(await readText('src/version.ts'));
const app = new WxmpApp();
const failures = [];

try {
  const tools = buildTools(app);
  const names = tools.map((entry) => entry.tool.name);
  const sortedNames = [...names].sort();
  const required = [
    'wxmp_health', 'wxmp_list_targets', 'wxmp_attach', 'wxmp_detach', 'wxmp_session_status', 'wxmp_wait_for_runtime',
    'wxmp_list_contexts', 'wxmp_probe_contexts', 'wxmp_evaluate', 'wxmp_raw_cdp', 'wxmp_list_scripts', 'wxmp_get_source',
    'wxmp_set_breakpoint', 'wxmp_pause_info', 'wxmp_trace_start', 'wxmp_capture_start',
    'wxmp_hook_wx_request', 'wxmp_get_hooked_requests', 'wxmp_unhook_wx_request', 'wxmp_get_api_inventory',
    'wxmp_replay_request', 'wxmp_call_wx_api', 'wxmp_call_cloud_function', 'wxmp_scan_packages',
    'wxmp_decompile', 'wxmp_static_search', 'wxmp_profile_generate', 'wxmp_profile_validate', 'wxmp_profile_promote',
    'wxmp_export_evidence',
  ];

  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  const missing = required.filter((name) => !names.includes(name));
  const invalid = names.filter((name) => !name.startsWith('wxmp_'));
  if (duplicates.length) failures.push({ code: 'DUPLICATE_TOOLS', tools: duplicates });
  if (missing.length) failures.push({ code: 'MISSING_REQUIRED_TOOLS', tools: missing });
  if (invalid.length) failures.push({ code: 'INVALID_TOOL_PREFIX', tools: invalid });
  if (tools.length < 35) failures.push({ code: 'TOOL_COUNT_BELOW_MINIMUM', count: tools.length, minimum: 35 });

  const apiNames = [...apiDocument.matchAll(/^- `([a-z0-9_]+)`$/gm)].map((match) => match[1]).sort();
  const apiMissing = sortedNames.filter((name) => !apiNames.includes(name));
  const apiExtra = apiNames.filter((name) => !sortedNames.includes(name));
  if (apiMissing.length || apiExtra.length || apiNames.length !== sortedNames.length) {
    failures.push({ code: 'API_TOOL_DRIFT', missing: apiMissing, extra: apiExtra, apiCount: apiNames.length, toolCount: sortedNames.length });
  }

  const countMarkers = [
    { label: 'badge', pattern: /MCP_tools-(\d+)-/ },
    { label: 'Chinese heading', pattern: /## (\d+) 个 MCP Tools/ },
    { label: 'English inventory', pattern: /currently exposes `(\d+)` tools/ },
  ];
  for (const marker of countMarkers) {
    const match = readme.match(marker.pattern);
    if (!match) failures.push({ code: 'README_COUNT_MARKER_MISSING', marker: marker.label });
    else if (Number(match[1]) !== tools.length) failures.push({ code: 'README_TOOL_COUNT_DRIFT', marker: marker.label, expected: tools.length, actual: Number(match[1]) });
  }

  const lockVersion = packageLock.packages?.['']?.version ?? packageLock.version;
  const versions = {
    package: packageJson.version,
    lock: lockVersion,
    source: sourceVersion,
    build: VERSION,
  };
  if (new Set(Object.values(versions)).size !== 1) failures.push({ code: 'VERSION_DRIFT', versions });

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, count: tools.length, version: packageJson.version, failures }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, count: tools.length, apiCount: apiNames.length, version: packageJson.version }, null, 2));
  }
} finally {
  await app.shutdown();
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return fs.readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

function extractSourceVersion(source) {
  const match = source.match(/export const VERSION = ['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}
