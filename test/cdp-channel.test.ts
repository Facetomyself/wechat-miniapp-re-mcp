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

  await fs.rm(root, { recursive: true, force: true });
});

test('CDP timeout rejects when no response arrives', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-cdp-'));
  const evidence = new EvidenceStore(root, 'fixture', 'session-1');
  await evidence.init();
  const channel = new CdpChannel('session-1', evidence, async () => { /* never sent */ });

  const promise = channel.send('Debugger.stepOver', {}, '', 200);
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.includes('timed out'));

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

  channel.handlePayload(JSON.stringify({
    method: 'Network.requestWillBeSent',
    params: { requestId: 'r1', request: { url: 'https://api.test/data', method: 'POST', headers: { 'x-trace': '1' } } },
  }), 'ctx-1');
  assert.equal(channel.requests.size, 1);
  assert.equal(channel.requests.get('r1')?.method, 'POST');

  channel.handlePayload(JSON.stringify({
    method: 'Network.responseReceived',
    params: { requestId: 'r1', response: { status: 200, mimeType: 'application/json', headers: {} } },
  }), 'ctx-1');
  assert.equal(channel.requests.get('r1')?.response?.status, 200);

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

  await fs.rm(root, { recursive: true, force: true });
});
