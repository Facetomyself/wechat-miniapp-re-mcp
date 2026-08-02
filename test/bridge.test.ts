import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocket } from 'ws';
import { WmpfBridgeServer } from '../src/transport/bridge-server.js';
import { decodeCdpPayload, decodeEnvelope, encodeCdpResultEnvelope, encodeDebugEnvelope } from '../src/transport/codec.js';
import type { BridgeEnvelopeObservation } from '../src/transport/bridge-server.js';

test('bridge assigns a pending session and routes CDP in both directions', async () => {
  const port = await freePort();
  const received: Array<{ payload: string; contextId: string }> = [];
  const connected: string[] = [];
  const bridge = new WmpfBridgeServer('127.0.0.1', port, {
    onCdp: (sessionId, payload, contextId) => {
      assert.equal(sessionId, 'session-1');
      received.push({ payload, contextId });
    },
    onContext: () => undefined,
    onEnvelope: () => undefined,
    onConnected: (sessionId) => connected.push(sessionId),
    onDisconnected: () => undefined,
  });
  await bridge.start();
  bridge.prepare('session-1');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  assert.equal(await bridge.waitForConnection('session-1', 500), true);
  assert.deepEqual(connected, ['session-1']);

  const outbound = new Promise<{ payload: string; contextId: string }>((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        const envelope = decodeEnvelope(Buffer.from(data as Buffer));
        const cdp = decodeCdpPayload(envelope.data);
        resolve({ payload: cdp.payload, contextId: cdp.jscontextId });
      } catch (error) {
        reject(error);
      }
    });
  });
  await bridge.sendCdp('session-1', '{"id":1,"method":"Runtime.enable"}', 'ctx-a');
  assert.deepEqual(await outbound, { payload: '{"id":1,"method":"Runtime.enable"}', contextId: 'ctx-a' });

  socket.send(encodeCdpResultEnvelope(2, '{"id":1,"result":{}}', 'ctx-a'));
  await waitUntil(() => received.length === 1);
  assert.deepEqual(received, [{ payload: '{"id":1,"result":{}}', contextId: 'ctx-a' }]);

  socket.close();
  await bridge.stop();
});

test('bridge requeues the same session after an unexpected disconnect', async () => {
  const port = await freePort();
  const connected: string[] = [];
  const disconnected: string[] = [];
  const bridge = new WmpfBridgeServer('127.0.0.1', port, {
    onCdp: () => undefined,
    onContext: () => undefined,
    onEnvelope: () => undefined,
    onConnected: (sessionId) => connected.push(sessionId),
    onDisconnected: (sessionId) => disconnected.push(sessionId),
  });
  await bridge.start();
  bridge.prepare('session-1');

  const first = await connect(port);
  assert.equal(await bridge.waitForConnection('session-1', 500), true);
  first.close();
  await waitUntil(() => disconnected.length === 1);
  assert.deepEqual((bridge.info().pendingSessions as string[]), ['session-1']);

  const second = await connect(port);
  await waitUntil(() => connected.length === 2);
  assert.equal(bridge.isConnected('session-1'), true);
  assert.deepEqual(connected, ['session-1', 'session-1']);

  bridge.release('session-1');
  second.close();
  await bridge.stop();
});

test('bridge rejects a second concurrent runtime reservation', async () => {
  const port = await freePort();
  const bridge = new WmpfBridgeServer('127.0.0.1', port, {
    onCdp: () => undefined,
    onContext: () => undefined,
    onEnvelope: () => undefined,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
  });
  await bridge.start();
  bridge.prepare('session-1');
  assert.throws(
    () => bridge.prepare('session-2'),
    (error: unknown) => error instanceof Error && error.message.includes('already reserved'),
  );
  bridge.release('session-1');
  await bridge.stop();
});

test('bridge preserves unknown WMPF envelopes with hashable payload metadata', async () => {
  const port = await freePort();
  const observations: BridgeEnvelopeObservation[] = [];
  const bridge = new WmpfBridgeServer('127.0.0.1', port, {
    onCdp: () => undefined,
    onContext: () => undefined,
    onEnvelope: (_sessionId, observation) => observations.push(observation),
    onConnected: () => undefined,
    onDisconnected: () => undefined,
  });
  await bridge.start();
  bridge.prepare('session-unknown');
  const socket = await connect(port);
  const payload = Buffer.from('unknown-protocol-fixture');
  socket.send(encodeDebugEnvelope('customMessage', payload, { seq: 51, after: 3, originalSize: payload.length }));
  await waitUntil(() => observations.length === 1);
  assert.equal(observations[0].category, 'customMessage');
  assert.equal(observations[0].decoder, 'unknown');
  assert.equal(observations[0].seq, 51);
  assert.equal(observations[0].after, 3);
  assert.equal(observations[0].decodedSize, payload.length);
  assert.equal(observations[0].sha256.length, 64);
  assert.deepEqual(observations[0].payload, payload);
  socket.close();
  await bridge.stop();
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
