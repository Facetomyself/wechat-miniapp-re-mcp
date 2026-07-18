import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const checkerPath = path.join(repositoryRoot, 'scripts', 'check-acceptance.mjs');

test('acceptance contract validates the bundled records', () => {
  const result = runChecker(repositoryRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { ok: boolean; count: number };
  assert.equal(output.ok, true);
  assert.equal(output.count, 2);
});

test('acceptance contract rejects a modified profile file', async () => {
  const fixtureRoot = await createFixtureRoot();
  try {
    const profilePath = path.join(fixtureRoot, 'data', 'profiles', 'clean-room', 'windows-19977.json');
    await fs.appendFile(profilePath, '\n', 'utf8');
    const result = runChecker(fixtureRoot);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PROFILE_FILE_HASH_MISMATCH/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('acceptance contract rejects a verified record with an incomplete depth', async () => {
  const fixtureRoot = await createFixtureRoot();
  try {
    const recordPath = path.join(fixtureRoot, 'data', 'acceptance', 'windows-19977.full-semantic.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
      gates: Record<string, { status: string; evidence?: string[] }>;
    };
    record.gates.reconnect = { status: 'pending' };
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const result = runChecker(fixtureRoot);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /VERIFIED_DEPTH_INCOMPLETE/);
    assert.match(result.stderr, /reconnect/);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

function runChecker(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [checkerPath, '--root', root], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

async function createFixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-acceptance-'));
  await fs.mkdir(path.join(root, 'data', 'profiles'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.cp(path.join(repositoryRoot, 'data', 'acceptance'), path.join(root, 'data', 'acceptance'), { recursive: true });
  await fs.cp(path.join(repositoryRoot, 'data', 'profiles', 'clean-room'), path.join(root, 'data', 'profiles', 'clean-room'), { recursive: true });
  await fs.copyFile(path.join(repositoryRoot, 'data', 'profiles', 'aob-signatures.json'), path.join(root, 'data', 'profiles', 'aob-signatures.json'));
  await fs.copyFile(path.join(repositoryRoot, 'docs', 'progress.md'), path.join(root, 'docs', 'progress.md'));
  return root;
}
