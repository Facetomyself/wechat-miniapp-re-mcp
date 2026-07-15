import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildCloudFunctionExpression, buildWxApiExpression } from '../src/runtime/expressions.js';
import { buildTraceScript } from '../src/runtime/trace-script.js';
import { buildWxRuntimeProbeExpression } from '../src/runtime/wx-runtime.js';

function nestedRuntime() {
  const wxFrame = {
    __wxConfig: { accountInfo: { appId: 'wx-fixture' } },
    __wxLibrary: { contextType: 'mainContext', envType: 'appservice' },
    getCurrentPages: () => [{ route: 'pages/index/index' }],
    wx: {
      login(options: { success?: (value: unknown) => void }) {
        options.success?.({ code: 'fixture' });
      },
      request() { return { abort() {} }; },
      setStorage() {},
      cloud: {
        async callFunction(input: unknown) { return { ok: true, input }; },
      },
    },
  };
  return { wxFrame, sandbox: { nav: { wxFrame }, console: { debug() {} } } };
}

test('runtime probe resolves wx from nav.wxFrame', () => {
  const { sandbox } = nestedRuntime();
  vm.createContext(sandbox);
  const probe = vm.runInContext(buildWxRuntimeProbeExpression(), sandbox) as Record<string, unknown>;
  assert.equal(probe.hasWx, true);
  assert.equal(probe.hasWxRequest, true);
  assert.equal(probe.hasWxConfig, true);
  assert.equal(probe.contextType, 'mainContext');
  assert.equal(probe.envType, 'appservice');
  assert.equal(probe.wxRuntimePath, 'globalThis.nav.wxFrame');
});

test('wx API and cloud expressions use the resolved nested runtime', async () => {
  const { sandbox } = nestedRuntime();
  vm.createContext(sandbox);
  const login = await vm.runInContext(buildWxApiExpression('login', { timeout: 1000 }), sandbox) as { value: { code: string } };
  assert.equal(login.value.code, 'fixture');
  const cloud = await vm.runInContext(buildCloudFunctionExpression('fixture', { value: 7 }), sandbox) as { ok: boolean; input: { name: string } };
  assert.equal(cloud.ok, true);
  assert.equal(cloud.input.name, 'fixture');
});

test('trace wraps wx methods exposed by the nested runtime', () => {
  const { sandbox } = nestedRuntime();
  vm.createContext(sandbox);
  const installed = vm.runInContext(buildTraceScript(['wx']), sandbox) as { wrapped: number; wxRuntimePath: string };
  assert.ok(installed.wrapped >= 2);
  assert.equal(installed.wxRuntimePath, 'globalThis.nav.wxFrame');
  const stopped = vm.runInContext('globalThis.__wxmpTrace.stop()', sandbox) as { restored: boolean };
  assert.equal(stopped.restored, true);
});
