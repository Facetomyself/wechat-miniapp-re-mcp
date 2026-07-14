import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig, defaultPackageRoots } from '../src/config.js';

test('loadConfig resolves workspace root and debug port', () => {
  const config = loadConfig();
  assert.ok(config.workspaceRoot);
  assert.ok(path.isAbsolute(config.workspaceRoot));
  assert.equal(config.debugHost, '127.0.0.1');
  assert.equal(typeof config.debugPort, 'number');
  assert.ok(config.debugPort > 0 && config.debugPort < 65536);
  assert.equal(typeof config.eventLimit, 'number');
  assert.ok(config.eventLimit >= 100);
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
