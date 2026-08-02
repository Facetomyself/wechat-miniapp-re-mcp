import { EvidenceStore } from '../evidence/store.js';
import { CdpExecutionContext, NetworkRecord, ScriptRecord } from '../types.js';
import { WxmpError } from '../errors.js';

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type RawListener = (payload: string, contextId: string) => void;
type ContextListener = (action: 'add' | 'remove', context: CdpExecutionContext) => void;

export class CdpChannel {
  private commandId = 1000;
  private pending = new Map<number, PendingCommand>();
  private rawListeners = new Set<RawListener>();
  private contextListeners = new Set<ContextListener>();
  readonly scripts = new Map<string, ScriptRecord>();
  readonly requests = new Map<string, NetworkRecord>();
  readonly executionContexts = new Map<string, CdpExecutionContext>();
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
      if (script.scriptId) this.scripts.set(compositeKey(eventContextId, script.scriptId), script);
    } else if (method === 'Debugger.paused') {
      this.lastPaused = params;
    } else if (method === 'Debugger.resumed') {
      this.lastPaused = null;
    } else if (method === 'Network.requestWillBeSent') {
      const request = (params.request ?? {}) as Record<string, unknown>;
      const requestId = String(params.requestId ?? '');
      if (requestId) {
        this.requests.set(compositeKey(eventContextId, requestId), {
          requestId,
          contextId: eventContextId,
          url: String(request.url ?? ''),
          method: String(request.method ?? 'GET'),
          requestHeaders: normalizeHeaders(request.headers),
          postData: request.postData === undefined ? undefined : String(request.postData),
          resourceType: params.type === undefined ? undefined : String(params.type),
          timestamp: params.timestamp === undefined ? undefined : Number(params.timestamp),
          transport: 'cdp',
          transportOptions: { observedBy: 'CDP.Network' },
        });
      }
    } else if (method === 'Network.responseReceived') {
      const requestId = String(params.requestId ?? '');
      const response = (params.response ?? {}) as Record<string, unknown>;
      const existing = this.findRequestForEvent(requestId, eventContextId);
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
        const role = lowerName.includes('game') ? 'minigame' as const
          : lowerName.includes('service') || lowerName.includes('app') ? 'appservice' as const
          : lowerName.includes('webview') || lowerName.includes('render') ? 'webview' as const
          : lowerName.includes('worker') ? 'worker' as const
          : 'unknown' as const;
        const ctx: CdpExecutionContext = {
          id,
          wmpfContextId: eventContextId,
          uniqueId: context.uniqueId === undefined ? undefined : String(context.uniqueId),
          name,
          kind,
          role,
          origin,
          auxData: context.auxData && typeof context.auxData === 'object' ? context.auxData as Record<string, unknown> : undefined,
          createdAt: new Date().toISOString(),
          provenance: 'cdp.Runtime.executionContextCreated',
        };
        this.executionContexts.set(compositeKey(eventContextId, id), ctx);
        for (const listener of this.contextListeners) listener('add', ctx);
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      const id = String(params.executionContextId ?? '');
      if (id) {
        const removed = [...this.executionContexts.entries()].filter(([key, context]) => (
          context.id === id && (!eventContextId || key === compositeKey(eventContextId, id))
        ));
        for (const [key, context] of removed) {
          this.executionContexts.delete(key);
          for (const listener of this.contextListeners) listener('remove', context);
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

  onExecutionContext(listener: ContextListener): () => void {
    return this.onContext(listener);
  }

  findScript(scriptId: string, preferredContextId?: string): ScriptRecord | null {
    return findIndexed(this.scripts, scriptId, preferredContextId, 'SCRIPT_ID_AMBIGUOUS');
  }

  findRequest(requestId: string, preferredContextId?: string): NetworkRecord | null {
    return findIndexed(this.requests, requestId, preferredContextId, 'REQUEST_ID_AMBIGUOUS');
  }

  indexHookRecords(records: Array<Record<string, unknown>>, contextId: string): NetworkRecord[] {
    const indexed: NetworkRecord[] = [];
    for (const record of records) {
      const cursor = Number(record.cursor ?? record.id ?? 0);
      const requestId = typeof record.requestId === 'string' && record.requestId
        ? record.requestId
        : `hook-${Number.isSafeInteger(cursor) && cursor > 0 ? cursor : Date.now()}`;
      const type = String(record.transport ?? record.type ?? 'fetch');
      const transport: NetworkRecord['transport'] = type === 'wx.request' ? 'wx.request'
        : type === 'XMLHttpRequest' || type === 'xhr' ? 'xhr'
        : 'fetch';
      const response = record.response && typeof record.response === 'object'
        ? record.response as Record<string, unknown>
        : null;
      const item: NetworkRecord = {
        requestId,
        contextId,
        url: String(record.url ?? ''),
        method: String(record.method ?? 'GET'),
        requestHeaders: normalizeHeaders(record.headers),
        postData: record.body === undefined ? undefined : String(record.body),
        resourceType: 'Hook',
        timestamp: record.timestamp === undefined ? undefined : Number(record.timestamp),
        transport,
        transportOptions: {
          observedBy: 'wxmpRequestHook',
          bodyEncoding: record.bodyEncoding ?? 'bounded-string-preview',
          callStack: record.callStack,
          responseBody: response?.body,
        },
        hookCursor: Number.isSafeInteger(cursor) ? cursor : undefined,
        response: response ? {
          status: Number(response.status ?? 0),
          headers: normalizeHeaders(response.headers),
          statusText: response.statusText === undefined ? undefined : String(response.statusText),
          mimeType: response.mimeType === undefined ? undefined : String(response.mimeType),
        } : undefined,
      };
      this.requests.set(compositeKey(contextId, requestId), item);
      indexed.push(item);
    }
    return indexed;
  }

  disconnect(reason = 'runtime disconnected'): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new WxmpError('SESSION_DISCONNECTED', reason, { id }));
    }
    this.pending.clear();
    for (const context of this.executionContexts.values()) {
      for (const listener of this.contextListeners) listener('remove', context);
    }
    this.executionContexts.clear();
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

  private findRequestForEvent(requestId: string, contextId?: string): NetworkRecord | null {
    const exact = this.requests.get(compositeKey(contextId, requestId));
    if (exact) return exact;
    const matches = [...this.requests.values()].filter((request) => request.requestId === requestId);
    return matches.length === 1 ? matches[0] : null;
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

function compositeKey(contextId: string | undefined, id: string): string {
  return `${contextId ?? ''}\u0000${id}`;
}

function findIndexed<T extends { contextId?: string }>(
  index: Map<string, T>,
  id: string,
  preferredContextId: string | undefined,
  ambiguityCode: string,
): T | null {
  if (preferredContextId !== undefined) return index.get(compositeKey(preferredContextId, id)) ?? null;
  const matches = [...index.entries()].filter(([key]) => key.endsWith(`\u0000${id}`)).map(([, value]) => value);
  if (matches.length <= 1) return matches[0] ?? null;
  throw new WxmpError(ambiguityCode, `${id} exists in multiple WMPF contexts`, {
    id,
    contextIds: [...new Set(matches.map((item) => item.contextId ?? ''))],
  });
}
