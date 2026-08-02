import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { buildCloudFunctionExpression, buildReplayPlan, buildWxApiExpression } from '../runtime/expressions.js';
import { buildTraceScript } from '../runtime/trace-script.js';
import { buildWxRequestHookSource } from '../runtime/wx-request-hook.js';
import { CdpChannel, extractRemoteValue } from '../transport/cdp-channel.js';
import { NetworkRecord, ScriptRecord } from '../types.js';
import { bool, booleanProp, entry, escapeRegExp, int, numberProp, objectSchema, optionalText, result, safeFile, stringArray, stringProp, text } from './helpers.js';
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

function replaceRemoteValue(response: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const outer = response.result;
  if (!outer || typeof outer !== 'object') return response;
  const remote = (outer as Record<string, unknown>).result;
  if (!remote || typeof remote !== 'object') return response;
  return {
    ...response,
    result: {
      ...(outer as Record<string, unknown>),
      result: {
        ...(remote as Record<string, unknown>),
        value,
      },
    },
  };
}

function previewRequest<T extends { postData?: string }>(request: T): T & {
  postDataLength?: number;
  postDataTruncated?: boolean;
  postDataArtifactPath?: string;
} {
  if (typeof request.postData !== 'string' || request.postData.length <= 4000) return request;
  return {
    ...request,
    postData: request.postData.slice(0, 4000),
    postDataLength: request.postData.length,
    postDataTruncated: true,
  };
}

function indexedScript(channel: CdpChannel, scriptId: string, contextId?: string): ScriptRecord | null {
  if (typeof channel.findScript === 'function') return channel.findScript(scriptId, contextId);
  return channel.scripts.get(scriptId) ?? [...channel.scripts.values()].find((script) => script.scriptId === scriptId) ?? null;
}

function indexedRequest(channel: CdpChannel, requestId: string, contextId?: string): NetworkRecord | null {
  if (typeof channel.findRequest === 'function') return channel.findRequest(requestId, contextId);
  return channel.requests.get(requestId) ?? [...channel.requests.values()].find((request) => request.requestId === requestId) ?? null;
}

function indexHookRecords(channel: CdpChannel, records: Array<Record<string, unknown>>, contextId: string): void {
  if (typeof channel.indexHookRecords === 'function') channel.indexHookRecords(records, contextId);
}

