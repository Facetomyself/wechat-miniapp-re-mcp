import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildWxRequestHookSource } from '../src/runtime/wx-request-hook.js';

test('request hook installs and restores wx.request, fetch, and XMLHttpRequest', () => {
  class FakeXhr {
    status = 201;
    responseText = '{"ok":true}';
    readyState = 0;
    private listeners = new Map<string, () => void>();
    open(): void {}
    setRequestHeader(): void {}
    addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
    getAllResponseHeaders(): string { return 'content-type: application/json'; }
    send(): void { this.readyState = 4; this.listeners.get('loadend')?.(); }
  }

  const sandbox = {
    wx: { request: (options: { success?: (value: unknown) => void; complete?: (value: unknown) => void }) => {
      const value = { statusCode: 200, data: { ok: true }, header: {} };
      options.success?.(value);
      options.complete?.(value);
      return { abort() {} };
    } },
    fetch: async () => ({
      status: 200,
      headers: { entries: () => [] },
      clone: () => ({ text: async () => 'ok' }),
    }),
    XMLHttpRequest: FakeXhr,
    Headers,
    console: { debug() {} },
  };
  vm.createContext(sandbox);
  const installed = vm.runInContext(buildWxRequestHookSource(), sandbox) as { installed: string[]; wrapped: number };
  assert.deepEqual(Array.from(installed.installed), ['wx.request', 'fetch', 'XMLHttpRequest']);
  assert.equal(installed.wrapped, 3);

  const xhr = vm.runInContext('new XMLHttpRequest()', sandbox) as FakeXhr;
  xhr.open();
  xhr.setRequestHeader();
  xhr.send();
  const records = vm.runInContext('globalThis.__wxmpRequestHook.drain()', sandbox) as Array<{ type: string; response: { status: number } }>;
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'XMLHttpRequest');
  assert.equal(records[0].response.status, 201);

  const restored = vm.runInContext('globalThis.__wxmpRequestHook.stop()', sandbox) as { installed: string[] };
  assert.deepEqual(Array.from(restored.installed), ['wx.request', 'fetch', 'XMLHttpRequest']);
});
