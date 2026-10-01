import { createHash } from 'node:crypto';
import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import {
  DEFAULT_SCOPE_LIMIT,
  DEFAULT_SCOPE_MAX_BYTES,
  MAX_SCOPE_LIMIT,
  MAX_SCOPE_MAX_BYTES,
  callFrameById,
  isWasmScript,
  normalizePausedState,
  paginateProperties,
  scopeObjectId,
} from '../runtime/debugger.js';
import { extractRemoteValue } from '../transport/cdp-channel.js';
import { bool, booleanProp, entry, int, numberProp, objectSchema, optionalText, result, safeFile, stringProp, text } from './helpers.js';
import { ToolEntry } from './types.js';

function sessionContext(app: WxmpApp, args: Record<string, unknown>, required = true): { sessionId: string; contextId: string } {
  const sessionId = text(args, 'session_id');
  const contextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
  if (required && !contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'Select or provide a runtime context before invoking this tool', { sessionId });
  return { sessionId, contextId };
}

function runtimeValue(response: Record<string, unknown>, operation: string): unknown {
  const resultObject = response.result;
  if (resultObject && typeof resultObject === 'object' && (resultObject as Record<string, unknown>).exceptionDetails) {
    throw new WxmpError('RUNTIME_EVALUATION_FAILED', `${operation} raised a runtime exception`, {
      exceptionDetails: (resultObject as Record<string, unknown>).exceptionDetails,
    });
  }
  return extractRemoteValue(response);
}

