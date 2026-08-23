import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
    runtimeWaitTimeoutMs: number;
  };
  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.toolset, 'expert');
  assert.equal(output.expectedWmpfVersion, 20079);
  assert.equal(output.connectTimeoutMs, 60_000);
  assert.equal(output.runtimeWaitTimeoutMs, 60_000);
  assert.deepEqual(output.requiredGates, gateContract.liveRunnerRequired.filter((gateName) => gateName !== 'reconnect'));
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
