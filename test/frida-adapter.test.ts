import test from 'node:test';
import assert from 'node:assert/strict';
import { FridaRuntimeAdapter } from '../src/runtime/frida-adapter.js';
import { WxmpError } from '../src/errors.js';
import type { OffsetProfile, TargetProcess } from '../src/types.js';

const target: TargetProcess = {
  pid: 4321,
  ppid: 1,
  executablePath: 'C:\\test\\WeChatAppEx.exe',
  commandLine: 'test.exe',
  version: 19977,
  processType: 'browser',
  renderType: null,
  appId: null,
  isMain: true,
};

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

test('FridaRuntimeAdapter detaches the session when script creation fails', async () => {
  let detachCalls = 0;
  let detachedListenerConnected = false;
  const session = {
    detached: {
      connect: () => { detachedListenerConnected = true; },
    },
    createScript: async () => {
      assert.equal(detachedListenerConnected, true);
      throw new Error('createScript failed');
    },
    detach: async () => { detachCalls += 1; },
  };
  const fakeFrida = {
    getLocalDevice: async () => ({
      attach: async (pid: number) => {
        assert.equal(pid, target.pid);
        return session;
      },
    }),
  } as unknown as Pick<typeof import('frida'), 'getLocalDevice'>;
  const adapter = new FridaRuntimeAdapter(async () => fakeFrida);

  await assert.rejects(
    adapter.attach(target, profile, () => undefined),
    (error: unknown) => error instanceof WxmpError
      && error.code === 'FRIDA_SCRIPT_FAILED'
      && error.details.cause === 'createScript failed',
  );
  assert.equal(detachCalls, 1);
});

test('FridaRuntimeAdapter unloads the script and detaches when script loading fails', async () => {
  let unloadCalls = 0;
  let detachCalls = 0;
  const script = {
    message: { connect: () => undefined },
    load: async () => { throw new Error('script load failed'); },
    unload: async () => { unloadCalls += 1; },
  };
  const session = {
    detached: { connect: () => undefined },
    createScript: async () => script,
    detach: async () => { detachCalls += 1; },
  };
  const fakeFrida = {
    getLocalDevice: async () => ({ attach: async () => session }),
  } as unknown as Pick<typeof import('frida'), 'getLocalDevice'>;
  const adapter = new FridaRuntimeAdapter(async () => fakeFrida);

  await assert.rejects(
    adapter.attach(target, profile, () => undefined),
    (error: unknown) => error instanceof WxmpError
      && error.code === 'FRIDA_SCRIPT_FAILED'
      && error.details.cause === 'script load failed',
  );
  assert.equal(unloadCalls, 1);
  assert.equal(detachCalls, 1);
});
