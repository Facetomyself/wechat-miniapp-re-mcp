import { WebSocket, WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';
import { decodeCdpPayload, decodeContext, decodeEnvelope, encodeCdpEnvelope } from './codec.js';
import { WxmpError } from '../errors.js';
import { isKnownProtocolCategory } from './protocol-registry.js';

export interface BridgeEnvelopeObservation {
  seq?: number;
  after?: number;
  category: string;
  compressAlgo?: number;
  originalSize?: number;
  decodedSize: number;
  sha256: string;
  payload: Buffer;
  decoder: 'known' | 'unknown' | 'failed';
  error?: string;
}

export interface BridgeHooks {
  onCdp(sessionId: string, payload: string, contextId: string): void;
  onContext(sessionId: string, action: 'add' | 'remove', context: { id: string; name?: string }): void;
  onEnvelope(sessionId: string, observation: BridgeEnvelopeObservation): void;
  onConnected(sessionId: string): void;
  onDisconnected(sessionId: string): void;
}

export class WmpfBridgeServer {
  private server: WebSocketServer | null = null;
  private startPromise: Promise<void> | null = null;
  private pendingSessions: string[] = [];
  private desiredSessionId: string | null = null;
  private sockets = new Map<string, WebSocket>();
  private sequence = new Map<string, number>();
  private connectionWaiters = new Map<string, Array<(connected: boolean) => void>>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly hooks: BridgeHooks,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 64 * 1024 * 1024 });
      const onError = (error: Error) => {
        server.close();
        this.startPromise = null;
        reject(new WxmpError('BRIDGE_START_FAILED', `Unable to listen on ${this.host}:${this.port}`, { cause: error.message }));
      };
      server.once('error', onError);
      server.once('listening', () => {
        server.off('error', onError);
        server.on('error', (error) => console.error(`[wxmp] bridge error: ${error.message}`));
        this.server = server;
        resolve();
      });
      server.on('connection', (socket) => this.accept(socket));
    });
    return this.startPromise;
  }

  prepare(sessionId: string): void {
    if (this.desiredSessionId && this.desiredSessionId !== sessionId) {
      throw new WxmpError('BRIDGE_SESSION_BUSY', `WMPF bridge is already reserved by ${this.desiredSessionId}`, {
        activeSessionId: this.desiredSessionId,
        requestedSessionId: sessionId,
        reason: 'The WMPF debug endpoint has no session handshake, so concurrent runtime attaches cannot be isolated safely.',
      });
    }
    this.desiredSessionId = sessionId;
    if (!this.pendingSessions.includes(sessionId) && !this.sockets.has(sessionId)) this.pendingSessions.push(sessionId);
  }

  private accept(socket: WebSocket): void {
    const sessionId = this.pendingSessions.shift();
    if (!sessionId) {
      socket.close(1013, 'No pending wxmp session');
      return;
    }
    const previous = this.sockets.get(sessionId);
    if (previous && previous.readyState === WebSocket.OPEN) previous.close(1012, 'Runtime reconnected');
    this.sockets.set(sessionId, socket);
    this.sequence.set(sessionId, 0);
    this.hooks.onConnected(sessionId);
    for (const waiter of this.connectionWaiters.get(sessionId) ?? []) waiter(true);
    this.connectionWaiters.delete(sessionId);

    socket.on('message', (data) => {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        const envelope = decodeEnvelope(frame);
        let decoder: BridgeEnvelopeObservation['decoder'] = isKnownProtocolCategory(envelope.category) ? 'known' : 'unknown';
        let decodeError: string | undefined;
        try {
          if (envelope.category === 'chromeDevtoolsResult' || envelope.category === 'chromeDevtools') {
            const cdp = decodeCdpPayload(envelope.data);
            this.hooks.onCdp(sessionId, cdp.payload, cdp.jscontextId);
          } else if (envelope.category === 'addJsContext' || envelope.category === 'removeJsContext') {
            const context = decodeContext(envelope.category, envelope.data);
            if (context) this.hooks.onContext(sessionId, envelope.category === 'addJsContext' ? 'add' : 'remove', context);
          }
        } catch (error) {
          decoder = 'failed';
          decodeError = error instanceof Error ? error.message : String(error);
        }
        this.hooks.onEnvelope(sessionId, observeEnvelope(envelope.data, {
          seq: envelope.seq,
          after: envelope.after,
          category: envelope.category,
          compressAlgo: envelope.compressAlgo,
          originalSize: envelope.originalSize,
          decoder,
          error: decodeError,
        }));
      } catch (error) {
        this.hooks.onEnvelope(sessionId, observeEnvelope(frame, {
          category: 'decodeError',
          decoder: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
    socket.on('close', () => {
      if (this.sockets.get(sessionId) === socket) {
        this.sockets.delete(sessionId);
        if (this.desiredSessionId === sessionId && !this.pendingSessions.includes(sessionId)) {
          this.pendingSessions.push(sessionId);
        }
        this.hooks.onDisconnected(sessionId);
      }
    });
    socket.on('error', (error) => {
      this.hooks.onEnvelope(sessionId, observeEnvelope(Buffer.alloc(0), {
        category: 'socketError',
        decoder: 'failed',
        error: error.message,
      }));
    });
  }

  async waitForConnection(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (this.isConnected(sessionId)) return true;
    return new Promise<boolean>((resolve) => {
      const waiter = (connected: boolean) => {
        clearTimeout(timer);
        resolve(connected);
      };
      const timer = setTimeout(() => {
        const waiters = this.connectionWaiters.get(sessionId) ?? [];
        this.connectionWaiters.set(sessionId, waiters.filter((entry) => entry !== waiter));
        resolve(false);
      }, timeoutMs);
      this.connectionWaiters.set(sessionId, [...(this.connectionWaiters.get(sessionId) ?? []), waiter]);
    });
  }

  isConnected(sessionId: string): boolean {
    return this.sockets.get(sessionId)?.readyState === WebSocket.OPEN;
  }

  async sendCdp(sessionId: string, payload: string, contextId: string): Promise<void> {
    const socket = this.sockets.get(sessionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new WxmpError('RUNTIME_NOT_CONNECTED', `Session ${sessionId} has no WMPF debug connection`, { sessionId });
    }
    const seq = (this.sequence.get(sessionId) ?? 0) + 1;
    this.sequence.set(sessionId, seq);
    await new Promise<void>((resolve, reject) => {
      socket.send(encodeCdpEnvelope(seq, payload, contextId), { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }

  release(sessionId: string): void {
    if (this.desiredSessionId === sessionId) this.desiredSessionId = null;
    this.pendingSessions = this.pendingSessions.filter((entry) => entry !== sessionId);
    const socket = this.sockets.get(sessionId);
    if (socket) socket.close(1000, 'Session detached');
    this.sockets.delete(sessionId);
    this.sequence.delete(sessionId);
    for (const waiter of this.connectionWaiters.get(sessionId) ?? []) waiter(false);
    this.connectionWaiters.delete(sessionId);
  }

  async stop(): Promise<void> {
    if (this.desiredSessionId) this.release(this.desiredSessionId);
    for (const sessionId of [...this.sockets.keys()]) this.release(sessionId);
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  info(): Record<string, unknown> {
    return {
      host: this.host,
      port: this.port,
      listening: Boolean(this.server),
      desiredSessionId: this.desiredSessionId,
      connectedSessions: [...this.sockets.keys()],
      pendingSessions: [...this.pendingSessions],
    };
  }
}

function observeEnvelope(
  payload: Buffer,
  metadata: Omit<BridgeEnvelopeObservation, 'payload' | 'decodedSize' | 'sha256'>,
): BridgeEnvelopeObservation {
  return {
    ...metadata,
    payload,
    decodedSize: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
}
