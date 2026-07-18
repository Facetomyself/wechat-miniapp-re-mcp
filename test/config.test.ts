import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, defaultPackageRoots, windowsPackageRoots } from '../src/config.js';

test('loadConfig resolves workspace root and debug port', () => {
  const config = loadConfig();
  assert.ok(config.workspaceRoot);
  assert.ok(path.isAbsolute(config.workspaceRoot));
  assert.equal(config.debugHost, '127.0.0.1');
  assert.equal(typeof config.debugPort, 'number');
  assert.ok(config.debugPort > 0 && config.debugPort < 65536);
  assert.equal(typeof config.eventLimit, 'number');
  assert.ok(config.eventLimit >= 100);
  assert.ok(config.profileDirs.some((candidate) => candidate.endsWith(path.join('data', 'profiles', 'clean-room'))));
  assert.ok(config.signatureDbPaths.some((candidate) => candidate.endsWith(path.join('data', 'profiles', 'aob-signatures.json'))));
  assert.ok(config.maxEvidenceEvents >= 1000);
  assert.ok(config.maxEvidenceBytes >= 1024 * 1024);
});

test('loadConfig respects WXMP_DEBUG_PORT env', () => {
  const prev = process.env.WXMP_DEBUG_PORT;
  process.env.WXMP_DEBUG_PORT = '12345';
  const config = loadConfig();
  assert.equal(config.debugPort, 12345);
  if (prev !== undefined) process.env.WXMP_DEBUG_PORT = prev; else delete process.env.WXMP_DEBUG_PORT;
});

test('loadConfig rejects invalid debug port', () => {
  const prev = process.env.WXMP_DEBUG_PORT;
  process.env.WXMP_DEBUG_PORT = 'not-a-number';
  const config = loadConfig();
  assert.equal(config.debugPort, 9421);
  if (prev !== undefined) process.env.WXMP_DEBUG_PORT = prev; else delete process.env.WXMP_DEBUG_PORT;
});

test('defaultPackageRoots returns Windows AppData path on win32', () => {
  const roots = defaultPackageRoots();
  if (process.platform === 'win32') {
    assert.ok(roots.length > 0);
    assert.ok(roots[0].includes('Tencent'));
  } else if (process.platform === 'darwin') {
    assert.ok(roots.length > 0);
    assert.ok(roots[0].includes('com.tencent.xinWeChat'));
  }
});

test('windowsPackageRoots discovers current per-user xwechat package directories', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-config-'));
  const radiumRoot = path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium');
  const firstCurrentRoot = path.join(radiumRoot, 'users', 'user-a', 'applet', 'packages');
  const secondCurrentRoot = path.join(radiumRoot, 'users', 'user-c', 'applet', 'packages');
  const incompleteUserRoot = path.join(radiumRoot, 'users', 'user-b');
  try {
    assert.deepEqual(windowsPackageRoots(home), [path.join(radiumRoot, 'Applet', 'packages')]);
    await fs.mkdir(firstCurrentRoot, { recursive: true });
    await fs.mkdir(secondCurrentRoot, { recursive: true });
    await fs.mkdir(incompleteUserRoot, { recursive: true });
    const roots = windowsPackageRoots(home);
    assert.deepEqual(roots, [
      path.join(radiumRoot, 'Applet', 'packages'),
      firstCurrentRoot,
      secondCurrentRoot,
    ]);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('loadConfig falls back from invalid event limits', () => {
  const prev = process.env.WXMP_EVENT_LIMIT;
  process.env.WXMP_EVENT_LIMIT = 'not-a-number';
  assert.equal(loadConfig().eventLimit, 5000);
  if (prev !== undefined) process.env.WXMP_EVENT_LIMIT = prev; else delete process.env.WXMP_EVENT_LIMIT;
});
