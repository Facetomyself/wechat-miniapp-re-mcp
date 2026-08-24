import path from 'node:path';

export const wxResolverSource = `
function __gateResolveWxRuntime() {
  const root = globalThis;
  const candidates = [];
  const seen = [];
  function add(value, path) {
    try {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
      if (seen.includes(value)) return;
      seen.push(value);
      candidates.push({ value, path });
    } catch (_) {}
  }
  try { add(root.nav && root.nav.wxFrame, 'globalThis.nav.wxFrame'); } catch (_) {}
  add(root, 'globalThis');
  try { add(root.parent, 'globalThis.parent'); } catch (_) {}
  for (let index = 0; index < candidates.length && index < 24; index++) {
    const candidate = candidates[index];
    try {
      const frames = candidate.value.frames;
      const count = Math.min(Number(frames && frames.length) || 0, 12);
      for (let frameIndex = 0; frameIndex < count; frameIndex++) add(frames[frameIndex], candidate.path + '.frames[' + frameIndex + ']');
    } catch (_) {}
  }
  const matched = candidates.find((candidate) => {
    try { return candidate.value.wx && typeof candidate.value.wx.request === 'function'; } catch (_) { return false; }
  }) || candidates.find((candidate) => {
    try { return Boolean(candidate.value.wx); } catch (_) { return false; }
  });
  return { root, wxRoot: matched ? matched.value : root, wx: matched ? matched.value.wx : undefined, path: matched ? matched.path : '' };
}`;

export function parseOptions(args) {
  const output = {};
  const aliases = new Map([
    ['--wmpf-version', 'wmpfVersion'],
    ['--pid', 'pid'],
    ['--project', 'projectName'],
    ['--workspace-root', 'workspaceRoot'],
    ['--profile-path', 'profilePath'],
    ['--node', 'nodePath'],
    ['--server', 'serverPath'],
    ['--output', 'outputPath'],
    ['--connect-timeout-ms', 'connectTimeoutMs'],
    ['--runtime-wait-timeout-ms', 'runtimeWaitTimeoutMs'],
    ['--context-timeout-ms', 'contextTimeoutMs'],
    ['--reconnect-timeout-ms', 'reconnectTimeoutMs'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') output.help = true;
    else if (arg === '--dry-run') output.dryRun = true;
    else if (arg === '--skip-reconnect') output.skipReconnect = true;
    else if (aliases.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      output[aliases.get(arg)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return output;
}

export function optionalInteger(value, name, min) {
  if (value === undefined) return undefined;
  return integerOption(value, name, undefined, min, Number.MAX_SAFE_INTEGER);
}

export function integerOption(value, name, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function assertInside(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`--${label} must stay inside ${root}`);
  }
}

export function normalizeProjectName(value) {
  const normalized = String(value).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') throw new Error(`Invalid --project value: ${value}`);
  return normalized.slice(0, 100);
}

export function createSummarySanitizer({ workspaceRoot, repositoryRoot, reverseRoot, userProfile }) {
  function sanitize(value, depth = 0) {
    if (depth > 8) return '[depth-limit]';
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') {
      let output = value;
      const replacements = [
        [workspaceRoot, '<workspace>'],
        [repositoryRoot, '<repository>'],
        [reverseRoot, '<reverse-root>'],
        [userProfile, '<user-profile>'],
      ].filter(([from]) => typeof from === 'string' && from.length > 0);
      for (const [from, to] of replacements) output = output.split(from).join(to);
      return output.length > 4000 ? `${output.slice(0, 4000)}...[truncated:${output.length}]` : output;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitize(entry, depth + 1));
    if (typeof value === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(value).slice(0, 300)) {
        output[key] = /(authorization|cookie|token|secret|password|passwd|jwt|privatekey|key)$/i.test(key)
          ? '[redacted]'
          : sanitize(entry, depth + 1);
      }
      return output;
    }
    return String(value);
  }
  return sanitize;
}

export function summarizeTarget(target) {
  return {
    pid: target.pid,
    ppid: target.ppid,
    version: target.version,
    processType: target.processType,
    renderType: target.renderType,
    isMain: target.isMain,
  };
}

export function summarizeRequest(request) {
  if (!request) return null;
  return {
    requestId: request.requestId,
    contextId: request.contextId,
    url: request.url,
    method: request.method,
    resourceType: request.resourceType,
    responseStatus: request.response?.status,
  };
}

export function summarizeSessionStatus(status) {
  if (!status) return null;
  return {
    sessionId: status.sessionId,
    state: status.state,
    bridgeConnected: status.bridgeConnected,
    selectedContextId: status.selectedContextId,
    capabilities: status.capabilities,
    contextIds: Array.isArray(status.contexts) ? status.contexts.map((context) => context.id) : [],
  };
}

export function flattenInventory(inventory) {
  return (inventory ?? []).flatMap((domain) => (domain.items ?? []).map((item) => ({ host: domain.host, ...item })));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function parseResponse(name, response) {
  const block = response.content?.find((item) => item.type === 'text');
  if (!block || typeof block.text !== 'string') throw new Error(`${name} returned no text payload`);
  const payload = JSON.parse(block.text);
  if (response.isError || payload.ok === false) {
    const error = new Error(`${name}: ${payload.error?.code ?? 'TOOL_ERROR'}: ${payload.error?.message ?? 'unknown error'}`);
    error.payload = payload;
    throw error;
  }
  return payload.data;
}

export function usage() {
  return `Usage: node scripts/live-semantic-gate.mjs [options]

Options:
  --wmpf-version <number>            Require and select one WMPF version. Omit to use the current main target.
  --pid <number>                     Select an explicit main WMPF PID.
  --project <name>                   Evidence project name (default: live-verification).
  --workspace-root <path>            Workspace root (default: WXMP_WORKSPACE_ROOT or reverse_ENV/workspace).
  --profile-path <path>              Use an explicit reviewed profile.
  --connect-timeout-ms <number>      Initial wxmp_open / bridge wait (default: 60000).
  --runtime-wait-timeout-ms <number> Additional parked-session wait (default: 60000).
  --context-timeout-ms <number>      AppService discovery window (default: 60000).
  --reconnect-timeout-ms <number>    Same-session reconnect wait (default: 60000).
  --skip-reconnect                   Run a reduced gate; cannot establish full-semantic acceptance.
  --node <path>                      Node executable used to start the MCP server.
  --server <path>                    Compiled MCP entrypoint.
  --output <path>                    Summary path below <workspace>/<project>/wechat-miniapp.
  --dry-run                          Validate options and print the resolved execution plan.
  --help                             Show this help text.`;
}
