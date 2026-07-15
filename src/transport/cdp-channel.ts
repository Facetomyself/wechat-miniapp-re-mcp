import { EvidenceStore } from '../evidence/store.js';
import { NetworkRecord, ScriptRecord, WmpfContext } from '../types.js';
import { WxmpError } from '../errors.js';

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RawListener = (payload: string, contextId: string) => void;
type ContextListener = (action: 'add' | 'remove', context: { id: string; name?: string; origin?: string; kind?: string }) => void;

export class CdpChannel {
  private commandId = 1000;
  private pending = new Map<number, PendingCommand>();
  private rawListeners = new Set<RawListener>();
  private contextListeners = new Set<ContextListener>();
  readonly scripts = new Map<string, ScriptRecord>();
  readonly requests = new Map<string, NetworkRecord>();
  readonly contexts = new Map<string, WmpfContext>();
  lastPaused: Record<string, unknown> | null = null;
  traceActive = false;

  constructor(
    readonly sessionId: string,
    private readonly evidence: EvidenceStore,
    private readonly sendPayload: (payload: string, contextId: string) => Promise<void>,
  ) {}

  async send(method: string, params: Record<string, unknown> = {}, contextId = '', timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const id = ++this.commandId;
    return this.sendObject({ id, method, params }, contextId, timeoutMs);
  }

  async sendObject(command: Record<string, unknown>, contextId = '', timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const suppliedId = command.id;
    const id = suppliedId === undefined ? ++this.commandId : Number(suppliedId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new WxmpError('INVALID_CDP_ID', 'CDP command id must be a positive safe integer', { id: suppliedId });
    }
    if (this.pending.has(id)) {
      throw new WxmpError('CDP_ID_COLLISION', `CDP command id ${id} is already pending`, { id });
    }
    this.commandId = Math.max(this.commandId, id);
    command.id = id;
    const payload = JSON.stringify(command);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WxmpError('CDP_TIMEOUT', `CDP command ${String(command.method ?? id)} timed out`, { id, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void (async () => {
        await this.evidence.append('cdp.command', { id, method: command.method, params: command.params }, { contextId, operation: String(command.method ?? 'raw') });
        await this.sendPayload(payload, contextId);
      })().catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  handlePayload(payload: string, contextId: string): void {
    for (const listener of this.rawListeners) listener(payload, contextId);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      void this.evidence.append('cdp.invalid_json', { payload }, { contextId });
      return;
    }
    const id = Number(message.id ?? 0);
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new WxmpError('CDP_ERROR', 'CDP command returned an error', { id, error: message.error }));
      else pending.resolve(message);
      void this.evidence.append('cdp.response', message, { contextId });
      return;
    }
    const method = String(message.method ?? '');
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.trackEvent(method, params, contextId);
  }

  private trackEvent(method: string, params: Record<string, unknown>, contextId: string): void {
    const eventContextId = contextId || undefined;
    if (method === 'Debugger.scriptParsed') {
      const script: ScriptRecord = {
        scriptId: String(params.scriptId ?? ''),
        contextId: eventContextId,
        url: String(params.url ?? ''),
        executionContextId: params.executionContextId === undefined ? undefined : Number(params.executionContextId),
        hash: params.hash === undefined ? undefined : String(params.hash),
        length: params.length === undefined ? undefined : Number(params.length),
        sourceMapURL: params.sourceMapURL === undefined ? undefined : String(params.sourceMapURL),
      };
      if (script.scriptId) this.scripts.set(script.scriptId, script);
    } else if (method === 'Debugger.paused') {
      this.lastPaused = params;
    } else if (method === 'Debugger.resumed') {
      this.lastPaused = null;
    } else if (method === 'Network.requestWillBeSent') {
      const request = (params.request ?? {}) as Record<string, unknown>;
      const requestId = String(params.requestId ?? '');
      if (requestId) {
        this.requests.set(requestId, {
          requestId,
          contextId: eventContextId,
          url: String(request.url ?? ''),
          method: String(request.method ?? 'GET'),
          requestHeaders: normalizeHeaders(request.headers),
          postData: request.postData === undefined ? undefined : String(request.postData),
          resourceType: params.type === undefined ? undefined : String(params.type),
          timestamp: params.timestamp === undefined ? undefined : Number(params.timestamp),
        });
      }
    } else if (method === 'Network.responseReceived') {
      const requestId = String(params.requestId ?? '');
      const response = (params.response ?? {}) as Record<string, unknown>;
      const existing = this.requests.get(requestId);
      if (existing) {
        existing.response = {
          status: Number(response.status ?? 0),
          statusText: response.statusText === undefined ? undefined : String(response.statusText),
          mimeType: response.mimeType === undefined ? undefined : String(response.mimeType),
          headers: normalizeHeaders(response.headers),
        };
      }
    } else if (method === 'Runtime.executionContextCreated') {
      const context = (params.context ?? {}) as Record<string, unknown>;
      const id = String(context.id ?? '');
      if (id) {
        const name = String(context.name ?? '');
        const origin = String(context.origin ?? '');
        const lowerName = name.toLowerCase();
        const kind = lowerName.includes('game') ? 'minigame' as const
          : lowerName.includes('app') || lowerName.includes('service') || origin.includes('servicewechat') ? 'miniapp' as const
          : 'unknown' as const;
        const ctx: WmpfContext = {
          id,
          name,
          kind,
          role: kind === 'minigame' ? 'minigame' : 'unknown',
          origin,
          probeConfidence: 'unprobed',
          connectedAt: new Date().toISOString(),
          capabilities: ['evaluate', 'capability-probe'],
        };
        this.contexts.set(id, ctx);
        for (const listener of this.contextListeners) {
          listener('add', { id, name, origin, kind });
        }
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      const id = String(params.executionContextId ?? '');
      if (id) {
        this.contexts.delete(id);
        for (const listener of this.contextListeners) {
          listener('remove', { id });
        }
      }
    } else if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? (params.args as Array<Record<string, unknown>>) : [];
      for (const arg of args) {
        const value = arg.value;
        if (typeof value === 'string' && value.startsWith('__WXMP_TRACE__')) {
          try {
            void this.evidence.append('trace.event', JSON.parse(value.slice('__WXMP_TRACE__'.length)), { contextId });
          } catch {
            void this.evidence.append('trace.invalid', { value }, { contextId });
          }
        }
      }
    }
    void this.evidence.append(`cdp.event.${method || 'unknown'}`, params, { contextId });
  }

  onRaw(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  onContext(listener: ContextListener): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  disconnect(reason = 'runtime disconnected'): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new WxmpError('SESSION_DISCONNECTED', reason, { id }));
    }
    this.pending.clear();
    for (const context of this.contexts.values()) {
      for (const listener of this.contextListeners) listener('remove', { id: context.id, name: context.name, kind: context.kind });
    }
    this.contexts.clear();
    this.scripts.clear();
    this.requests.clear();
    this.lastPaused = null;
    this.traceActive = false;
  }

  close(reason = 'session closed'): void {
    this.disconnect(reason);
    this.rawListeners.clear();
    this.contextListeners.clear();
  }
}

export function extractRemoteValue(response: Record<string, unknown>): unknown {
  const result = response.result;
  if (!result || typeof result !== 'object') return undefined;
  const remote = (result as Record<string, unknown>).result;
  if (!remote || typeof remote !== 'object') return undefined;
  const record = remote as Record<string, unknown>;
  if ('value' in record) return record.value;
  if ('unserializableValue' in record) return record.unserializableValue;
  return undefined;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]));
}
