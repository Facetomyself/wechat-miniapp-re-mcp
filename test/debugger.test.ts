import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../src/evidence/store.js';
import { WxmpError } from '../src/errors.js';
import {
  callFrameById,
  isWasmScript,
  normalizePausedState,
  paginateProperties,
} from '../src/runtime/debugger.js';
import { buildDebuggerTools } from '../src/tools/debugger.js';
import { CdpChannel } from '../src/transport/cdp-channel.js';
import type { WxmpApp } from '../src/app.js';

const PAUSED = {
  reason: 'other',
  hitBreakpoints: ['bp-cdp-1'],
  callFrames: [{
    callFrameId: 'frame-0',
    functionName: 'handler',
    url: 'app.js',
    location: { scriptId: 'script-1', lineNumber: 10, columnNumber: 2 },
    scopeChain: [
      { type: 'local', object: { objectId: 'local-1', type: 'object' } },
      { type: 'closure', object: { objectId: 'closure-1', type: 'object' } },
    ],
  }],
};

function debuggerTool(app: WxmpApp, name: string) {
  const entry = buildDebuggerTools(app).find((candidate) => candidate.tool.name === name);
  assert.ok(entry, `missing tool ${name}`);
  return entry;
}

test('normalizePausedState selects a frame and rejects an out-of-range index', () => {
  const idle = normalizePausedState(null);
  assert.equal(idle.paused, false);
  const paused = normalizePausedState(PAUSED, { contextId: 'ctx-1', selectedFrameIndex: 0, generation: 3 });
  assert.equal(paused.paused, true);
  assert.equal(paused.selectedFrame?.callFrameId, 'frame-0');
  assert.equal(paused.selectedFrame?.scopeChain[0].objectId, 'local-1');
  assert.equal(paused.generation, 3);
  assert.throws(
    () => normalizePausedState(PAUSED, { selectedFrameIndex: 9 }),
    (error: unknown) => error instanceof WxmpError && error.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => callFrameById(idle),
    (error: unknown) => error instanceof WxmpError && error.code === 'NOT_PAUSED',
  );
});

test('paginateProperties truncates by byte budget', () => {
  const properties = Array.from({ length: 8 }, (_, index) => ({
    name: `k${index}`,
    value: { type: 'string', value: 'x'.repeat(200) },
    writable: true,
    enumerable: true,
  }));
  const page = paginateProperties(properties, 0, 8, 400);
  assert.equal(page.total, 8);
  assert.ok(page.items.length < 8);
  assert.equal(page.truncated, true);
  assert.ok(page.byteLength <= 400);
});

test('isWasmScript recognizes language and wasm URLs', () => {
  assert.equal(isWasmScript({ scriptLanguage: 'WebAssembly' }), true);
  assert.equal(isWasmScript({ url: 'https://app.example/module.wasm' }), true);
  assert.equal(isWasmScript({ url: 'app.js', scriptLanguage: 'JavaScript' }), false);
});

