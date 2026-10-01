import { PausedCallFrame, PausedScope, PausedState } from '../types.js';
import { WxmpError } from '../errors.js';

export const DEFAULT_SCOPE_LIMIT = 50;
export const MAX_SCOPE_LIMIT = 200;
export const DEFAULT_SCOPE_MAX_BYTES = 16 * 1024;
export const MAX_SCOPE_MAX_BYTES = 64 * 1024;
export const MAX_WEBSOCKET_FRAMES = 200;
export const MAX_WEBSOCKET_PAYLOAD_CHARS = 4096;
export const MAX_PROPERTY_PREVIEW_CHARS = 1024;

export function isWasmScript(script: { scriptLanguage?: string; url?: string }): boolean {
  const language = script.scriptLanguage?.toLowerCase() ?? '';
  if (language.includes('wasm') || language.includes('webassembly')) return true;
  const url = script.url?.toLowerCase() ?? '';
  return url.endsWith('.wasm') || url.startsWith('wasm://');
}

export function truncateChars(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

export function truncateWebSocketPayload(data: unknown): { payload: string; truncated: boolean } {
  const text = data === undefined || data === null ? '' : String(data);
  const truncated = truncateChars(text, MAX_WEBSOCKET_PAYLOAD_CHARS);
  return { payload: truncated.text, truncated: truncated.truncated };
}

export function summarizeRemoteObject(value: unknown, maxChars = MAX_PROPERTY_PREVIEW_CHARS): {
  type: string;
  preview: string;
  objectId?: string;
  truncated: boolean;
} {
  if (!value || typeof value !== 'object') {
    const preview = truncateChars(value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value), maxChars);
    return { type: typeof value, preview: preview.text, truncated: preview.truncated };
  }
  const record = value as Record<string, unknown>;
  const type = String(record.type ?? typeof value);
  const objectId = typeof record.objectId === 'string' && record.objectId ? record.objectId : undefined;
  const raw = record.value !== undefined ? stringifyPreview(record.value)
    : typeof record.description === 'string' ? record.description
      : typeof record.className === 'string' ? record.className
        : type;
  const preview = truncateChars(raw, maxChars);
  return { type, preview: preview.text, objectId, truncated: preview.truncated };
}

export function paginateProperties(
  properties: unknown[],
  offset: number,
  limit: number,
  maxBytes: number,
): {
  total: number;
  offset: number;
  limit: number;
  items: Array<Record<string, unknown>>;
  truncated: boolean;
  byteLength: number;
} {
  const sliced = properties.slice(offset, offset + limit);
  const items: Array<Record<string, unknown>> = [];
  let byteLength = 0;
  let truncated = properties.length > offset + limit;
  for (const entry of sliced) {
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : { name: String(entry) };
    const summarized = summarizeRemoteObject(record.value);
    const item = {
      name: String(record.name ?? ''),
      writable: record.writable === true,
      enumerable: record.enumerable === true,
      configurable: record.configurable === true,
      type: summarized.type,
      preview: summarized.preview,
      objectId: summarized.objectId,
      truncated: summarized.truncated,
    };
    const encoded = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (byteLength + encoded > maxBytes) {
      truncated = true;
      break;
    }
    byteLength += encoded;
    items.push(item);
  }
  return { total: properties.length, offset, limit, items, truncated, byteLength };
}

export function normalizePausedState(
  params: Record<string, unknown> | null,
  options: { contextId?: string; selectedFrameIndex?: number; generation?: number } = {},
): PausedState {
  if (!params) {
    return {
      paused: false,
      hitBreakpoints: [],
      selectedFrameIndex: 0,
      callFrames: [],
      contextId: options.contextId,
      generation: options.generation,
    };
  }
  const callFrames = Array.isArray(params.callFrames)
    ? (params.callFrames as unknown[]).map((frame, index) => normalizeCallFrame(frame, index))
    : [];
  const selectedFrameIndex = options.selectedFrameIndex ?? 0;
  if (callFrames.length > 0 && (!Number.isSafeInteger(selectedFrameIndex) || selectedFrameIndex < 0 || selectedFrameIndex >= callFrames.length)) {
    throw new WxmpError('INVALID_ARGUMENT', 'selected_frame_index is outside the current call stack', {
      selectedFrameIndex,
      frameCount: callFrames.length,
    });
  }
  const hitBreakpoints = Array.isArray(params.hitBreakpoints)
    ? (params.hitBreakpoints as unknown[]).map((item) => String(item))
    : [];
  return {
    paused: true,
    reason: params.reason === undefined ? undefined : String(params.reason),
    hitBreakpoints,
    selectedFrameIndex: callFrames.length ? selectedFrameIndex : 0,
    callFrames,
    selectedFrame: callFrames[selectedFrameIndex],
    contextId: options.contextId,
    data: params.data && typeof params.data === 'object' ? params.data as Record<string, unknown> : undefined,
    generation: options.generation,
  };
}

export function callFrameById(state: PausedState, callFrameId?: string): PausedCallFrame {
  if (!state.paused) throw new WxmpError('NOT_PAUSED', 'The debugger is not paused');
  if (callFrameId) {
    const match = state.callFrames.find((frame) => frame.callFrameId === callFrameId);
    if (!match) throw new WxmpError('CALL_FRAME_NOT_FOUND', `Unknown callFrameId: ${callFrameId}`, { callFrameId });
    return match;
  }
  if (!state.selectedFrame) throw new WxmpError('CALL_FRAME_NOT_FOUND', 'No selected call frame is available');
  return state.selectedFrame;
}

export function scopeObjectId(frame: PausedCallFrame, scopeIndex = 0): string {
  const scope = frame.scopeChain[scopeIndex];
  if (!scope) {
    throw new WxmpError('SCOPE_NOT_FOUND', `Call frame has no scope at index ${scopeIndex}`, {
      callFrameId: frame.callFrameId,
      scopeIndex,
      scopeCount: frame.scopeChain.length,
    });
  }
  if (!scope.objectId) {
    throw new WxmpError('SCOPE_OBJECT_UNAVAILABLE', 'The selected scope has no remote objectId', {
      callFrameId: frame.callFrameId,
      scopeIndex,
      scopeType: scope.type,
    });
  }
  return scope.objectId;
}

function normalizeCallFrame(value: unknown, index: number): PausedCallFrame {
  const frame = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const location = frame.location && typeof frame.location === 'object' ? frame.location as Record<string, unknown> : {};
  const scopeChain = Array.isArray(frame.scopeChain)
    ? (frame.scopeChain as unknown[]).map((item) => normalizeScope(item))
    : [];
  return {
    callFrameId: String(frame.callFrameId ?? `frame-${index}`),
    functionName: String(frame.functionName ?? ''),
    url: frame.url === undefined ? undefined : String(frame.url),
    location: {
      scriptId: String(location.scriptId ?? ''),
      lineNumber: Number(location.lineNumber ?? 0),
      columnNumber: location.columnNumber === undefined ? undefined : Number(location.columnNumber),
    },
    scopeChain,
  };
}

function normalizeScope(value: unknown): PausedScope {
  const scope = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const object = scope.object && typeof scope.object === 'object' ? scope.object as Record<string, unknown> : {};
  return {
    type: String(scope.type ?? 'unknown'),
    name: scope.name === undefined ? undefined : String(scope.name),
    objectId: typeof object.objectId === 'string' && object.objectId ? object.objectId : undefined,
  };
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
