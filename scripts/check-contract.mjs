import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WxmpApp } from '../build/src/app.js';
import { AGENT_TOOL_NAMES, buildAllTools, buildTools } from '../build/src/tools/registry.js';
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
  const tools = buildAllTools(app);
  const agentTools = buildTools(app, 'agent');
  const names = tools.map((entry) => entry.tool.name);
  const agentNames = agentTools.map((entry) => entry.tool.name);
  const sortedNames = [...names].sort();
  const required = [
    'wxmp_health', 'wxmp_doctor', 'wxmp_open', 'wxmp_status', 'wxmp_app_snapshot', 'wxmp_observe_window', 'wxmp_close',
    'wxmp_list_targets', 'wxmp_attach', 'wxmp_detach', 'wxmp_session_status', 'wxmp_wait_for_runtime',
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
  if (tools.length !== 59) failures.push({ code: 'EXPERT_TOOL_COUNT_DRIFT', count: tools.length, expected: 59 });
  if (agentTools.length !== 16) failures.push({ code: 'AGENT_TOOL_COUNT_DRIFT', count: agentTools.length, expected: 16 });
  const expectedAgentNames = [...AGENT_TOOL_NAMES].sort();
  const actualAgentNames = [...agentNames].sort();
  if (JSON.stringify(expectedAgentNames) !== JSON.stringify(actualAgentNames)) {
    failures.push({ code: 'AGENT_TOOLSET_DRIFT', expected: expectedAgentNames, actual: actualAgentNames });
  }
  for (const entry of tools) {
    const annotations = entry.tool.annotations ?? {};
    const missingAnnotations = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .filter((key) => typeof annotations[key] !== 'boolean');
    if (!entry.tool.title || !entry.tool.outputSchema || missingAnnotations.length) {
      failures.push({
        code: 'TOOL_METADATA_INCOMPLETE',
        tool: entry.tool.name,
        title: Boolean(entry.tool.title),
        outputSchema: Boolean(entry.tool.outputSchema),
        missingAnnotations,
      });
    }
  }

  const apiNames = [...apiDocument.matchAll(/^- `([a-z0-9_]+)`$/gm)].map((match) => match[1]).sort();
  const apiMissing = sortedNames.filter((name) => !apiNames.includes(name));
  const apiExtra = apiNames.filter((name) => !sortedNames.includes(name));
  if (apiMissing.length || apiExtra.length || apiNames.length !== sortedNames.length) {
    failures.push({ code: 'API_TOOL_DRIFT', missing: apiMissing, extra: apiExtra, apiCount: apiNames.length, toolCount: sortedNames.length });
  }

  const countMarkers = [
    { label: 'agent badge', pattern: /Agent_tools-(\d+)-/, expected: agentTools.length },
    { label: 'expert badge', pattern: /Expert_tools-(\d+)-/, expected: tools.length },
    { label: 'Chinese agent heading', pattern: /## 默认 (\d+) 个 Agent Tools/, expected: agentTools.length },
    { label: 'Chinese expert heading', pattern: /## 完整 (\d+) 个 Expert Tools/, expected: tools.length },
    { label: 'English agent inventory', pattern: /default surface exposes `(\d+)` agent tools/, expected: agentTools.length },
    { label: 'English expert inventory', pattern: /expert surface exposes `(\d+)` tools/, expected: tools.length },
  ];
  for (const marker of countMarkers) {
    const match = readme.match(marker.pattern);
    if (!match) failures.push({ code: 'README_COUNT_MARKER_MISSING', marker: marker.label });
    else if (Number(match[1]) !== marker.expected) failures.push({ code: 'README_TOOL_COUNT_DRIFT', marker: marker.label, expected: marker.expected, actual: Number(match[1]) });
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
    console.error(JSON.stringify({ ok: false, agentCount: agentTools.length, expertCount: tools.length, version: packageJson.version, failures }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, agentCount: agentTools.length, expertCount: tools.length, apiCount: apiNames.length, version: packageJson.version }, null, 2));
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