test('CDP channel stores initiator, wasm language, websocket frames, and stale breakpoints after disconnect', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-dbg-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});
  channel.handlePayload(JSON.stringify({
    method: 'Network.requestWillBeSent',
    params: {
      requestId: 'req-1',
      request: { url: 'https://api.example.test/v1', method: 'POST', headers: {} },
      initiator: { type: 'script', url: 'app.js', lineNumber: 4 },
    },
  }), 'ctx-1');
  channel.handlePayload(JSON.stringify({
    method: 'Debugger.scriptParsed',
    params: { scriptId: 'wasm-1', url: 'wasm://module', scriptLanguage: 'WebAssembly', length: 32 },
  }), 'ctx-1');
  channel.handlePayload(JSON.stringify({
    method: 'Network.webSocketCreated',
    params: { requestId: 'ws-1', url: 'wss://api.example.test/ws' },
  }), 'ctx-1');
  for (let index = 0; index < 205; index += 1) {
    channel.handlePayload(JSON.stringify({
      method: 'Network.webSocketFrameReceived',
      params: { requestId: 'ws-1', timestamp: index, response: { opcode: 1, payloadData: `m${index}` } },
    }), 'ctx-1');
  }
  const request = channel.findRequest('req-1', 'ctx-1');
  assert.equal(request?.initiator?.type, 'script');
  assert.equal(channel.wasmScripts().length, 1);
  const socket = channel.findWebSocket('ws-1', 'ctx-1');
  assert.equal(socket?.frames.length, 200);
  assert.equal(socket?.droppedFrames, 5);
  const logical = channel.registerBreakpoint({
    kind: 'script',
    spec: { scriptId: 'script-1', lineNumber: 3 },
    cdpBreakpointId: 'cdp-1',
    locations: [],
    pending: false,
    status: 'bound',
  });
  channel.disconnect('runtime disconnected');
  assert.equal(channel.lastPaused, null);
  assert.equal(channel.findBreakpoint(logical.logicalId)?.status, 'stale');
  assert.equal(channel.findWebSocket('ws-1', 'ctx-1')?.stale, true);
  assert.equal(channel.debuggerGeneration, 1);
  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('paused-state and scope tools fail closed when the debugger is not paused', async () => {
  const session = {
    channel: { lastPaused: null, lastPausedContextId: undefined, debuggerGeneration: 0 },
    evidence: { append: async () => undefined },
    selectedContextId: 'ctx-1',
  };
  const app = { sessions: { get: () => session, contextId: () => 'ctx-1' } } as unknown as WxmpApp;
  const paused = await debuggerTool(app, 'wxmp_get_paused_state').handler({ session_id: 's1' });
  const pausedPayload = JSON.parse((paused.content[0] as { type: 'text'; text: string }).text) as { data: { paused: boolean } };
  assert.equal(pausedPayload.data.paused, false);
  await assert.rejects(
    () => debuggerTool(app, 'wxmp_get_scope_variables').handler({ session_id: 's1' }),
    (error: unknown) => error instanceof WxmpError && error.code === 'NOT_PAUSED',
  );
  await assert.rejects(
    () => debuggerTool(app, 'wxmp_evaluate_on_call_frame').handler({ session_id: 's1', expression: '1+1' }),
    (error: unknown) => error instanceof WxmpError && error.code === 'NOT_PAUSED',
  );
});

test('scope variables paginate Runtime.getProperties from the selected frame', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown>; contextId: string }> = [];
  const session = {
    selectedContextId: 'ctx-1',
    channel: {
      lastPaused: PAUSED,
      lastPausedContextId: 'ctx-1',
      debuggerGeneration: 0,
      send: async (method: string, params: Record<string, unknown>, contextId: string) => {
        sent.push({ method, params, contextId });
        return {
          result: {
            result: [
              { name: 'count', value: { type: 'number', value: 2 }, writable: true, enumerable: true },
              { name: 'label', value: { type: 'string', value: 'ok' }, writable: true, enumerable: true },
            ],
          },
        };
      },
    },
    evidence: { append: async () => undefined },
  };
  const app = { sessions: { get: () => session, contextId: () => 'ctx-1' } } as unknown as WxmpApp;
  const response = await debuggerTool(app, 'wxmp_get_scope_variables').handler({
    session_id: 's1',
    offset: 1,
    limit: 1,
  });
  const payload = JSON.parse((response.content[0] as { type: 'text'; text: string }).text) as {
    data: { objectId: string; total: number; items: Array<{ name: string }> };
  };
  assert.equal(payload.data.objectId, 'local-1');
  assert.equal(payload.data.total, 2);
  assert.equal(payload.data.items[0].name, 'label');
  assert.equal(sent[0]?.method, 'Runtime.getProperties');
  assert.equal(sent[0]?.params.objectId, 'local-1');
});

test('evaluate on call frame uses Debugger.evaluateOnCallFrame', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const session = {
    selectedContextId: 'ctx-1',
    channel: {
      lastPaused: PAUSED,
      lastPausedContextId: 'ctx-1',
      debuggerGeneration: 0,
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
        return { result: { result: { type: 'number', value: 3 } } };
      },
    },
    evidence: { append: async () => undefined },
  };
  const app = { sessions: { get: () => session, contextId: () => 'ctx-1' } } as unknown as WxmpApp;
  const response = await debuggerTool(app, 'wxmp_evaluate_on_call_frame').handler({
    session_id: 's1',
    expression: '1+2',
  });
  const payload = JSON.parse((response.content[0] as { type: 'text'; text: string }).text) as { data: { value: number; callFrameId: string } };
  assert.equal(payload.data.value, 3);
  assert.equal(payload.data.callFrameId, 'frame-0');
  assert.equal(sent[0]?.method, 'Debugger.evaluateOnCallFrame');
});

