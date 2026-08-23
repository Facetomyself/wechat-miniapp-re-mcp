import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildHookSource } from '../src/runtime/hook-source.js';
import type { OffsetProfile } from '../src/types.js';

const profile: OffsetProfile = {
  schemaVersion: 1,
  platform: 'windows',
  wmpfVersion: 19977,
  moduleName: 'flue.dll',
  cdpFilterOffset: '0x1A2B',
  loadStartOffset: '0x3C4D',
  sceneOffsets: [0x10, 0x20],
  sceneWhitelist: [1005],
  provenance: { source: 'clean-room', confidence: 'high' },
};

test('generated hook source exposes observation-only rpc.exports', () => {
  const source = buildHookSource(profile);
  assert.match(source, /rpc\.exports\s*=/);
  assert.match(source, /status\s*\(/);
  assert.match(source, /forceDebugTrigger\s*\(/);
  const rpcBlock = source.match(/rpc\.exports\s*=\s*\{[\s\S]*?\n\};/);
  assert.ok(rpcBlock, 'rpc.exports block is present');
  assert.match(rpcBlock[0], /forceDebugTrigger/);
  assert.doesNotMatch(rpcBlock[0], /NativeFunction/);
  assert.doesNotMatch(rpcBlock[0], /Interceptor\.attach/);
  assert.doesNotMatch(source, /new NativeFunction/);
  assert.doesNotThrow(() => new Function(source));

  const sandbox = {
    rpc: { exports: {} as Record<string, () => Record<string, unknown>> },
    send: () => undefined,
    ptr: (value: string) => value,
    Interceptor: { attach() { return undefined; } },
    Process: {
      platform: 'windows',
      findModuleByName: (name: string) => ({
        name,
        size: 4096,
        base: {
          toString: () => '0x1000',
          add: () => ({ toString: () => '0xhook' }),
        },
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(typeof sandbox.rpc.exports.status, 'function');
  assert.equal(typeof sandbox.rpc.exports.forceDebugTrigger, 'function');
  const status = sandbox.rpc.exports.status();
  assert.equal(status.ready, true);
  assert.equal(status.cdpFilterAttached, true);
  assert.equal(status.loadStartAttached, true);
  assert.equal(status.moduleName, 'flue.dll');
  const trigger = sandbox.rpc.exports.forceDebugTrigger();
  assert.equal(trigger.mode, 'observation');
  assert.equal(trigger.attemptedNativeCall, false);
  assert.equal(trigger.forceDebugTriggerCalls, 1);
  assert.equal(sandbox.rpc.exports.status().forceDebugTriggerCalls, 1);
});
