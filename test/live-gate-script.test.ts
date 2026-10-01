import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const repositoryRoot = process.cwd();
const scriptPath = path.join(repositoryRoot, 'scripts', 'live-semantic-gate.mjs');
const gateContract = JSON.parse(readFileSync(path.join(repositoryRoot, 'data', 'acceptance', 'gates-v1.json'), 'utf8')) as {
  liveRunnerRequired: string[];
};

test('live semantic gate dry-run resolves an expert versioned execution plan', () => {
  const result = run(['--dry-run', '--wmpf-version', '20079', '--skip-reconnect']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    dryRun: boolean;
    toolset: string;
    expectedWmpfVersion: number;
    requiredGates: string[];
    outputPath: string;
    connectTimeoutMs: number;
    attachSampleTimeoutMs: number;
    runtimeWaitTimeoutMs: number;
    contextTimeoutMs: number;
  };
  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.toolset, 'expert');
  assert.equal(output.expectedWmpfVersion, 20079);
  assert.equal(output.connectTimeoutMs, 60_000);
  assert.equal(output.attachSampleTimeoutMs, 8_000);
  assert.equal(output.runtimeWaitTimeoutMs, 60_000);
  assert.equal(output.contextTimeoutMs, 60_000);
  assert.deepEqual(output.requiredGates, gateContract.liveRunnerRequired.filter((gateName) => gateName !== 'reconnect'));
  const bridge = output.requiredGates.indexOf('runtimeBridge');
  const domains = output.requiredGates.indexOf('cdpDomains');
  const lifecycle = output.requiredGates.indexOf('loadStartLifecycle');
  const appservice = output.requiredGates.indexOf('appserviceContext');
  assert.ok(bridge >= 0 && bridge < domains && domains < lifecycle && lifecycle < appservice);
  assert.match(output.outputPath, /live-semantic-gate-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-wmpf20079-/);
});

test('live semantic gate dry-run auto-selects the current WMPF when version is omitted', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { expectedWmpfVersion: number | null; outputPath: string };
  assert.equal(output.expectedWmpfVersion, null);
  assert.match(output.outputPath, /-wmpfauto-/);
});

test('live semantic gate rejects summary paths outside the controlled project root', () => {
  const outsidePath = path.resolve(repositoryRoot, '..', 'outside-live-gate.json');
  const result = run(['--dry-run', '--output', outsidePath]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output must stay inside/);
});

test('live semantic gate help is available without a built server or WMPF target', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--wmpf-version/);
  assert.match(result.stdout, /--skip-reconnect/);
  assert.match(result.stdout, /--attach-sample-timeout-ms <number>\s+Bridge wait before the lifecycle BEFORE sample \(default: 8000\)/);
  assert.match(result.stdout, /--context-timeout-ms <number>\s+AppService discovery window \(default: 60000\)/);
});

test('lifecycle gates do not imply one another', async () => {
  const support = await import(pathToFileURL(path.join(repositoryRoot, 'scripts', 'lib', 'live-gate-support.mjs')).href) as {
    lifecycleSample: (status: unknown) => {
      loadStartEntered: number;
      loadStartAttached: boolean;
      contextCount: number;
      executionContextCount: number;
      forceDebugTriggerCalls: number;
      bridgeConnected: boolean;
      cdp: boolean;
      debugger: boolean;
      network: boolean;
    };
    runtimeBridgePassed: (sample: unknown) => boolean;
    cdpDomainsPassed: (sample: unknown) => boolean;
    loadStartLifecyclePassed: (before: unknown, after: unknown) => boolean;
    appserviceContextPassed: (appContextId: string) => boolean;
  };
  const before = support.lifecycleSample({
    bridgeConnected: true,
    capabilities: { cdp: true, debugger: true, network: true },
    contexts: [],
    contextGraph: { executionContexts: 3 },
    hook: {
      available: true,
      ready: true,
      cdpFilterAttached: true,
      loadStartAttached: true,
      cdpFilterEntered: 1,
      loadStartEntered: 0,
      forceDebugTriggerCalls: 1,
    },
  });
  const domainsDown = support.lifecycleSample({
    bridgeConnected: true,
    capabilities: { cdp: true, debugger: false, network: true },
    contexts: [],
    hook: {
      available: true,
      ready: true,
      cdpFilterAttached: true,
      loadStartAttached: true,
      loadStartEntered: 0,
      forceDebugTriggerCalls: 2,
    },
  });
  assert.equal(support.runtimeBridgePassed(domainsDown), true);
  assert.equal(support.cdpDomainsPassed(domainsDown), false);
  assert.equal(support.loadStartLifecyclePassed(before, domainsDown), false);
  assert.equal(support.appserviceContextPassed(''), false);
  assert.equal(domainsDown.forceDebugTriggerCalls, 2);

  const reloadedWithoutBridge = support.lifecycleSample({
    bridgeConnected: false,
    capabilities: { cdp: false, debugger: false, network: false },
    contexts: [{ id: 'wmpf-1' }],
    contextGraph: { executionContexts: 4 },
    hook: {
      available: true,
      ready: true,
      cdpFilterAttached: true,
      loadStartAttached: true,
      loadStartEntered: 1,
    },
  });
  assert.equal(support.runtimeBridgePassed(reloadedWithoutBridge), false);
  assert.equal(support.cdpDomainsPassed(reloadedWithoutBridge), false);
  assert.equal(support.loadStartLifecyclePassed(before, reloadedWithoutBridge), true);
  assert.equal(support.appserviceContextPassed('app-1'), true);
  assert.equal(reloadedWithoutBridge.contextCount, 1);
  assert.equal(reloadedWithoutBridge.executionContextCount, 4);
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}