export function buildDebuggerTools(app: WxmpApp): ToolEntry[] {
  return [
    entry('wxmp_get_paused_state', 'Return a normalized Debugger.paused snapshot: call frames, reason, hit breakpoints, and selected frame.', objectSchema({
      session_id: stringProp('Session identifier.'),
      selected_frame_index: numberProp('Zero-based call frame to select.'),
    }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      const selectedFrameIndex = args.selected_frame_index === undefined ? undefined : int(args, 'selected_frame_index', undefined, 0);
      const state = normalizePausedState(session.channel.lastPaused, {
        contextId: session.channel.lastPausedContextId,
        selectedFrameIndex,
        generation: session.channel.debuggerGeneration,
      });
      await session.evidence.append('debugger.paused_state', { paused: state.paused, reason: state.reason, frames: state.callFrames.length }, {
        contextId: state.contextId,
        operation: 'wxmp_get_paused_state',
      });
      return result(state);
    }),

    entry('wxmp_get_scope_variables', 'Page local/closure/object properties from a paused call-frame scope or an explicit remote objectId.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      call_frame_id: stringProp('Optional Debugger.callFrameId; defaults to the selected frame.'),
      scope_index: numberProp('Scope chain index; default 0.'),
      object_id: stringProp('Optional Runtime.RemoteObjectId override.'),
      offset: numberProp('Property pagination offset.'),
      limit: numberProp('Property page size.'),
      max_bytes: numberProp('Maximum serialized bytes returned.'),
      own_properties: booleanProp('Request own properties only.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args, false);
      const session = app.sessions.get(sessionId);
      const offset = int(args, 'offset', 0, 0);
      const limit = int(args, 'limit', DEFAULT_SCOPE_LIMIT, 1, MAX_SCOPE_LIMIT);
      const maxBytes = int(args, 'max_bytes', DEFAULT_SCOPE_MAX_BYTES, 256, MAX_SCOPE_MAX_BYTES);
      let objectId = optionalText(args, 'object_id');
      let scopeMeta: Record<string, unknown> | undefined;
      if (!objectId) {
        const paused = normalizePausedState(session.channel.lastPaused, {
          contextId: session.channel.lastPausedContextId,
          generation: session.channel.debuggerGeneration,
        });
        const frame = callFrameById(paused, optionalText(args, 'call_frame_id'));
        const scopeIndex = int(args, 'scope_index', 0, 0);
        objectId = scopeObjectId(frame, scopeIndex);
        scopeMeta = { callFrameId: frame.callFrameId, scopeIndex, scope: frame.scopeChain[scopeIndex] };
      }
      const probeContextId = contextId || session.channel.lastPausedContextId || session.selectedContextId;
      if (!probeContextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'Scope inspection requires a runtime context', { sessionId });
      const response = await session.channel.send('Runtime.getProperties', {
        objectId,
        ownProperties: bool(args, 'own_properties', true),
        generatePreview: true,
      }, probeContextId);
      const resultObject = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
      const properties = Array.isArray(resultObject.result) ? resultObject.result as unknown[] : [];
      const page = paginateProperties(properties, offset, limit, maxBytes);
      await session.evidence.append('debugger.scope_variables', { objectId, ...page, scopeMeta }, {
        contextId: probeContextId,
        operation: 'wxmp_get_scope_variables',
      });
      return result({ objectId, contextId: probeContextId, ...scopeMeta, ...page });
    }),

    entry('wxmp_evaluate_on_call_frame', 'Evaluate an expression on a paused Debugger call frame and keep frame evidence.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      expression: stringProp('JavaScript expression.'),
      call_frame_id: stringProp('Optional Debugger.callFrameId; defaults to the selected frame.'),
      return_by_value: booleanProp('Return a serializable value.'),
    }, ['session_id', 'expression']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args, false);
      const session = app.sessions.get(sessionId);
      const paused = normalizePausedState(session.channel.lastPaused, {
        contextId: session.channel.lastPausedContextId,
        generation: session.channel.debuggerGeneration,
      });
      const frame = callFrameById(paused, optionalText(args, 'call_frame_id'));
      const probeContextId = contextId || session.channel.lastPausedContextId || session.selectedContextId;
      if (!probeContextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'Call-frame evaluation requires a runtime context', { sessionId });
      const response = await session.channel.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: text(args, 'expression'),
        returnByValue: bool(args, 'return_by_value', true),
        generatePreview: true,
      }, probeContextId);
      const value = runtimeValue(response, 'Debugger.evaluateOnCallFrame');
      await session.evidence.append('debugger.evaluate_on_call_frame', {
        callFrameId: frame.callFrameId,
        expression: text(args, 'expression'),
        value,
      }, { contextId: probeContextId, operation: 'wxmp_evaluate_on_call_frame' });
      return result({ callFrameId: frame.callFrameId, contextId: probeContextId, response, value });
    }, {
      annotations: {
        title: 'Evaluate On Call Frame',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),

    entry('wxmp_list_breakpoints', 'List logical breakpoints, XHR breakpoints, and pause-on-exception state. Stale entries survive reconnect with invalid CDP IDs.', objectSchema({
      session_id: stringProp('Session identifier.'),
    }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      return result({
        generation: session.channel.debuggerGeneration,
        pauseOnExceptions: session.channel.pauseOnExceptions,
        breakpoints: [...session.channel.breakpoints.values()],
        xhrBreakpoints: [...session.channel.xhrBreakpoints.values()],
      });
    }),

    entry('wxmp_break_on_xhr', 'Set or clear a DOMDebugger XHR breakpoint by URL substring. Empty url matches all XHR.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      url: stringProp('URL substring; empty string matches all XHR.'),
      enabled: booleanProp('true to set, false to remove.'),
    }, ['session_id', 'url']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args);
      const session = app.sessions.get(sessionId);
      const url = String(args.url ?? '');
      const enabled = bool(args, 'enabled', true);
      if (enabled) {
        const response = await session.channel.send('DOMDebugger.setXHRBreakpoint', { url }, contextId);
        const existing = [...session.channel.xhrBreakpoints.values()].find((item) => item.spec.url === url);
        const record = existing ?? session.channel.registerBreakpoint({
          kind: 'xhr',
          spec: { url },
          locations: [],
          pending: false,
          status: 'bound',
        });
        record.status = 'bound';
        record.staleReason = undefined;
        await session.evidence.append('debugger.xhr_breakpoint', { url, enabled: true }, { contextId, operation: 'wxmp_break_on_xhr' });
        return result({ enabled: true, url, breakpoint: record, response });
      }
      const response = await session.channel.send('DOMDebugger.removeXHRBreakpoint', { url }, contextId);
      const existing = [...session.channel.xhrBreakpoints.values()].find((item) => item.spec.url === url);
      if (existing) session.channel.removeLogicalBreakpoint(existing.logicalId);
      await session.evidence.append('debugger.xhr_breakpoint', { url, enabled: false }, { contextId, operation: 'wxmp_break_on_xhr' });
      return result({ enabled: false, url, response });
    }, {
      annotations: {
        title: 'Break On Xhr',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),

    entry('wxmp_set_pause_on_exceptions', 'Set Debugger pause-on-exception state: none, uncaught, or all.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      state: { type: 'string', enum: ['none', 'uncaught', 'all'], description: 'Pause-on-exception mode.' },
    }, ['session_id', 'state']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args);
      const session = app.sessions.get(sessionId);
      const state = text(args, 'state') as 'none' | 'uncaught' | 'all';
      if (!['none', 'uncaught', 'all'].includes(state)) {
        throw new WxmpError('INVALID_ARGUMENT', 'state must be none, uncaught, or all');
      }
      const response = await session.channel.send('Debugger.setPauseOnExceptions', { state }, contextId);
      session.channel.pauseOnExceptions = state;
      await session.evidence.append('debugger.pause_on_exceptions', { state }, { contextId, operation: 'wxmp_set_pause_on_exceptions' });
      return result({ state, response });
    }, {
      annotations: {
        title: 'Set Pause On Exceptions',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    }),

    entry('wxmp_get_request_initiator', 'Return CDP Network initiator and/or hook call stack for one indexed request.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      request_id: stringProp('Indexed requestId.'),
    }, ['session_id', 'request_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const session = app.sessions.get(sessionId);
      const requestId = text(args, 'request_id');
      const request = session.channel.findRequest(requestId, optionalText(args, 'context_id'));
      if (!request) throw new WxmpError('REQUEST_NOT_FOUND', `Unknown request: ${requestId}`, { sessionId, requestId });
      const hookCallStack = request.transportOptions?.callStack;
      const source = request.initiator ? 'cdp' : hookCallStack ? 'hook' : 'none';
      return result({
        requestId,
        contextId: request.contextId,
        source,
        cdpInitiator: request.initiator ?? null,
        hookCallStack: hookCallStack ?? null,
      });
    }),

    entry('wxmp_list_websockets', 'List WebSocket connections observed on the CDP Network domain.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional context filter.'),
      offset: numberProp('Pagination offset.'),
      limit: numberProp('Page size.'),
    }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      const contextId = optionalText(args, 'context_id');
      const all = [...session.channel.websockets.values()].filter((item) => !contextId || !item.contextId || item.contextId === contextId);
      const offset = int(args, 'offset', 0, 0);
      const limit = int(args, 'limit', 50, 1, 200);
      return result({
        total: all.length,
        items: all.slice(offset, offset + limit).map((item) => ({
          requestId: item.requestId,
          contextId: item.contextId,
          url: item.url,
          createdAt: item.createdAt,
          closedAt: item.closedAt,
          stale: item.stale === true,
          frameCount: item.frames.length,
          droppedFrames: item.droppedFrames,
          error: item.error,
        })),
      });
    }),

    entry('wxmp_get_websocket_messages', 'Return bounded WebSocket frames for one connection. Payloads are truncated; dropped counts are preserved.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      request_id: stringProp('WebSocket requestId.'),
      offset: numberProp('Frame offset.'),
      limit: numberProp('Maximum frames returned.'),
    }, ['session_id', 'request_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const session = app.sessions.get(sessionId);
      const requestId = text(args, 'request_id');
      const socket = session.channel.findWebSocket(requestId, optionalText(args, 'context_id'));
      if (!socket) throw new WxmpError('WEBSOCKET_NOT_FOUND', `Unknown WebSocket: ${requestId}`, { sessionId, requestId });
      const offset = int(args, 'offset', 0, 0);
      const limit = int(args, 'limit', 100, 1, 200);
      return result({
        requestId: socket.requestId,
        contextId: socket.contextId,
        url: socket.url,
        stale: socket.stale === true,
        droppedFrames: socket.droppedFrames,
        total: socket.frames.length,
        items: socket.frames.slice(offset, offset + limit),
      });
    }),

    entry('wxmp_save_wasm', 'Save a WebAssembly script to the session workspace and return metadata plus artifact path. Bytecode is never inlined.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional WMPF context.'),
      script_id: stringProp('Debugger scriptId.'),
    }, ['session_id', 'script_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const session = app.sessions.get(sessionId);
      const scriptId = text(args, 'script_id');
      const script = session.channel.findScript(scriptId, optionalText(args, 'context_id'));
      if (!script || !isWasmScript(script)) {
        throw new WxmpError('WASM_NOT_FOUND', `No WebAssembly script is indexed for ${scriptId}`, { sessionId, scriptId });
      }
      const contextId = script.contextId || app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'WASM save requires a runtime context', { sessionId, scriptId });
      const bytes = await readWasmBytes(session.channel, scriptId, contextId);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const artifact = await session.evidence.writeBinary(`wasm-${safeFile(scriptId)}.wasm`, bytes);
      await session.evidence.append('debugger.wasm_saved', {
        scriptId,
        url: script.url,
        sha256,
        originalBytes: artifact.originalBytes,
        truncated: artifact.truncated,
      }, { contextId, operation: 'wxmp_save_wasm' });
      return result({
        scriptId,
        contextId,
        url: script.url,
        sha256,
        length: artifact.originalBytes,
        writtenBytes: artifact.writtenBytes,
        truncated: artifact.truncated,
        artifactPath: artifact.path,
      });
    }),
  ];
}

async function readWasmBytes(
  channel: { send: (method: string, params: Record<string, unknown>, contextId: string) => Promise<Record<string, unknown>> },
  scriptId: string,
  contextId: string,
): Promise<Buffer> {
  try {
    const response = await channel.send('Debugger.getWasmBytecode', { scriptId }, contextId);
    const bytecode = (response.result as Record<string, unknown> | undefined)?.bytecode;
    if (typeof bytecode === 'string' && bytecode) return Buffer.from(bytecode, 'base64');
  } catch {
    // Fall back to getScriptSource; some runtimes only expose one of the two methods.
  }
  const source = await channel.send('Debugger.getScriptSource', { scriptId }, contextId);
  const resultObject = source.result && typeof source.result === 'object' ? source.result as Record<string, unknown> : {};
  if (typeof resultObject.bytecode === 'string' && resultObject.bytecode) {
    return Buffer.from(resultObject.bytecode, 'base64');
  }
  const scriptSource = resultObject.scriptSource;
  if (typeof scriptSource === 'string' && scriptSource) return Buffer.from(scriptSource, 'utf8');
  throw new WxmpError('WASM_SOURCE_UNAVAILABLE', 'The runtime did not return WebAssembly bytecode', { scriptId });
}