export function buildDynamicTools(app: WxmpApp): ToolEntry[] {
  return [
    // -- Evaluate & raw CDP --
    entry('wxmp_evaluate', 'Evaluate JavaScript in a selected WMPF context.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional JS context.'), expression: stringProp('JavaScript expression.'), await_promise: booleanProp('Await Promise results.'), return_by_value: booleanProp('Return serializable value.'),
    }, ['session_id', 'expression']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args);
      const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', {
        expression: text(args, 'expression'), awaitPromise: bool(args, 'await_promise', true), returnByValue: bool(args, 'return_by_value', true), includeCommandLineAPI: true,
      }, contextId);
      const value = runtimeValue(response, 'Runtime.evaluate');
      await session.evidence.append('active.evaluate', { expression: text(args, 'expression'), response }, { contextId, operation: 'Runtime.evaluate' });
      return result({ response, value });
    }),

    entry('wxmp_raw_cdp', 'Send an arbitrary CDP method and parameters to WMPF.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional JS context.'), method: stringProp('CDP method.'), params: { type: 'object', description: 'CDP params object.', additionalProperties: true }, timeout_ms: numberProp('Timeout in milliseconds.'),
    }, ['session_id', 'method']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args, false);
      return result(await app.sessions.get(sessionId).channel.send(text(args, 'method'), (args.params ?? {}) as Record<string, unknown>, contextId, int(args, 'timeout_ms', 10_000, 1, 120_000)));
    }),

    // -- Scripts & breakpoints --
    entry('wxmp_list_scripts', 'List scripts reported by Debugger.scriptParsed.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context filter.'), offset: numberProp('Pagination offset.'), limit: numberProp('Page size.'), url_filter: stringProp('Optional URL substring.'),
    }, ['session_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const session = app.sessions.get(sessionId);
      const filter = optionalText(args, 'url_filter')?.toLowerCase();
      const contextId = optionalText(args, 'context_id');
      const selectedContextId = app.sessions.contextId(sessionId, contextId);
      await session.channel.send('Debugger.enable', {}, selectedContextId).catch(() => undefined);
      const all = [...session.channel.scripts.values()].filter((s) => (
        (!filter || s.url.toLowerCase().includes(filter)) && (!contextId || !s.contextId || s.contextId === contextId)
      ));
      const offset = int(args, 'offset', 0, 0); const limit = int(args, 'limit', 100, 1, 500);
      return result({ total: all.length, items: all.slice(offset, offset + limit) });
    }),

    entry('wxmp_get_source', 'Get script source; large sources are saved as evidence artifacts.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), script_id: stringProp('CDP scriptId.'), inline_limit: numberProp('Maximum source characters returned inline.'),
    }, ['session_id', 'script_id']), async (args) => {
      const sessionId = text(args, 'session_id'); const session = app.sessions.get(sessionId); const scriptId = text(args, 'script_id');
      const selectedContextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      const contextId = indexedScript(session.channel, scriptId, optionalText(args, 'context_id'))?.contextId || selectedContextId;
      if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'The script is not associated with a runtime context and no context is selected', { sessionId, scriptId });
      const response = await session.channel.send('Debugger.getScriptSource', { scriptId }, contextId);
      const source = String(((response.result ?? {}) as Record<string, unknown>).scriptSource ?? '');
      const inlineLimit = int(args, 'inline_limit', 100_000, 1, 1_000_000);
      if (source.length <= inlineLimit) return result({ scriptId, contextId, source });
      const artifactPath = await session.evidence.writeText(`script-${safeFile(scriptId)}.js`, source);
      return result({ scriptId, contextId, length: source.length, artifactPath, preview: source.slice(0, 4000) });
    }),

    entry('wxmp_search_sources', 'Search loaded WMPF script sources and save evidence-backed matches.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), query: stringProp('Text or regular expression.'), regex: booleanProp('Treat query as regex.'), case_sensitive: booleanProp('Case-sensitive search.'), max_scripts: numberProp('Maximum scripts fetched.'), max_results: numberProp('Maximum matches.'),
    }, ['session_id', 'query']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      let expr: RegExp;
      try {
        expr = bool(args, 'regex') ? new RegExp(text(args, 'query'), bool(args, 'case_sensitive') ? 'g' : 'gi') : new RegExp(escapeRegExp(text(args, 'query')), bool(args, 'case_sensitive') ? 'g' : 'gi');
      } catch (error) {
        throw new WxmpError('INVALID_REGEX', 'Source search regular expression is invalid', { message: error instanceof Error ? error.message : String(error) });
      }
      const maxScripts = int(args, 'max_scripts', 100, 1, 500); const maxResults = int(args, 'max_results', 200, 1, 5000);
      const matches: Array<Record<string, unknown>> = [];
      for (const script of [...session.channel.scripts.values()].filter((item) => !contextId || !item.contextId || item.contextId === contextId).slice(0, maxScripts)) {
        const response = await session.channel.send('Debugger.getScriptSource', { scriptId: script.scriptId }, script.contextId || contextId).catch(() => null);
        if (!response) continue;
        const source = String((((response.result ?? {}) as Record<string, unknown>).scriptSource) ?? '');
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < maxResults; i++) { expr.lastIndex = 0; if (expr.test(lines[i])) matches.push({ scriptId: script.scriptId, url: script.url, line: i + 1, text: lines[i].slice(0, 1000) }); }
        if (matches.length >= maxResults) break;
      }
      const artifactPath = await session.evidence.writeJson(`source-search-${Date.now()}.json`, { query: text(args, 'query'), matches });
      return result({ count: matches.length, matches: matches.slice(0, 100), artifactPath });
    }),

    entry('wxmp_set_breakpoint', 'Set a breakpoint by script location, URL, or URL regex.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), script_id: stringProp('Optional scriptId.'), url: stringProp('Optional exact URL.'), url_regex: stringProp('Optional URL regex.'), line_number: numberProp('Zero-based line.'), column_number: numberProp('Zero-based column.'), condition: stringProp('Optional condition.'),
    }, ['session_id', 'line_number']), async (args) => {
      const sessionId = text(args, 'session_id'); const session = app.sessions.get(sessionId); const channel = session.channel;
      const scriptId = optionalText(args, 'script_id');
      const url = optionalText(args, 'url');
      const urlRegex = optionalText(args, 'url_regex');
      if (!scriptId && !url && !urlRegex) throw new WxmpError('INVALID_ARGUMENT', 'Provide script_id, url, or url_regex for the breakpoint');
      const selectedContextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      const contextId = scriptId ? indexedScript(channel, scriptId, optionalText(args, 'context_id'))?.contextId || selectedContextId : selectedContextId;
      if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'The breakpoint target is not associated with a runtime context and no context is selected', { sessionId, scriptId });
      const response = scriptId
        ? await channel.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: int(args, 'line_number', undefined, 0), columnNumber: int(args, 'column_number', 0, 0) }, condition: optionalText(args, 'condition') ?? '' }, contextId)
        : await channel.send('Debugger.setBreakpointByUrl', { lineNumber: int(args, 'line_number', undefined, 0), columnNumber: int(args, 'column_number', 0, 0), ...(url ? { url } : {}), ...(urlRegex ? { urlRegex } : {}), condition: optionalText(args, 'condition') ?? '' }, contextId);
      const responseResult = response.result as Record<string, unknown> | undefined;
      const locations = Array.isArray(responseResult?.locations)
        ? (response.result as Record<string, unknown>).locations as unknown[]
        : responseResult?.actualLocation ? [responseResult.actualLocation] : [];
      const pending = !scriptId && locations.length === 0;
      await session.evidence.append('debugger.breakpoint_set', { response, boundLocations: locations.length, pending }, { contextId, operation: 'set_breakpoint' });
      return result({ response, contextId, boundLocations: locations.length, pending });
    }),

    entry('wxmp_remove_breakpoint', 'Remove a CDP breakpoint by identifier.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), breakpoint_id: stringProp('Breakpoint identifier.') }, ['session_id', 'breakpoint_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.removeBreakpoint', { breakpointId: text(args, 'breakpoint_id') }, contextId));
    }),

    entry('wxmp_pause_info', 'Return the latest Debugger.paused payload.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.get(text(args, 'session_id')).channel.lastPaused)),

    entry('wxmp_step_over', 'Invoke Debugger.stepOver.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.stepOver', {}, contextId)); }),
    entry('wxmp_step_into', 'Invoke Debugger.stepInto.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.stepInto', {}, contextId)); }),
    entry('wxmp_step_out', 'Invoke Debugger.stepOut.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.stepOut', {}, contextId)); }),
    entry('wxmp_resume', 'Invoke Debugger.resume.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.resume', {}, contextId)); }),
    entry('wxmp_pause', 'Invoke Debugger.pause.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.pause', {}, contextId)); }),

    // -- Trace --
    entry('wxmp_trace_start', 'Inject reversible tracing for wx.*, cloud, storage, navigation, and network calls.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), categories: { type: 'array', items: { type: 'string' }, description: 'all, wx, cloud, storage, navigation, network' },
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const categories = stringArray(args, 'categories');
      const response = await session.channel.send('Runtime.evaluate', { expression: buildTraceScript(categories.length ? categories : ['all']), awaitPromise: true, returnByValue: true }, contextId);
      const value = runtimeValue(response, 'trace injection');
      const status = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const wrapped = Number(status.wrapped ?? 0);
      const reused = status.reused === true;
      if (!reused && (!Number.isSafeInteger(wrapped) || wrapped <= 0)) {
        app.sessions.setCapability(sessionId, 'wxTrace', false, contextId);
        app.sessions.recordFinding(session, {
          id: `trace-target-${contextId}`,
          title: 'Trace target exposes no wrappable wx APIs',
          severity: 'medium',
          summary: 'The selected context completed trace injection with wrapped=0; select or probe an AppService context.',
          evidenceTypes: ['trace.unavailable'],
        });
        await session.evidence.append('trace.unavailable', { categories, response, value }, { contextId, operation: 'trace_start' });
        throw new WxmpError('TRACE_TARGET_UNAVAILABLE', 'The selected context exposes no wrappable wx APIs', { contextId, value });
      }
      session.channel.traceActive = true;
      app.sessions.setCapability(sessionId, 'wxTrace', true, contextId);
      app.sessions.resolveFinding(session, `trace-target-${contextId}`);
      await session.evidence.append('trace.started', { categories, wrapped, reused }, { contextId, operation: 'trace_start' });
      return result({ response, value });
    }),

    entry('wxmp_trace_query', 'Query persisted trace events for a session.', objectSchema({ session_id: stringProp('Session identifier.'), offset: numberProp('Offset.'), limit: numberProp('Limit.') }, ['session_id']), async (args) => result(await app.sessions.get(text(args, 'session_id')).evidence.readEvents(int(args, 'offset', 0, 0), int(args, 'limit', 100, 1, 1000), 'trace.event'))),

    entry('wxmp_trace_stop', 'Restore wrapped wx/cloud methods and stop tracing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpTrace?.stop?.() ?? {restored:false}', returnByValue: true }, contextId);
      const value = runtimeValue(response, 'trace stop');
      session.channel.traceActive = false;
      app.sessions.setCapability(sessionId, 'wxTrace', false, contextId);
      await session.evidence.append('trace.stopped', { value }, { contextId, operation: 'trace_stop' });
      return result({ response, value });
    }),

    // -- Non-CDP request hook --
    entry('wxmp_hook_wx_request', 'Inject non-destructive wrappers around wx.request, fetch, and XMLHttpRequest in the appservice context. Captures bounded request/response body previews and JavaScript call stacks independently of the CDP Network domain.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: buildWxRequestHookSource(), awaitPromise: true, returnByValue: true }, contextId);
      const value = runtimeValue(response, 'request hook injection');
      const status = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const installed = Array.isArray(status.installed) ? status.installed : [];
      if (status.reused !== true && installed.length === 0) {
        app.sessions.setCapability(sessionId, 'requestHook', false, contextId);
        throw new WxmpError('REQUEST_HOOK_TARGET_UNAVAILABLE', 'The selected context exposes no supported request API', { contextId, value });
      }
      app.sessions.setCapability(sessionId, 'requestHook', true, contextId);
      await session.evidence.append('active.wx_request_hook', { value }, { contextId, operation: 'wxmp_hook_wx_request' });
      return result({ response, value });
    }),

    entry('wxmp_get_hooked_requests', 'Read captured wx.request, fetch, and XHR records without consuming the active hook buffer.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), cursor: numberProp('Exclusive hook cursor; omit or use 0 for the oldest buffered record.'), limit: numberProp('Maximum records returned.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const cursor = int(args, 'cursor', 0, 0);
      const limit = int(args, 'limit', 100, 1, 200);
      const expression = `globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.peek(${cursor},${limit}) : {records:[],nextCursor:${cursor},oldestCursor:0,latestCursor:0,dropped:0,active:false}`;
      const response = await session.channel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, contextId);
      const value = runtimeValue(response, 'request hook peek');
      const capture = Array.isArray(value)
        ? { records: value, nextCursor: cursor, oldestCursor: 0, latestCursor: cursor, dropped: 0, legacy: true }
        : value && typeof value === 'object' ? value as Record<string, unknown> : { records: [] };
      const records = Array.isArray(capture.records) ? capture.records as Array<Record<string, unknown>> : [];
      indexHookRecords(session.channel, records, contextId);
      await session.evidence.append('request_hook.peeked', { count: records.length, cursor, nextCursor: capture.nextCursor, dropped: capture.dropped }, { contextId, operation: 'wxmp_get_hooked_requests' });
      const encoded = JSON.stringify(records);
      if (encoded.length > 200_000) {
        const artifactPath = await session.evidence.writeJson(`hooked-requests-${Date.now()}.json`, records);
        return result({ ...capture, count: records.length, records: records.slice(0, 10), artifactPath, truncated: true });
      }
      return result({ ...capture, count: records.length, records, truncated: false });
    }),

    entry('wxmp_unhook_wx_request', 'Restore original wx.request, fetch, and XMLHttpRequest and release the hook buffer.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpRequestHook?.stop?.() ?? {restored:false}', returnByValue: true }, contextId);
      const value = runtimeValue(response, 'request hook stop');
      app.sessions.setCapability(sessionId, 'requestHook', false, contextId);
      await session.evidence.append('active.wx_request_unhook', { value }, { contextId, operation: 'wxmp_unhook_wx_request' });
      return result({ response, value });
    }),

    // -- Network capture --
    entry('wxmp_capture_start', 'Enable the CDP Network domain and begin request indexing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), max_total_buffer_size: numberProp('CDP network buffer size.') }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args);
      const response = await app.sessions.get(sessionId).channel.send('Network.enable', { maxTotalBufferSize: int(args, 'max_total_buffer_size', 100_000_000, 1, 1_000_000_000) }, contextId);
      app.sessions.setCapability(sessionId, 'network', true, contextId);
      return result(response);
    }),

    entry('wxmp_capture_stop', 'Disable the CDP Network domain.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args);
      const response = await app.sessions.get(sessionId).channel.send('Network.disable', {}, contextId);
      app.sessions.setCapability(sessionId, 'network', false, contextId);
      return result(response);
    }),

    entry('wxmp_list_requests', 'List indexed network requests.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context filter.'), offset: numberProp('Offset.'), limit: numberProp('Limit.'), url_filter: stringProp('URL substring.') }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id')); const filter = optionalText(args, 'url_filter')?.toLowerCase(); const contextId = optionalText(args, 'context_id');
      const all = [...session.channel.requests.values()].filter((r) => (!filter || r.url.toLowerCase().includes(filter)) && (!contextId || !r.contextId || r.contextId === contextId)); const offset = int(args, 'offset', 0, 0); const limit = int(args, 'limit', 100, 1, 500);
      return result({ total: all.length, items: all.slice(offset, offset + limit).map((request) => previewRequest(request)) });
    }),

    entry('wxmp_get_request', 'Get one indexed request and optionally fetch its response body.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('CDP requestId.'), include_body: booleanProp('Fetch response body.') }, ['session_id', 'request_id']), async (args) => {
      const sessionId = text(args, 'session_id'); const session = app.sessions.get(sessionId); const requestId = text(args, 'request_id'); const request = indexedRequest(session.channel, requestId, optionalText(args, 'context_id'));
      if (!request) throw new WxmpError('REQUEST_NOT_FOUND', `Unknown request: ${requestId}`, { sessionId, requestId });
      const requestContextId = request.contextId || app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      if (!requestContextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'The request is not associated with a runtime context and no context is selected', { sessionId, requestId });
      let body: unknown;
      if (bool(args, 'include_body')) {
        body = request.transport === 'cdp'
          ? await session.channel.send('Network.getResponseBody', { requestId }, requestContextId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
          : { result: { body: request.transportOptions?.responseBody, recordedBy: 'wxmpRequestHook' } };
      }
      if (body && typeof body === 'object') {
        const resultBody = (body as Record<string, unknown>).result;
        const bodyText = resultBody && typeof resultBody === 'object' ? (resultBody as Record<string, unknown>).body : undefined;
        if (typeof bodyText === 'string' && bodyText.length > 200_000) {
          const artifactPath = await session.evidence.writeText(`response-${safeFile(requestId)}.txt`, bodyText);
          body = {
            ...(body as Record<string, unknown>),
            result: {
              ...(resultBody as Record<string, unknown>),
              body: bodyText.slice(0, 4000),
              bodyLength: bodyText.length,
              artifactPath,
              truncated: true,
            },
          };
        }
      }
      let outputRequest = previewRequest(request);
      if (typeof request.postData === 'string' && request.postData.length > 200_000) {
        const artifactPath = await session.evidence.writeText(`request-${safeFile(requestId)}.txt`, request.postData);
        outputRequest = { ...outputRequest, postDataArtifactPath: artifactPath };
      }
      return result({ request: outputRequest, body });
    }),

    entry('wxmp_get_api_inventory', 'Build a deduplicated API inventory across CDP Network requests and wx.request/fetch/XMLHttpRequest hooks, grouped by domain.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), include_hooks: booleanProp('Also read the wx.request/fetch hook buffer without consuming it.'),
    }, ['session_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const session = app.sessions.get(sessionId);
      const contextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      const urls = new Map<string, { methods: Set<string>; resourceTypes: Set<string>; statusCodes: number[] }>();
      const add = (url: string, method: string, resourceType: string, status?: number) => {
        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
        let normalized = url;
        try { const u = new URL(url); normalized = `${u.origin}${u.pathname}`; } catch (_) { /* keep original */ }
        const entry = urls.get(normalized) || { methods: new Set<string>(), resourceTypes: new Set<string>(), statusCodes: [] };
        entry.methods.add(method.toUpperCase());
        if (resourceType) entry.resourceTypes.add(resourceType);
        if (status !== undefined) entry.statusCodes.push(status);
        urls.set(normalized, entry);
      };
      // CDP Network
      for (const req of session.channel.requests.values()) {
        add(req.url, req.method, req.resourceType ?? 'unknown', req.response?.status);
      }
      // wx.request hook
      if (bool(args, 'include_hooks')) {
        if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'Hook inventory requires a selected runtime context', { sessionId });
        try {
          const hookResponse = await session.channel.send('Runtime.evaluate', {
            expression: 'globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.peek(0,200) : {records:[]}', awaitPromise: true, returnByValue: true,
          }, contextId);
          const hookCapture = runtimeValue(hookResponse, 'request hook inventory peek');
          const hooked = Array.isArray(hookCapture)
            ? hookCapture as Array<Record<string, unknown>>
            : hookCapture && typeof hookCapture === 'object' && Array.isArray((hookCapture as Record<string, unknown>).records)
              ? (hookCapture as Record<string, unknown>).records as Array<Record<string, unknown>>
              : [];
          indexHookRecords(session.channel, hooked, contextId);
          if (hooked.length) {
            for (const record of hooked) {
              const url = String(record.url ?? ''); const method = String(record.method ?? 'GET');
              const status = record.response && typeof record.response === 'object' ? Number((record.response as Record<string, unknown>).status ?? 0) : undefined;
              add(url, method, 'wx.request-hook', status || undefined);
            }
          }
        } catch (error) {
          await session.evidence.append('api.inventory_hook_gap', { error: error instanceof Error ? error.message : String(error) }, { contextId });
        }
      }
      // Build inventory
      const domains = new Map<string, Array<{ path: string; methods: string[]; resourceTypes: string[]; lastStatus?: number }>>();
      for (const [url, entry] of urls) {
        try {
          const host = new URL(url).host || 'unknown';
          const items = domains.get(host) || [];
          items.push({
            path: new URL(url).pathname || '/',
            methods: [...entry.methods].sort(),
            resourceTypes: [...entry.resourceTypes].sort(),
            lastStatus: entry.statusCodes.length ? entry.statusCodes[entry.statusCodes.length - 1] : undefined,
          });
          domains.set(host, items);
        } catch (_) { /* skip malformed */ }
      }
      const inventory = [...domains.entries()].map(([host, items]) => ({ host, endpoints: items.length, items: items.slice(0, 100) }));
      await session.evidence.append('api.inventory', { totalUrls: urls.size, domains: inventory.length }, { operation: 'wxmp_get_api_inventory' });
      return result({ totalUrls: urls.size, domains: inventory.length, inventory: inventory.slice(0, 20) });
    }),

    entry('wxmp_replay_request', 'Replay an indexed request using the original application transport when known; reports semantic downgrade when CDP-only evidence falls back to fetch.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('Indexed requestId.'), url: stringProp('Optional URL override.'), method: stringProp('Optional method override.'), headers: { type: 'object', additionalProperties: { type: 'string' } }, body: stringProp('Optional body override.'), transport: { enum: ['wx.request', 'fetch', 'xhr', 'cdp'], description: 'Optional replay transport override.' } }, ['session_id', 'request_id']), async (args) => {
      const sessionId = text(args, 'session_id'); const session = app.sessions.get(sessionId); const requestId = text(args, 'request_id'); const original = indexedRequest(session.channel, requestId, optionalText(args, 'context_id')); if (!original) throw new WxmpError('REQUEST_NOT_FOUND', `Unknown request: ${requestId}`, { sessionId, requestId });
      const request = { url: optionalText(args, 'url') ?? original.url, method: optionalText(args, 'method') ?? original.method, headers: (args.headers ?? original.requestHeaders) as Record<string, string>, body: args.body === undefined ? original.postData : String(args.body), transport: original.transport };
      const replayContextId = original.contextId || app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
      if (!replayContextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'The request is not associated with a runtime context and no context is selected', { sessionId, requestId });
      const requestedTransport = (optionalText(args, 'transport') ?? original.transport) as typeof original.transport;
      const replay = buildReplayPlan(request, requestedTransport);
      const response = await session.channel.send('Runtime.evaluate', { expression: replay.expression, awaitPromise: true, returnByValue: true }, replayContextId, 30_000);
      const value = runtimeValue(response, 'request replay');
      let outputValue = value;
      let outputResponse = response;
      if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).body === 'string') {
        const body = (value as Record<string, unknown>).body as string;
        if (body.length > 200_000) {
          const artifactPath = await session.evidence.writeText(`replay-${safeFile(requestId)}-${Date.now()}.txt`, body);
          outputValue = { ...(value as Record<string, unknown>), body: body.slice(0, 4000), bodyLength: body.length, artifactPath, truncated: true };
          outputResponse = replaceRemoteValue(response, outputValue);
        }
      }
      await session.evidence.append('active.request_replay', { request, replay, result: outputValue }, { contextId: replayContextId, operation: 'replay_request' });
      return result({ response: outputResponse, value: outputValue, contextId: replayContextId, requestedTransport: replay.requestedTransport, usedTransport: replay.usedTransport, semanticDowngrade: replay.semanticDowngrade });
    }),

    // -- wx API & cloud --
    entry('wxmp_call_wx_api', 'Invoke a wx.* API in the selected runtime context.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), api: stringProp('API name without wx. prefix.'), options: { type: 'object', additionalProperties: true } }, ['session_id', 'api']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const api = text(args, 'api').replace(/^wx\./, ''); const options = args.options ?? {};
      const response = await session.channel.send('Runtime.evaluate', { expression: buildWxApiExpression(api, options), awaitPromise: true, returnByValue: true }, contextId, 30_000); const value = runtimeValue(response, `wx.${api}`); await session.evidence.append('active.wx_api', { api, options, result: value }, { contextId, operation: `wx.${api}` }); return result({ response, value });
    }),

    entry('wxmp_call_cloud_function', 'Invoke wx.cloud.callFunction with explicit name and data.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), name: stringProp('Cloud function name.'), data: { type: 'object', additionalProperties: true } }, ['session_id', 'name']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const call = { name: text(args, 'name'), data: args.data ?? {} };
      const response = await session.channel.send('Runtime.evaluate', { expression: buildCloudFunctionExpression(call.name, call.data), awaitPromise: true, returnByValue: true }, contextId, 60_000); const value = runtimeValue(response, 'wx.cloud.callFunction'); await session.evidence.append('active.cloud_function', { ...call, result: value }, { contextId, operation: 'wx.cloud.callFunction' }); return result({ response, value });
    }),

    // -- DevTools proxy --
    entry('wxmp_devtools_proxy_start', 'Expose a local Chrome DevTools WebSocket proxy for one session.', objectSchema({ session_id: stringProp('Session identifier.'), port: numberProp('Local proxy port.') }, ['session_id']), async (args) => result(await app.sessions.startProxy(text(args, 'session_id'), int(args, 'port', 62000, 1, 65535)))),

    entry('wxmp_devtools_proxy_stop', 'Stop the optional DevTools proxy.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => { await app.sessions.stopProxy(text(args, 'session_id')); return result({ stopped: true }); }),
  ];
}
