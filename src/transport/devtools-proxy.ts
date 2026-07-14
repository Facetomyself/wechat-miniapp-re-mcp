import { WebSocket, WebSocketServer } from 'ws';
import { CdpChannel } from './cdp-channel.js';
import { WxmpError } from '../errors.js';

export class DevToolsProxy {
  private server: WebSocketServer | null = null;
  private unsubscribe: (() => void) | null = null;

  async start(channel: CdpChannel, port: number, host = '127.0.0.1'): Promise<Record<string, unknown>> {
    if (this.server) throw new WxmpError('DEVTOOLS_PROXY_RUNNING', 'DevTools proxy is already running');
    const server = new WebSocketServer({ host, port });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    const clients = new Set<WebSocket>();
    server.on('connection', (socket) => {
      clients.add(socket);
      socket.on('message', (data) => {
        let command: Record<string, unknown>;
        try {
          command = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          socket.send(JSON.stringify({ error: { message: 'Invalid CDP JSON' } }));
          return;
        }
        void channel.sendObject(command).catch((error) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ id: command.id, error: { message: error instanceof Error ? error.message : String(error) } }));
          }
        });
      });
      socket.on('close', () => clients.delete(socket));
    });
    this.unsubscribe = channel.onRaw((payload) => {
      for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
    this.server = server;
    return {
      host,
      port,
      url: `devtools://devtools/bundled/inspector.html?ws=${host}:${port}`,
    };
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const client of server.clients) client.close(1000, 'Proxy stopped');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