test('XHR breakpoint, initiator, websocket, and wasm save tools stay fail-closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-dbg-tool-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});
  channel.handlePayload(JSON.stringify({
    method: 'Network.requestWillBeSent',
    params: {
      requestId: 'req-hook',
      request: { url: 'https://api.example.test/hook', method: 'GET', headers: {} },
    },
  }), 'ctx-1');
  const hookRequest = channel.findRequest('req-hook', 'ctx-1')!;
  hookRequest.transport = 'wx.request';
  hookRequest.transportOptions = { callStack: ['wx.request @ app.js:9'] };
  channel.handlePayload(JSON.stringify({
    method: 'Network.webSocketCreated',
    params: { requestId: 'ws-2', url: 'wss://api.example.test/live' },
  }), 'ctx-1');
  channel.handlePayload(JSON.stringify({
    method: 'Debugger.scriptParsed',
    params: { scriptId: 'wasm-9', url: 'app.wasm', scriptLanguage: 'WebAssembly' },
  }), 'ctx-1');
  const sent: string[] = [];
  const originalSend = channel.send.bind(channel);
  channel.send = async (method: string, params: Record<string, unknown>, contextId = '', timeoutMs?: number) => {
    sent.push(method);
    if (method === 'DOMDebugger.setXHRBreakpoint') return { result: {} };
    if (method === 'Debugger.getWasmBytecode') return { result: { bytecode: Buffer.from('wasm-bytes').toString('base64') } };
    return originalSend(method, params, contextId, timeoutMs);
  };
  const session = {
    selectedContextId: 'ctx-1',
    channel,
    evidence,
  };
  const app = {
    sessions: {
      get: () => session,
      contextId: () => 'ctx-1',
    },
  } as unknown as WxmpApp;

  const xhr = await debuggerTool(app, 'wxmp_break_on_xhr').handler({ session_id: 's1', url: '/api' });
  const xhrPayload = JSON.parse((xhr.content[0] as { type: 'text'; text: string }).text) as { data: { enabled: boolean } };
  assert.equal(xhrPayload.data.enabled, true);
  const listed = await debuggerTool(app, 'wxmp_list_breakpoints').handler({ session_id: 's1' });
  const listedPayload = JSON.parse((listed.content[0] as { type: 'text'; text: string }).text) as { data: { xhrBreakpoints: unknown[] } };
  assert.equal(listedPayload.data.xhrBreakpoints.length, 1);

  const initiator = await debuggerTool(app, 'wxmp_get_request_initiator').handler({ session_id: 's1', request_id: 'req-hook' });
  const initiatorPayload = JSON.parse((initiator.content[0] as { type: 'text'; text: string }).text) as { data: { source: string } };
  assert.equal(initiatorPayload.data.source, 'hook');

  const sockets = await debuggerTool(app, 'wxmp_list_websockets').handler({ session_id: 's1' });
  const socketsPayload = JSON.parse((sockets.content[0] as { type: 'text'; text: string }).text) as { data: { total: number } };
  assert.equal(socketsPayload.data.total, 1);

  const wasm = await debuggerTool(app, 'wxmp_save_wasm').handler({ session_id: 's1', script_id: 'wasm-9' });
  const wasmPayload = JSON.parse((wasm.content[0] as { type: 'text'; text: string }).text) as { data: { artifactPath: string; length: number } };
  assert.ok(wasmPayload.data.artifactPath.endsWith('.wasm'));
  assert.equal(wasmPayload.data.length, 10);
  assert.ok(sent.includes('DOMDebugger.setXHRBreakpoint'));
  assert.ok(sent.includes('Debugger.getWasmBytecode'));

  await assert.rejects(
    () => debuggerTool(app, 'wxmp_save_wasm').handler({ session_id: 's1', script_id: 'missing' }),
    (error: unknown) => error instanceof WxmpError && error.code === 'WASM_NOT_FOUND',
  );
  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});
