import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appserviceContextPassed,
  assertInside,
  cdpDomainsPassed,
  createSummarySanitizer,
  flattenInventory,
  integerOption,
  lifecycleSample,
  loadStartLifecyclePassed,
  normalizeProjectName,
  optionalInteger,
  parseOptions,
  parseResponse,
  runtimeBridgePassed,
  sleep,
  summarizeRequest,
  summarizeSessionStatus,
  summarizeTarget,
  usage,
  withTimeout,
  wxResolverSource,
} from './lib/live-gate-support.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const gateContract = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'data', 'acceptance', 'gates-v1.json'), 'utf8'));
const serverVersion = String(packageJson.version);
const reverseRoot = path.resolve(process.env.REVERSE_ENV_ROOT ?? path.join(repositoryRoot, '..', '..'));
const workspaceRoot = path.resolve(options.workspaceRoot ?? process.env.WXMP_WORKSPACE_ROOT ?? path.join(reverseRoot, 'workspace'));
const projectName = normalizeProjectName(options.projectName ?? 'live-verification');
const expectedWmpfVersion = optionalInteger(options.wmpfVersion, 'wmpf-version', 1);
const expectedPid = optionalInteger(options.pid, 'pid', 1);
const connectTimeoutMs = integerOption(options.connectTimeoutMs, 'connect-timeout-ms', 60_000, 1, 120_000);
const attachSampleTimeoutMs = integerOption(options.attachSampleTimeoutMs, 'attach-sample-timeout-ms', 8_000, 1, 120_000);
const runtimeWaitTimeoutMs = integerOption(options.runtimeWaitTimeoutMs, 'runtime-wait-timeout-ms', 60_000, 1, 120_000);
const contextTimeoutMs = integerOption(options.contextTimeoutMs, 'context-timeout-ms', 60_000, 1, 120_000);
const reconnectTimeoutMs = integerOption(options.reconnectTimeoutMs, 'reconnect-timeout-ms', 60_000, 1, 180_000);
const nodePath = path.resolve(options.nodePath ?? process.execPath);
const serverPath = path.resolve(options.serverPath ?? path.join(repositoryRoot, 'build', 'src', 'index.js'));
const profilePath = options.profilePath ? path.resolve(options.profilePath) : undefined;
const requiredToolset = 'expert';
const gateId = `v${serverVersion.replace(/[^0-9A-Za-z.-]/g, '-')}-wmpf${expectedWmpfVersion ?? 'auto'}-${Date.now()}`;
const requiredGates = gateContract.liveRunnerRequired.filter((gateName) => !options.skipReconnect || gateName !== 'reconnect');
const outputRoot = path.resolve(workspaceRoot, projectName, 'wechat-miniapp');
const outputPath = path.resolve(options.outputPath ?? path.join(outputRoot, `live-semantic-gate-${gateId}.json`));
assertInside(outputRoot, outputPath, 'output');
const sanitizeForSummary = createSummarySanitizer({
  workspaceRoot,
  repositoryRoot,
  reverseRoot,
  userProfile: process.env.USERPROFILE,
});

