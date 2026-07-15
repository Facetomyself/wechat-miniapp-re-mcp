import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocket } from 'ws';
import { DevToolsProxy } from '../src/transport/devtools-proxy.js';
import type { CdpChannel } from '../src/transport/cdp-channel.js';

test('DevTools proxy remaps duplicate client ids and broadcasts only CDP events', async () => {
  const port = await freePort();
  const rawListeners = new Set<(payload: string, contextId: string) => void>();
  const channel = {
    send: async (method: string, _params: Record<string, unknown>, contextId: string) => ({ id: 9000, result: { method, contextId } }),
    onRaw: (listener: (payload: string, contextId: string) => void) => {
      rawListeners.add(listener);
      return () => rawListeners.delete(listener);
    },
  } as unknown as CdpChannel;
  const proxy = new DevToolsProxy();
  await proxy.start(channel, port, 'ctx-appservice');
  const first = await connect(port);
  const second = await connect(port);
  try {
    const firstResponse = nextMessage(first);
    const secondResponse = nextMessage(second);
    first.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }));
    second.send(JSON.stringify({ id: 1, method: 'Debugger.enable', params: {} }));
    assert.deepEqual(await firstResponse, { id: 1, result: { method: 'Runtime.enable', contextId: 'ctx-appservice' } });
    assert.deepEqual(await secondResponse, { id: 1, result: { method: 'Debugger.enable', contextId: 'ctx-appservice' } });

    await expectNoMessage(first, () => {
      for (const listener of rawListeners) listener(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }), 'ctx-webview');
    });
    const firstEvent = nextMessage(first);
    const secondEvent = nextMessage(second);
    for (const listener of rawListeners) listener(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }), 'ctx-appservice');
    assert.equal((await firstEvent).method, 'Runtime.consoleAPICalled');
    assert.equal((await secondEvent).method, 'Runtime.consoleAPICalled');
  } finally {
    first.close();
    second.close();
    await proxy.stop();
  }
});

async function expectNoMessage(socket: WebSocket, action: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timer);
      reject(new Error('Unexpected WebSocket message'));
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, 30);
    socket.once('message', onMessage);
    action();
  });
}

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

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try { resolve(JSON.parse(data.toString()) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}
