import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpChannel } from '../src/transport/cdp-channel.js';
import { EvidenceStore } from '../src/evidence/store.js';

test('CDP command/response pairing resolves correctly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();

  const payloads: Array<{ payload: string; contextId: string }> = [];
  const sendPayload = async (payload: string, contextId: string) => { payloads.push({ payload, contextId }); };
  const channel = new CdpChannel('session-1', evidence, sendPayload);

  const resultPromise = channel.send('Runtime.evaluate', { expression: '1+1' }, 'ctx-1');
  // Allow microtask queue to flush so sendPayload runs
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(payloads.length > 0);
  assert.ok(payloads[0].payload.includes('Runtime.evaluate'));
  assert.equal(payloads[0].contextId, 'ctx-1');

  channel.handlePayload(JSON.stringify({ id: 1001, result: { value: 2 } }), 'ctx-1');
  const result = await resultPromise;
  assert.deepEqual(result, { id: 1001, result: { value: 2 } });

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP timeout rejects when no response arrives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => { /* never sent */ });

  const promise = channel.send('Debugger.stepOver', {}, '', 200);
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.includes('timed out'));

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel indexes scriptParsed and network events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  channel.handlePayload(JSON.stringify({
    method: 'Debugger.scriptParsed',
    params: { scriptId: '10', url: 'https://example.test/app.js', executionContextId: 1 },
  }), 'ctx-1');
  assert.equal(channel.scripts.size, 1);
  assert.equal(channel.scripts.get('10')?.url, 'https://example.test/app.js');
  assert.equal(channel.scripts.get('10')?.contextId, 'ctx-1');

  channel.handlePayload(JSON.stringify({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r1', request: { url: 'https://api.test/data', method: 'POST', headers: { 'x-trace': '1' } } },
  }), 'ctx-1');
  assert.equal(channel.requests.size, 1);
  assert.equal(channel.requests.get('r1')?.method, 'POST');
  assert.equal(channel.requests.get('r1')?.contextId, 'ctx-1');

  channel.handlePayload(JSON.stringify({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: {} } },
  }), 'ctx-1');
  assert.equal(channel.requests.get('r1')?.response?.status, 200);

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel tracks paused state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  assert.equal(channel.lastPaused, null);
  channel.handlePayload(JSON.stringify({
    method: 'Debugger.paused',
    params: { callFrames: [{ functionName: 'test' }] },
  }), 'ctx-1');
  assert.notEqual(channel.lastPaused, null);
  assert.deepEqual(channel.lastPaused, { callFrames: [{ functionName: 'test' }] });

  channel.handlePayload(JSON.stringify({ method: 'Debugger.resumed', params: {} }), 'ctx-1');
  assert.equal(channel.lastPaused, null);

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel extracts trace events from console API calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'debug', args: [{ value: '__WXMP_TRACE__{"kind":"wx","name":"request","phase":"call","payload":[{}]}' }] },
  }), 'ctx-1');

  const events = await evidence.readEvents(0, 10, 'trace.event');
  assert.equal(events.total, 1);
  assert.deepEqual(events.items[0].data, { kind: 'wx', name: 'request', phase: 'call', payload: [{}] });

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel close rejects pending commands', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  // Fire send without awaiting; close immediately so the pending command is rejected before the timer.
  const promise = channel.send('Debugger.pause', {}, '', 200);
  // Let the microtask queue flush so the command is registered as pending
  await new Promise((resolve) => setTimeout(resolve, 10));
  channel.close('test reason');
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.includes('test reason'));

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP disconnect resets runtime state but preserves context listeners for reconnect', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});
  const actions: string[] = [];
  channel.onContext((action, context) => actions.push(`${action}:${context.id}`));

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.executionContextCreated',
    params: { context: { id: '1', name: 'AppContext', origin: 'https://servicewechat.com' } },
  }), 'ctx-1');
  channel.handlePayload(JSON.stringify({
    method: 'Debugger.scriptParsed',
    params: { scriptId: '10', url: 'https://example.test/app.js' },
  }), 'ctx-1');
  channel.handlePayload(JSON.stringify({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r1', request: { url: 'https://api.test/data', method: 'GET' } },
  }), 'ctx-1');

  channel.disconnect('fixture disconnect');
  assert.equal(channel.contexts.size, 0);
  assert.equal(channel.scripts.size, 0);
  assert.equal(channel.requests.size, 0);
  assert.deepEqual(actions, ['add:1', 'remove:1']);

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.executionContextCreated',
    params: { context: { id: '2', name: 'AppContext', origin: 'https://servicewechat.com' } },
  }), 'ctx-2');
  assert.deepEqual(actions, ['add:1', 'remove:1', 'add:2']);

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel onRaw forwards events to listeners', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  const rawPayloads: string[] = [];
  const unsub = channel.onRaw((payload) => rawPayloads.push(payload));
  channel.handlePayload(JSON.stringify({ method: 'Runtime.executionContextCreated', params: {} }), 'ctx-1');
  assert.equal(rawPayloads.length, 1);

  unsub();
  channel.handlePayload(JSON.stringify({ method: 'Runtime.executionContextDestroyed', params: {} }), 'ctx-1');
  assert.equal(rawPayloads.length, 1);

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel tracks execution context creation and destruction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  const added: Array<{ id: string; name?: string; kind?: string }> = [];
  channel.onContext((action, ctx) => {
    if (action === 'add') added.push(ctx);
  });

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.executionContextCreated',
    params: { context: { id: '1', name: 'AppContext', origin: 'https://servicewechat.com' } },
  }), 'ctx-1');
  assert.equal(added.length, 1);
  assert.equal(added[0].id, '1');
  assert.equal(added[0].name, 'AppContext');
  assert.equal(added[0].kind, 'miniapp');
  assert.equal(channel.contexts.size, 1);

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.executionContextDestroyed',
    params: { executionContextId: 1 },
  }), 'ctx-1');
  assert.equal(channel.contexts.size, 0);

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel detects minigame context kind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  const kinds: string[] = [];
  channel.onContext((_action, ctx) => { kinds.push(ctx.kind ?? ''); });

  channel.handlePayload(JSON.stringify({
    method: 'Runtime.executionContextCreated',
    params: { context: { id: '2', name: 'GameContext', origin: 'https://servicewechat.com' } },
  }), 'ctx-1');
  assert.equal(kinds[0], 'minigame');

  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});

test('CDP channel rejects duplicate or malformed caller-supplied ids', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => {});

  const pending = channel.sendObject({ id: 2000, method: 'Runtime.enable', params: {} }, '', 10_000);
  const pendingRejection = assert.rejects(pending);
  await assert.rejects(
    channel.sendObject({ id: 2000, method: 'Debugger.enable', params: {} }, '', 200),
    (error: unknown) => error instanceof Error && error.message.includes('already pending'),
  );
  await assert.rejects(
    channel.sendObject({ id: 'not-a-number', method: 'Runtime.enable', params: {} }),
    (error: unknown) => error instanceof Error && error.message.includes('positive safe integer'),
  );
  channel.disconnect('fixture done');
  await pendingRejection;
  await evidence.flush();
  await fs.rm(root, { recursive: true, force: true });
});