if (options.dryRun) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dryRun: true,
    serverVersion,
    toolset: requiredToolset,
    expectedWmpfVersion: expectedWmpfVersion ?? null,
    expectedPid: expectedPid ?? null,
    projectName,
    workspaceRoot,
    nodePath,
    serverPath,
    profilePath: profilePath ?? null,
    outputPath,
    connectTimeoutMs,
    attachSampleTimeoutMs,
    runtimeWaitTimeoutMs,
    contextTimeoutMs,
    reconnectTimeoutMs,
    requiredGates,
  }, null, 2)}\n`);
  process.exit(0);
}

const summary = {
  schemaVersion: 1,
  gateId,
  startedAt: new Date().toISOString(),
  serverVersion,
  toolset: requiredToolset,
  expectedWmpfVersion: expectedWmpfVersion ?? null,
  expectedPid: expectedPid ?? null,
  requiredGates,
  gates: {},
  runtime: {},
  httpRequests: [],
  errors: [],
};

let client;
let transport;
let server;
let sessionId = '';
let appContextId = '';
let fetchContextId = '';
let detached = false;
let exported = null;
let evidenceProcessed = false;

function record(name, pass, details = {}, status = pass ? 'passed' : 'failed') {
  const safeDetails = sanitizeForSummary(details);
  summary.gates[name] = { status, passed: pass, details: safeDetails, observedAt: new Date().toISOString() };
  process.stdout.write(`[gate] ${name}: ${status.toUpperCase()} ${JSON.stringify(safeDetails)}\n`);
}

async function call(name, args = {}, timeoutMs = 90_000) {
  const response = await withTimeout(
    client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
    timeoutMs + 5_000,
    name,
  );
  return parseResponse(name, response);
}

async function readLifecycleSample(reason) {
  const statusResult = sessionId
    ? await attempt('wxmp_session_status', { session_id: sessionId }, 10_000)
    : { ok: false, details: { message: 'session not started' } };
  return {
    ...lifecycleSample(statusResult.ok ? statusResult.data : null),
    reason,
    observedAt: new Date().toISOString(),
    statusOk: statusResult.ok === true,
  };
}

async function attempt(name, args = {}, timeoutMs = 90_000) {
  try {
    return { ok: true, data: await call(name, args, timeoutMs) };
  } catch (error) {
    const details = sanitizeForSummary(error.payload ?? { message: error.message });
    summary.errors.push({ operation: name, details });
    process.stdout.write(`[gate] ${name}: ERROR ${JSON.stringify(details)}\n`);
    return { ok: false, error, details };
  }
}

function toolErrorCode(result) {
  return result?.details?.error?.code
    || result?.error?.payload?.error?.code
    || '';
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function startFixtureServer() {
  const requests = summary.httpRequests;
  server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: request.method,
      url: request.url,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 1000),
      observedAt: new Date().toISOString(),
    });
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-wxmp-gate': gateId,
    });
    response.end(JSON.stringify({ ok: true, gateId, path: request.url, method: request.method, body }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return address.port;
}

async function closeFixtureServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

async function probeRuntimeContext(contextId) {
  const expression = `(() => {
    ${wxResolverSource}
    const runtime = __gateResolveWxRuntime();
    let route = '';
    try {
      const pages = typeof runtime.wxRoot?.getCurrentPages === 'function' ? runtime.wxRoot.getCurrentPages() : [];
      route = pages && pages.length ? String(pages[pages.length - 1].route || '') : '';
    } catch (_) {}
    return {
      hasWx: Boolean(runtime.wx),
      hasWxRequest: typeof runtime.wx?.request === 'function',
      hasFetch: typeof globalThis.fetch === 'function',
      hasXHR: typeof globalThis.XMLHttpRequest === 'function',
      hasRestartMiniProgram: typeof runtime.wx?.restartMiniProgram === 'function',
      hasReLaunch: typeof runtime.wx?.reLaunch === 'function',
      wxRuntimePath: runtime.path,
      route,
      href: globalThis.location?.href || ''
    };
  })()`;
  const result = await attempt('wxmp_evaluate', {
    session_id: sessionId,
    context_id: contextId,
    expression,
    await_promise: true,
    return_by_value: true,
  });
  return result.ok ? result.data.value : null;
}

async function stopRuntimeWrappers(contextId) {
  if (!contextId) return;
  await attempt('wxmp_unhook_wx_request', { session_id: sessionId, context_id: contextId }, 15_000);
  await attempt('wxmp_trace_stop', { session_id: sessionId, context_id: contextId }, 15_000);
  await attempt('wxmp_capture_stop', { session_id: sessionId, context_id: contextId }, 15_000);
}

async function exportEvidence() {
  if (!sessionId || !client || exported) return exported;
  const result = await attempt('wxmp_export_evidence', { session_id: sessionId }, 30_000);
  if (result.ok) exported = result.data;
  return exported;
}

async function detachSession() {
  if (!sessionId || detached || !client) return;
  const result = await attempt('wxmp_detach', { session_id: sessionId }, 30_000);
  detached = result.ok;
  record('detach', result.ok && result.data.state === 'closed', result.ok ? result.data : result.details);
}

async function finalizeEvidence() {
  if (evidenceProcessed) return;
  evidenceProcessed = true;
  await exportEvidence();
  if (!exported?.eventsPath) {
    if (!options.skipReconnect && !summary.gates.reconnect) {
      record('reconnect', false, summary.runtime.reconnect ?? { reason: 'Gate ended before reconnect verification' }, 'not-run');
    }
    record('evidenceExport', false, { reason: 'Evidence export did not return eventsPath' });
    return;
  }

  const text = await fs.readFile(exported.eventsPath, 'utf8');
  const events = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const counts = events.reduce((output, event) => {
    output[event.type] = (output[event.type] ?? 0) + 1;
    return output;
  }, {});
  const evidencePaths = Object.fromEntries(Object.entries(exported).map(([key, value]) => [
    key,
    typeof value === 'string' ? path.relative(workspaceRoot, value).replaceAll(path.sep, '/') : value,
  ]));
  summary.evidence = { paths: evidencePaths, counts };
  if (!options.skipReconnect && !summary.gates.reconnect) {
    const reconnectPass = (counts['runtime.disconnected'] ?? 0) >= 1
      && (counts['runtime.connected'] ?? 0) >= 2
      && summary.runtime.reconnect?.afterStatus?.bridgeConnected === true;
    record('reconnect', reconnectPass, summary.runtime.reconnect ?? { reason: 'Gate ended before reconnect verification' }, reconnectPass ? 'passed' : 'not-run');
  }
  const requiredFiles = ['manifestPath', 'findingsPath', 'reportPath', 'triagePath', 'eventsPath'];
  const fileChecks = Object.fromEntries(await Promise.all(requiredFiles.map(async (key) => [
    key,
    Boolean(exported[key]) && (await fs.stat(exported[key]).catch(() => null))?.isFile() === true,
  ])));
  record('evidenceExport', Object.values(fileChecks).every(Boolean) && (counts['session.detached'] ?? 0) >= 1, {
    paths: evidencePaths,
    fileChecks,
    counts,
  });
}

const fixturePort = await startFixtureServer();
summary.fixturePort = fixturePort;
transport = new StdioClientTransport({
  command: nodePath,
  args: [serverPath],
  cwd: repositoryRoot,
  env: {
    ...process.env,
    WXMP_TOOLSET: requiredToolset,
    REVERSE_ENV_ROOT: reverseRoot,
    WXMP_WORKSPACE_ROOT: workspaceRoot,
    WXMP_GWXAPKG: process.env.WXMP_GWXAPKG ?? path.join(reverseRoot, 'tools', 'Gwxapkg-runtime', 'gwxapkg.exe'),
    WXMP_DEBUG_HOST: process.env.WXMP_DEBUG_HOST ?? '127.0.0.1',
    WXMP_DEBUG_PORT: process.env.WXMP_DEBUG_PORT ?? '9421',
  },
  stderr: 'pipe',
});
client = new Client({ name: 'wxmp-live-semantic-gate', version: serverVersion }, { capabilities: {} });

try {
  await withTimeout(client.connect(transport), 15_000, 'MCP connect');
  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => process.stderr.write(`[wxmp-server] ${chunk.toString()}`));
  }

  const listed = await call('wxmp_health');
  const tools = await client.listTools();
  record('health', listed.version === serverVersion && tools.tools.length >= 70, {
    version: listed.version,
    tools: tools.tools.length,
    bridge: listed.bridge,
  });

  const targets = await call('wxmp_list_targets');
  const mainTargets = targets.filter((target) => target.isMain);
  const main = expectedPid !== undefined
    ? mainTargets.find((target) => target.pid === expectedPid)
    : expectedWmpfVersion !== undefined
      ? mainTargets.find((target) => target.version === expectedWmpfVersion)
      : mainTargets[0];
  if (!main) throw new Error('No WMPF main process discovered');
  if (expectedWmpfVersion !== undefined && main.version !== expectedWmpfVersion) {
    throw new Error(`Selected WMPF target version ${main.version} does not match expected ${expectedWmpfVersion}`);
  }
  summary.runtime.target = summarizeTarget(main);

  const doctor = await attempt('wxmp_doctor', {}, 30_000);
  summary.runtime.doctor = doctor.ok ? {
    state: doctor.data.state,
    extractor: doctor.data.extractor,
    needsUserAction: doctor.data.needsUserAction,
    userAction: doctor.data.userAction,
    targetCount: doctor.data.targetCount,
  } : doctor.details;

  const profileProbe = await attempt('wxmp_profile_probe', {
    pid: main.pid,
    ...(profilePath ? { profile_path: profilePath } : {}),
  }, 30_000);
  const probedProfile = profileProbe.ok ? profileProbe.data : null;
  record('profileSchema', Boolean(probedProfile?.valid && probedProfile.checks?.every((check) => check.inBounds === true)), probedProfile ? {
    moduleName: path.basename(probedProfile.modulePath),
    checks: probedProfile.checks,
    profile: {
      platform: probedProfile.profile?.platform,
      wmpfVersion: probedProfile.profile?.wmpfVersion,
      moduleName: probedProfile.profile?.moduleName,
      provenance: probedProfile.profile?.provenance,
    },
  } : profileProbe.details);
  record('moduleHash', probedProfile?.hashMatches === true, probedProfile ? {
    sha256: probedProfile.sha256,
    expectedSha256: probedProfile.expectedSha256,
    hashMatches: probedProfile.hashMatches,
  } : profileProbe.details);

  const generateArgs = {
    pid: main.pid,
    project_name: projectName,
    ...(Array.isArray(probedProfile?.profile?.sceneOffsets) && probedProfile.profile.sceneOffsets.length
      ? { scene_offsets: probedProfile.profile.sceneOffsets }
      : {}),
  };
  const generatedProfile = await attempt('wxmp_profile_generate', generateArgs, 45_000);
  const generated = generatedProfile.ok ? generatedProfile.data.profile : null;
  const extractorStructured = Boolean(
    generated?.cdpFilterOffset
    && generated?.loadStartOffset
    && Array.isArray(generated?.sceneOffsets)
    && generated.sceneOffsets.length >= 6
    && (generated.extractor || generated.provenance?.source === 'generated'),
  );
  const aobMatched = Boolean(
    generated
    && probedProfile?.sha256
    && generated.moduleSha256 === probedProfile.sha256
    && generated.cdpFilterOffset === probedProfile.profile?.cdpFilterOffset
    && generated.loadStartOffset === probedProfile.profile?.loadStartOffset,
  );
  record('aobUnique', aobMatched || extractorStructured, generatedProfile.ok ? {
    moduleSha256: generated.moduleSha256,
    cdpFilterOffset: generated.cdpFilterOffset,
    loadStartOffset: generated.loadStartOffset,
    candidatePath: generatedProfile.data.outputPath,
    extractor: generatedProfile.data.extractor ?? generated.extractor ?? null,
    aobMatched,
    extractorStructured,
  } : generatedProfile.details);

  process.stdout.write('[gate] inject: attaching Frida. Leave the mini-program alone until the lifecycle BEFORE line.\n');
  const opened = await call('wxmp_open', {
    pid: main.pid,
    project_name: projectName,
    connect_timeout_ms: attachSampleTimeoutMs,
    correlate_packages: false,
    ...(profilePath ? { profile_path: profilePath } : {}),
  }, attachSampleTimeoutMs + 45_000);
  sessionId = opened.sessionId;
  summary.runtime.sessionId = sessionId;
  let attached = opened.status ?? opened;
  if (attached.profile?.path && probedProfile?.hashMatches !== true) {
    const promotedProbe = await attempt('wxmp_profile_probe', {
      pid: main.pid,
      profile_path: attached.profile.path,
    }, 30_000);
    if (promotedProbe.ok) {
      record('profileSchema', promotedProbe.data.valid === true && promotedProbe.data.checks?.every((check) => check.inBounds === true), {
        moduleName: path.basename(promotedProbe.data.modulePath),
        checks: promotedProbe.data.checks,
        profile: {
          platform: promotedProbe.data.profile?.platform,
          wmpfVersion: promotedProbe.data.profile?.wmpfVersion,
          moduleName: promotedProbe.data.profile?.moduleName,
          provenance: promotedProbe.data.profile?.provenance,
        },
        source: 'post-open',
      });
      record('moduleHash', promotedProbe.data.hashMatches === true, {
        sha256: promotedProbe.data.sha256,
        expectedSha256: promotedProbe.data.expectedSha256,
        hashMatches: promotedProbe.data.hashMatches,
        source: 'post-open',
      });
    }
  }
  record('attach', attached.state !== 'failed', {
    state: attached.state,
    bridgeConnected: attached.bridgeConnected,
    capabilities: attached.capabilities,
    profile: attached.profile,
  });
  record('hookAttach', attached.capabilities?.frida === true, {
    state: attached.state,
    frida: attached.capabilities?.frida,
    profileVersion: attached.profile?.version,
  });

  const lifecycleBefore = await readLifecycleSample('before-reload');
  summary.runtime.lifecycle = { before: lifecycleBefore };
  process.stdout.write(`[gate] lifecycle: BEFORE ${JSON.stringify({
    loadStartEntered: lifecycleBefore.loadStartEntered,
    loadStartAttached: lifecycleBefore.loadStartAttached,
    contextCount: lifecycleBefore.contextCount,
    bridgeConnected: lifecycleBefore.bridgeConnected,
  })}\n`);
  process.stdout.write('[gate] lifecycle: close the mini-program, reopen it, and keep it in the foreground. Wait for the AFTER line.\n');

  const lifecycleDeadline = Date.now() + runtimeWaitTimeoutMs;
  let lifecycleAfter = lifecycleBefore;
  while (Date.now() < lifecycleDeadline) {
    if (!lifecycleAfter.bridgeConnected) {
      const waitMs = Math.min(runtimeWaitTimeoutMs, remainingMs(lifecycleDeadline));
      if (waitMs >= 1) {
        const waited = await attempt('wxmp_wait_for_runtime', { session_id: sessionId, timeout_ms: waitMs }, waitMs + 10_000);
        if (waited.ok) attached = waited.data;
      }
    }
    lifecycleAfter = await readLifecycleSample('after-reload');
    const loadStartDelta = lifecycleAfter.loadStartEntered - lifecycleBefore.loadStartEntered;
    summary.runtime.lifecycle.after = lifecycleAfter;
    summary.runtime.lifecycle.loadStartDelta = loadStartDelta;
    process.stdout.write(`[gate] lifecycle: POLL ${JSON.stringify({
      loadStartEntered: lifecycleAfter.loadStartEntered,
      loadStartDelta,
      contextCount: lifecycleAfter.contextCount,
      bridgeConnected: lifecycleAfter.bridgeConnected,
      remainingMs: remainingMs(lifecycleDeadline),
    })}\n`);
    if (loadStartDelta > 0 && lifecycleAfter.bridgeConnected) break;
    if (Date.now() >= lifecycleDeadline) break;
    await sleep(Math.min(1500, remainingMs(lifecycleDeadline)));
  }
  const loadStartDelta = lifecycleAfter.loadStartEntered - lifecycleBefore.loadStartEntered;
  summary.runtime.lifecycle.after = lifecycleAfter;
  summary.runtime.lifecycle.loadStartDelta = loadStartDelta;
  attached = {
    ...attached,
    bridgeConnected: lifecycleAfter.bridgeConnected,
    capabilities: {
      ...(attached.capabilities ?? {}),
      cdp: lifecycleAfter.cdp,
      debugger: lifecycleAfter.debugger,
      network: lifecycleAfter.network,
    },
  };
  process.stdout.write(`[gate] lifecycle: AFTER ${JSON.stringify({
    loadStartEntered: lifecycleAfter.loadStartEntered,
    loadStartDelta,
    contextCount: lifecycleAfter.contextCount,
    executionContextCount: lifecycleAfter.executionContextCount,
    bridgeConnected: lifecycleAfter.bridgeConnected,
    debugger: lifecycleAfter.debugger,
    network: lifecycleAfter.network,
  })}\n`);
  record('runtimeBridge', runtimeBridgePassed(lifecycleAfter), {
    bridgeConnected: lifecycleAfter.bridgeConnected,
    cdp: lifecycleAfter.cdp,
    debugger: lifecycleAfter.debugger,
    network: lifecycleAfter.network,
  });
  record('cdpDomains', cdpDomainsPassed(lifecycleAfter), {
    debugger: lifecycleAfter.debugger,
    network: lifecycleAfter.network,
  });
  record('loadStartLifecycle', loadStartLifecyclePassed(lifecycleBefore, lifecycleAfter), {
    before: lifecycleBefore.loadStartEntered,
    after: lifecycleAfter.loadStartEntered,
    delta: loadStartDelta,
    loadStartAttached: lifecycleAfter.loadStartAttached,
    forceDebugTriggerCalls: lifecycleAfter.forceDebugTriggerCalls,
  });
  if (!runtimeBridgePassed(lifecycleAfter)) throw new Error(`WMPF runtime did not connect to the ${serverVersion} bridge`);

  let probed = null;
  let runtimeProbes = [];
  let appCandidate;
  let fetchCandidate;
  const contextAttempts = [];
  const contextDeadline = Date.now() + contextTimeoutMs;
  while (Date.now() < contextDeadline) {
    const leftoverMs = remainingMs(contextDeadline);
    const status = await attempt('wxmp_session_status', { session_id: sessionId }, 5_000);
    const connected = status.ok && status.data.bridgeConnected === true;
    if (!connected) {
      contextAttempts.push({
        observedAt: new Date().toISOString(),
        reason: 'runtime-not-connected',
        details: status.ok ? summarizeSessionStatus(status.data) : status.details,
        remainingMs: leftoverMs,
      });
      process.stdout.write(`[gate] appserviceContext: WAITING ${JSON.stringify({ reason: 'runtime-not-connected', remainingMs: leftoverMs })}\n`);
      const waitMs = Math.min(runtimeWaitTimeoutMs, leftoverMs);
      if (waitMs < 1) break;
      const waited = await attempt('wxmp_wait_for_runtime', { session_id: sessionId, timeout_ms: waitMs }, waitMs + 10_000);
      if (waited.ok) attached = waited.data;
      continue;
    }

    const probeResult = await attempt('wxmp_probe_contexts', { session_id: sessionId }, 45_000);
    if (!probeResult.ok) {
      const code = toolErrorCode(probeResult);
      contextAttempts.push({
        observedAt: new Date().toISOString(),
        reason: 'probe-failed',
        code,
        details: probeResult.details,
        remainingMs: leftoverMs,
      });
      if (code === 'RUNTIME_NOT_CONNECTED' || code === 'SESSION_DISCONNECTED') {
        const waitMs = Math.min(runtimeWaitTimeoutMs, remainingMs(contextDeadline));
        if (waitMs >= 1) {
          const waited = await attempt('wxmp_wait_for_runtime', { session_id: sessionId, timeout_ms: waitMs }, waitMs + 10_000);
          if (waited.ok) attached = waited.data;
          continue;
        }
      }
      if (Date.now() >= contextDeadline) break;
      await sleep(Math.min(1500, remainingMs(contextDeadline)));
      continue;
    }

    probed = probeResult.data;
    runtimeProbes = [];
    for (const context of probed.contexts ?? []) {
      runtimeProbes.push({
        context,
        runtime: context.active === false ? null : await probeRuntimeContext(context.id),
      });
    }
    const liveProbes = runtimeProbes.filter((entry) => entry.context.active !== false);
    appCandidate = liveProbes.find((entry) => entry.context.hasWx && entry.context.role === 'appservice')
      ?? liveProbes.find((entry) => entry.runtime?.hasWxRequest)
      ?? liveProbes.find((entry) => entry.context.hasWx);
    fetchCandidate = liveProbes.find((entry) => entry.runtime?.hasFetch);
    contextAttempts.push({
      observedAt: new Date().toISOString(),
      selectedContextId: probed.selectedContextId,
      liveContextCount: liveProbes.length,
      contexts: runtimeProbes.map((entry) => ({
        id: entry.context.id,
        role: entry.context.role,
        active: entry.context.active,
        hasWx: entry.context.hasWx,
        hasWxRequest: entry.runtime?.hasWxRequest,
        wxRuntimePath: entry.runtime?.wxRuntimePath,
      })),
      remainingMs: remainingMs(contextDeadline),
    });
    if (appCandidate) break;
    process.stdout.write(`[gate] appserviceContext: WAITING ${JSON.stringify({
      reason: liveProbes.length ? 'no-appservice-yet' : 'empty-contexts',
      liveContextCount: liveProbes.length,
      remainingMs: remainingMs(contextDeadline),
    })}\n`);
    if (Date.now() >= contextDeadline) break;
    await sleep(Math.min(1500, remainingMs(contextDeadline)));
  }
  summary.runtime.contexts = runtimeProbes.map((entry) => ({
    context: {
      id: entry.context.id,
      kind: entry.context.kind,
      role: entry.context.role,
      probeConfidence: entry.context.probeConfidence,
      hasWx: entry.context.hasWx,
      hasWxRequest: entry.context.hasWxRequest,
      wxRuntimePath: entry.context.wxRuntimePath,
      capabilities: entry.context.capabilities,
      active: entry.context.active,
    },
    runtime: {
      hasWx: entry.runtime?.hasWx,
      hasWxRequest: entry.runtime?.hasWxRequest,
      hasFetch: entry.runtime?.hasFetch,
      hasXHR: entry.runtime?.hasXHR,
      hasRestartMiniProgram: entry.runtime?.hasRestartMiniProgram,
      hasReLaunch: entry.runtime?.hasReLaunch,
      wxRuntimePath: entry.runtime?.wxRuntimePath,
    },
  }));
  summary.runtime.contextAttempts = contextAttempts;
  appContextId = appCandidate?.context.id ?? '';
  fetchContextId = fetchCandidate?.context.id ?? '';
  record('appserviceContext', appserviceContextPassed(appContextId), {
    selectedContextId: probed?.selectedContextId ?? '',
    appContextId,
    fetchContextId,
    attemptCount: contextAttempts.length,
    contextCountBefore: summary.runtime.lifecycle?.before?.contextCount ?? null,
    contextCountAfter: summary.runtime.lifecycle?.after?.contextCount ?? null,
    loadStartDelta: summary.runtime.lifecycle?.loadStartDelta ?? null,
    contexts: runtimeProbes.map((entry) => ({
      id: entry.context.id,
      role: entry.context.role,
      active: entry.context.active,
      hasWx: entry.context.hasWx,
      hasFetch: entry.runtime?.hasFetch,
      hasXHR: entry.runtime?.hasXHR,
      wxRuntimePath: entry.runtime?.wxRuntimePath,
    })),
  });
  if (!appserviceContextPassed(appContextId)) throw new Error(`No wx/AppService context was found after ${contextAttempts.length} probe attempts`);
  await call('wxmp_select_context', { session_id: sessionId, context_id: appContextId });

  const evaluation = await call('wxmp_evaluate', {
    session_id: sessionId,
    context_id: appContextId,
    expression: `(() => { ${wxResolverSource}; const runtime = __gateResolveWxRuntime(); return { gate: ${JSON.stringify(gateId)}, value: 6 * 7, hasWx: Boolean(runtime.wx), wxRuntimePath: runtime.path }; })()`,
    await_promise: true,
    return_by_value: true,
  });
  record('evaluate', evaluation.value?.gate === gateId && evaluation.value?.value === 42 && evaluation.value?.hasWx === true, evaluation.value);

  const sourceUrl = `wxmp://live-gate-${gateId}.js`;
  const fixtureSource = [
    'globalThis.__wxmpLiveBreakpoint = function __wxmpLiveBreakpoint() {',
    '  const marker = 41;',
    '  return marker + 1;',
    '};',
    "'installed';",
    `//# sourceURL=${sourceUrl}`,
  ].join('\n');
  await call('wxmp_evaluate', {
    session_id: sessionId,
    context_id: appContextId,
    expression: fixtureSource,
    await_promise: true,
    return_by_value: true,
  });
  await sleep(300);
  const scripts = await call('wxmp_list_scripts', {
    session_id: sessionId,
    context_id: appContextId,
    url_filter: `live-gate-${gateId}.js`,
    offset: 0,
    limit: 20,
  });
  const fixtureScript = scripts.items.at(-1);
  let breakpointPass = false;
  let breakpointDetails = { scripts: scripts.total };
  if (fixtureScript) {
    const source = await call('wxmp_get_source', {
      session_id: sessionId,
      script_id: fixtureScript.scriptId,
      inline_limit: 100_000,
    });
    const breakpoint = await call('wxmp_set_breakpoint', {
      session_id: sessionId,
      script_id: fixtureScript.scriptId,
      line_number: 1,
      column_number: 0,
    });
    const result = breakpoint.response?.result ?? {};
    const locations = Array.isArray(result.locations) ? result.locations : [];
    const actualLocation = result.actualLocation ?? null;
    breakpointPass = Boolean(actualLocation) || locations.length > 0 || breakpoint.boundLocations > 0;
    breakpointDetails = {
      scriptId: fixtureScript.scriptId,
      url: fixtureScript.url,
      sourceMatches: source.source?.includes('marker = 41') === true,
      boundLocations: breakpoint.boundLocations,
      actualLocation,
      locations,
      breakpointId: result.breakpointId,
    };
    if (result.breakpointId) {
      await attempt('wxmp_remove_breakpoint', {
        session_id: sessionId,
        context_id: appContextId,
        breakpoint_id: result.breakpointId,
      });
    }
  }
  record('breakpoint', breakpointPass, breakpointDetails);

  const traceStart = await attempt('wxmp_trace_start', {
    session_id: sessionId,
    context_id: appContextId,
    categories: ['all'],
  }, 30_000);
  const traceInstalled = traceStart.ok && (traceStart.data.value?.wrapped > 0 || traceStart.data.value?.reused === true);
  record('traceInstall', traceInstalled, traceStart.ok ? traceStart.data.value : traceStart.details);

  const hookStart = await attempt('wxmp_hook_wx_request', {
    session_id: sessionId,
    context_id: appContextId,
  }, 30_000);
  const hookInstalled = hookStart.ok && (hookStart.data.value?.installed?.length > 0 || hookStart.data.value?.reused === true);
  record('requestHookInstall', hookInstalled, hookStart.ok ? hookStart.data.value : hookStart.details);

  await attempt('wxmp_capture_start', { session_id: sessionId, context_id: appContextId }, 20_000);
  await attempt('wxmp_call_wx_api', {
    session_id: sessionId,
    context_id: appContextId,
    api: 'getSystemInfo',
    options: {},
  }, 40_000);

  const inventoryUrl = `http://127.0.0.1:${fixturePort}/inventory?gate=${gateId}`;
  await attempt('wxmp_evaluate', {
    session_id: sessionId,
    context_id: appContextId,
    expression: `(async()=>{const response=await fetch(${JSON.stringify(inventoryUrl)},{headers:{'x-wxmp-gate':${JSON.stringify(gateId)}}});return {status:response.status,body:await response.text()};})()`,
    await_promise: true,
    return_by_value: true,
  }, 40_000);
  await sleep(500);
  const inventory = await call('wxmp_get_api_inventory', {
    session_id: sessionId,
    context_id: appContextId,
    include_hooks: true,
  }, 30_000);
  const inventoryItems = flattenInventory(inventory.inventory);
  record('apiInventory', inventory.totalUrls > 0 && inventoryItems.some((item) => String(item.path).includes('/inventory')), {
    totalUrls: inventory.totalUrls,
    domains: inventory.domains,
    matching: inventoryItems.filter((item) => String(item.path).includes('/inventory')),
  });

  const hookUrl = `http://127.0.0.1:${fixturePort}/hook?gate=${gateId}`;
  await attempt('wxmp_evaluate', {
    session_id: sessionId,
    context_id: appContextId,
    expression: `(async()=>{const response=await fetch(${JSON.stringify(hookUrl)},{headers:{'x-wxmp-gate':${JSON.stringify(gateId)}}});return {status:response.status,body:await response.text()};})()`,
    await_promise: true,
    return_by_value: true,
  }, 40_000);
  await sleep(500);
  const hooked = await call('wxmp_get_hooked_requests', {
    session_id: sessionId,
    context_id: appContextId,
  }, 30_000);
  record('requestHook', hookInstalled && hooked.count > 0 && hooked.records.some((entry) => String(entry.url).includes('/hook')), {
    installed: hookInstalled,
    count: hooked.count,
    records: hooked.records.map((entry) => ({ type: entry.type, url: entry.url, method: entry.method, status: entry.response?.status })),
    artifactPath: hooked.artifactPath,
  });

  await sleep(500);
  const traces = await call('wxmp_trace_query', { session_id: sessionId, offset: 0, limit: 1000 });
  record('trace', traceInstalled && traces.total > 0, {
    installed: traceInstalled,
    total: traces.total,
    sample: traces.items.slice(0, 5).map((entry) => entry.data),
  });

  if (fetchContextId) {
    await attempt('wxmp_capture_start', { session_id: sessionId, context_id: fetchContextId }, 20_000);
    const fetchUrl = `http://127.0.0.1:${fixturePort}/fetch?gate=${gateId}`;
    const fetchResult = await attempt('wxmp_evaluate', {
      session_id: sessionId,
      context_id: fetchContextId,
      expression: `(async()=>{const response=await fetch(${JSON.stringify(fetchUrl)},{headers:{'x-wxmp-gate':${JSON.stringify(gateId)}}});return {status:response.status,body:await response.text()};})()`,
      await_promise: true,
      return_by_value: true,
    }, 40_000);
    await sleep(1000);
    const requests = await call('wxmp_list_requests', {
      session_id: sessionId,
      offset: 0,
      limit: 500,
      url_filter: `/fetch?gate=${gateId}`,
    });
    const request = requests.items.at(-1);
    if (request) {
      const requestDetail = await call('wxmp_get_request', {
        session_id: sessionId,
        request_id: request.requestId,
        include_body: true,
      }, 30_000);
      const responseBody = String(requestDetail.body?.result?.body ?? '');
      record('networkBody', fetchResult.ok
        && fetchResult.data.value?.status === 200
        && responseBody.includes(gateId), {
        fetchStatus: fetchResult.ok ? fetchResult.data.value?.status : null,
        indexed: summarizeRequest(request),
        total: requests.total,
        responseStatus: requestDetail.request?.response?.status,
        responseBodyLength: responseBody.length,
        responseBodyContainsGate: responseBody.includes(gateId),
      });
      const replay = await attempt('wxmp_replay_request', {
        session_id: sessionId,
        request_id: request.requestId,
        headers: { 'x-wxmp-replay': gateId },
      }, 45_000);
      const body = replay.ok ? String(replay.data.value?.body ?? '') : '';
      record('replay', replay.ok && replay.data.value?.status === 200 && body.includes(gateId), {
        requestContextId: request.contextId,
        status: replay.ok ? replay.data.value?.status : null,
        bodyLength: body.length,
        bodyContainsGate: body.includes(gateId),
        error: replay.ok ? null : replay.details,
      });
    } else {
      record('networkBody', false, {
        fetchStatus: fetchResult.ok ? fetchResult.data.value?.status : null,
        indexed: null,
        total: requests.total,
        reason: 'No indexed fetch request was available',
      });
      record('replay', false, { reason: 'No indexed fetch request was available' });
    }
  } else {
    record('networkBody', false, { reason: 'No runtime context exposed fetch' });
    record('replay', false, { reason: 'No runtime context exposed fetch' });
  }

  await stopRuntimeWrappers(appContextId);
  if (fetchContextId && fetchContextId !== appContextId) {
    await attempt('wxmp_capture_stop', { session_id: sessionId, context_id: fetchContextId }, 15_000);
  }

  if (!options.skipReconnect) {
    const restartInfo = await probeRuntimeContext(appContextId);
    const beforeContextIds = probed.contexts.map((context) => context.id).sort();
    let restartScheduled = null;
    if (restartInfo?.hasRestartMiniProgram || restartInfo?.hasReLaunch) {
      restartScheduled = await attempt('wxmp_evaluate', {
        session_id: sessionId,
        context_id: appContextId,
        expression: `(() => {
          ${wxResolverSource}
          const runtime = __gateResolveWxRuntime();
          const wxObject = runtime.wx;
          let route = '';
          try {
            const pages = typeof runtime.wxRoot?.getCurrentPages === 'function' ? runtime.wxRoot.getCurrentPages() : [];
            route = pages && pages.length ? String(pages[pages.length - 1].route || '') : '';
          } catch (_) {}
          const action = typeof wxObject?.restartMiniProgram === 'function' ? 'restartMiniProgram'
            : typeof wxObject?.reLaunch === 'function' ? 'reLaunch' : '';
          setTimeout(() => {
            if (action === 'restartMiniProgram') wxObject.restartMiniProgram(route ? { path: '/' + route } : {});
            else if (action === 'reLaunch') wxObject.reLaunch({ url: route ? '/' + route : '/' });
          }, 300);
          return { scheduled: Boolean(action), action, wxRuntimePath: runtime.path };
        })()`,
        await_promise: true,
        return_by_value: true,
      }, 15_000);
    }

    let sawDisconnected = false;
    let waitResult = null;
    if (restartScheduled?.ok && restartScheduled.data.value?.scheduled) {
      const disconnectDeadline = Date.now() + Math.min(reconnectTimeoutMs, 20_000);
      while (Date.now() < disconnectDeadline) {
        await sleep(250);
        const status = await attempt('wxmp_session_status', { session_id: sessionId }, 5000);
        if (!status.ok) continue;
        if (status.data.state === 'disconnected' || status.data.bridgeConnected === false) {
          sawDisconnected = true;
          waitResult = await attempt(
            'wxmp_wait_for_runtime',
            { session_id: sessionId, timeout_ms: reconnectTimeoutMs },
            reconnectTimeoutMs + 10_000,
          );
          break;
        }
      }
    }
    await sleep(1500);
    const afterStatus = await attempt('wxmp_session_status', { session_id: sessionId }, 10_000);
    let afterProbe = null;
    if (afterStatus.ok && afterStatus.data.bridgeConnected) {
      afterProbe = await attempt('wxmp_probe_contexts', { session_id: sessionId }, 45_000);
    }
    summary.runtime.reconnect = {
      restartInfo: restartInfo ? {
        hasRestartMiniProgram: restartInfo.hasRestartMiniProgram,
        hasReLaunch: restartInfo.hasReLaunch,
        wxRuntimePath: restartInfo.wxRuntimePath,
      } : null,
      scheduled: restartScheduled?.ok ? restartScheduled.data.value : restartScheduled?.details,
      sawDisconnected,
      waitResult: waitResult?.ok ? summarizeSessionStatus(waitResult.data) : waitResult?.details,
      afterStatus: afterStatus.ok ? summarizeSessionStatus(afterStatus.data) : afterStatus.details,
      beforeContextIds,
      afterContextIds: afterProbe?.ok ? afterProbe.data.contexts.map((context) => context.id).sort() : [],
    };
  } else {
    summary.runtime.reconnect = { skipped: true, reason: '--skip-reconnect' };
    record('reconnect', false, summary.runtime.reconnect, 'skipped');
  }

  await detachSession();
  await finalizeEvidence();
} catch (error) {
  const details = sanitizeForSummary({ message: error.message, code: error.code, payload: error.payload });
  summary.errors.push({ operation: 'gate-fatal', details });
  process.stderr.write(`[gate] FATAL ${details.message}\n`);
} finally {
  if (sessionId && !detached) {
    await stopRuntimeWrappers(appContextId).catch(() => undefined);
    await detachSession().catch(() => undefined);
  }
  await finalizeEvidence().catch((error) => {
    const details = sanitizeForSummary({ message: error.message, code: error.code });
    summary.errors.push({ operation: 'evidence-finalize', details });
    record('evidenceExport', false, details);
  });
  if (client) await client.close().catch(() => undefined);
  await closeFixtureServer().catch(() => undefined);
  summary.finishedAt = new Date().toISOString();
  for (const gateName of requiredGates) {
    if (!summary.gates[gateName]) record(gateName, false, { reason: 'Gate ended before this check ran' }, 'not-run');
  }
  summary.passed = requiredGates.every((name) => summary.gates[name]?.passed === true);
  await fs.mkdir(outputRoot, { recursive: true });
  summary.summaryPath = path.relative(workspaceRoot, outputPath).replaceAll(path.sep, '/');
  const safeSummary = sanitizeForSummary(summary);
  await fs.writeFile(outputPath, `${JSON.stringify(safeSummary, null, 2)}\n`, { encoding: 'utf8' });
  process.stdout.write(`${JSON.stringify({ ok: summary.passed, summaryPath: outputPath, gates: summary.gates, evidence: summary.evidence, errors: summary.errors }, null, 2)}\n`);
  process.exitCode = summary.passed ? 0 : 2;
}
