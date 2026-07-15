import { WxmpApp } from '../app.js';
import { buildCloudFunctionExpression, buildReplayExpression, buildWxApiExpression } from '../runtime/expressions.js';
import { buildTraceScript } from '../runtime/trace-script.js';
import { buildWxRequestHookSource } from '../runtime/wx-request-hook.js';
import { bool, booleanProp, entry, escapeRegExp, numberProp, num, objectSchema, optionalText, result, safeFile, stringArray, stringProp, text } from './helpers.js';
import { ToolEntry } from './types.js';

function sessionContext(app: WxmpApp, args: Record<string, unknown>, required = true): { sessionId: string; contextId: string } {
  const sessionId = text(args, 'session_id');
  const contextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
  if (required && !contextId) throw new Error('CONTEXT_NOT_SELECTED');
  return { sessionId, contextId };
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
      await session.evidence.append('active.evaluate', { expression: text(args, 'expression'), response }, { contextId, operation: 'Runtime.evaluate' });
      return result(response);
    }),

    entry('wxmp_raw_cdp', 'Send an arbitrary CDP method and parameters to WMPF.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional JS context.'), method: stringProp('CDP method.'), params: { type: 'object', description: 'CDP params object.', additionalProperties: true }, timeout_ms: numberProp('Timeout in milliseconds.'),
    }, ['session_id', 'method']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args, false);
      return result(await app.sessions.get(sessionId).channel.send(text(args, 'method'), (args.params ?? {}) as Record<string, unknown>, contextId, num(args, 'timeout_ms', 10_000)));
    }),

    // -- Scripts & breakpoints --
    entry('wxmp_list_scripts', 'List scripts reported by Debugger.scriptParsed.', objectSchema({
      session_id: stringProp('Session identifier.'), offset: numberProp('Pagination offset.'), limit: numberProp('Page size.'), url_filter: stringProp('Optional URL substring.'),
    }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      await session.channel.send('Debugger.enable').catch(() => undefined);
      const filter = optionalText(args, 'url_filter')?.toLowerCase();
      const all = [...session.channel.scripts.values()].filter((s) => !filter || s.url.toLowerCase().includes(filter));
      const offset = num(args, 'offset', 0); const limit = Math.min(500, num(args, 'limit', 100));
      return result({ total: all.length, items: all.slice(offset, offset + limit) });
    }),

    entry('wxmp_get_source', 'Get script source; large sources are saved as evidence artifacts.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), script_id: stringProp('CDP scriptId.'), inline_limit: numberProp('Maximum source characters returned inline.'),
    }, ['session_id', 'script_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Debugger.getScriptSource', { scriptId: text(args, 'script_id') }, contextId);
      const source = String(((response.result ?? {}) as Record<string, unknown>).scriptSource ?? '');
      const inlineLimit = num(args, 'inline_limit', 100_000);
      if (source.length <= inlineLimit) return result({ scriptId: text(args, 'script_id'), source });
      const artifactPath = await session.evidence.writeText(`script-${safeFile(text(args, 'script_id'))}.js`, source);
      return result({ scriptId: text(args, 'script_id'), length: source.length, artifactPath, preview: source.slice(0, 4000) });
    }),

    entry('wxmp_search_sources', 'Search loaded WMPF script sources and save evidence-backed matches.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), query: stringProp('Text or regular expression.'), regex: booleanProp('Treat query as regex.'), case_sensitive: booleanProp('Case-sensitive search.'), max_scripts: numberProp('Maximum scripts fetched.'), max_results: numberProp('Maximum matches.'),
    }, ['session_id', 'query']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const expr = bool(args, 'regex') ? new RegExp(text(args, 'query'), bool(args, 'case_sensitive') ? 'g' : 'gi') : new RegExp(escapeRegExp(text(args, 'query')), bool(args, 'case_sensitive') ? 'g' : 'gi');
      const maxScripts = Math.min(500, num(args, 'max_scripts', 100)); const maxResults = Math.min(5000, num(args, 'max_results', 200));
      const matches: Array<Record<string, unknown>> = [];
      for (const script of [...session.channel.scripts.values()].slice(0, maxScripts)) {
        const response = await session.channel.send('Debugger.getScriptSource', { scriptId: script.scriptId }, contextId).catch(() => null);
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
      const { sessionId, contextId } = sessionContext(app, args); const channel = app.sessions.get(sessionId).channel;
      const scriptId = optionalText(args, 'script_id');
      const response = scriptId
        ? await channel.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: num(args, 'line_number'), columnNumber: num(args, 'column_number', 0) }, condition: optionalText(args, 'condition') ?? '' }, contextId)
        : await channel.send('Debugger.setBreakpointByUrl', { lineNumber: num(args, 'line_number'), columnNumber: num(args, 'column_number', 0), url: optionalText(args, 'url'), urlRegex: optionalText(args, 'url_regex'), condition: optionalText(args, 'condition') ?? '' }, contextId);
      return result(response);
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
      session.channel.traceActive = true; await session.evidence.append('trace.started', { categories }, { contextId, operation: 'trace_start' });
      return result(response);
    }),

    entry('wxmp_trace_query', 'Query persisted trace events for a session.', objectSchema({ session_id: stringProp('Session identifier.'), offset: numberProp('Offset.'), limit: numberProp('Limit.') }, ['session_id']), async (args) => result(await app.sessions.get(text(args, 'session_id')).evidence.readEvents(num(args, 'offset', 0), Math.min(1000, num(args, 'limit', 100)), 'trace.event'))),

    entry('wxmp_trace_stop', 'Restore wrapped wx/cloud methods and stop tracing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpTrace?.stop?.() ?? {restored:false}', returnByValue: true }, contextId);
      session.channel.traceActive = false; await session.evidence.append('trace.stopped', {}, { contextId, operation: 'trace_stop' }); return result(response);
    }),

    // -- Non-CDP request hook --
    entry('wxmp_hook_wx_request', 'Inject non-destructive wrappers around wx.request, fetch, and XMLHttpRequest in the appservice context. Captures full request/response bodies and JavaScript call stacks independently of the CDP Network domain.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: buildWxRequestHookSource(), awaitPromise: true, returnByValue: true }, contextId);
      await session.evidence.append('active.wx_request_hook', response, { contextId, operation: 'wxmp_hook_wx_request' });
      return result(response);
    }),

    entry('wxmp_get_hooked_requests', 'Read captured wx.request, fetch, and XHR records drained from an active request hook, including response bodies and JS call stacks.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.drain() : []', awaitPromise: true, returnByValue: true }, contextId);
      return result(response);
    }),

    entry('wxmp_unhook_wx_request', 'Restore original wx.request, fetch, and XMLHttpRequest and release the hook buffer.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
    }, ['session_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
      const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpRequestHook?.stop?.() ?? {restored:false}', returnByValue: true }, contextId);
      await session.evidence.append('active.wx_request_unhook', response, { contextId, operation: 'wxmp_unhook_wx_request' });
      return result(response);
    }),

    // -- Network capture --
    entry('wxmp_capture_start', 'Enable the CDP Network domain and begin request indexing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), max_total_buffer_size: numberProp('CDP network buffer size.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Network.enable', { maxTotalBufferSize: num(args, 'max_total_buffer_size', 100_000_000) }, contextId)); }),

    entry('wxmp_capture_stop', 'Disable the CDP Network domain.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Network.disable', {}, contextId)); }),

    entry('wxmp_list_requests', 'List indexed network requests.', objectSchema({ session_id: stringProp('Session identifier.'), offset: numberProp('Offset.'), limit: numberProp('Limit.'), url_filter: stringProp('URL substring.') }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id')); const filter = optionalText(args, 'url_filter')?.toLowerCase();
      const all = [...session.channel.requests.values()].filter((r) => !filter || r.url.toLowerCase().includes(filter)); const offset = num(args, 'offset', 0); const limit = Math.min(500, num(args, 'limit', 100));
      return result({ total: all.length, items: all.slice(offset, offset + limit) });
    }),

    entry('wxmp_get_request', 'Get one indexed request and optionally fetch its response body.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('CDP requestId.'), include_body: booleanProp('Fetch response body.') }, ['session_id', 'request_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const requestId = text(args, 'request_id'); const request = session.channel.requests.get(requestId);
      if (!request) throw new Error('REQUEST_NOT_FOUND');
      let body: unknown; if (bool(args, 'include_body')) body = await session.channel.send('Network.getResponseBody', { requestId }, contextId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      return result({ request, body });
    }),

    entry('wxmp_get_api_inventory', 'Build a deduplicated API inventory across CDP Network requests and wx.request/fetch hooks, grouped by domain.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), include_hooks: booleanProp('Also drain the wx.request/fetch hook buffer.'),
    }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
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
        try {
          const hookResponse = await session.channel.send('Runtime.evaluate', {
            expression: 'globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.drain() : []', awaitPromise: true, returnByValue: true,
          });
          const hooked = ((hookResponse.result ?? {}) as Record<string, unknown>).result;
          if (Array.isArray(hooked)) {
            for (const record of hooked as Array<Record<string, unknown>>) {
              const url = String(record.url ?? ''); const method = String(record.method ?? 'GET');
              const status = record.response && typeof record.response === 'object' ? Number((record.response as Record<string, unknown>).status ?? 0) : undefined;
              add(url, method, 'wx.request-hook', status || undefined);
            }
          }
        } catch (_) { /* hook may not be active */ }
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

    entry('wxmp_replay_request', 'Replay an indexed request inside the WMPF runtime with optional overrides.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('Indexed requestId.'), url: stringProp('Optional URL override.'), method: stringProp('Optional method override.'), headers: { type: 'object', additionalProperties: { type: 'string' } }, body: stringProp('Optional body override.') }, ['session_id', 'request_id']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const original = session.channel.requests.get(text(args, 'request_id')); if (!original) throw new Error('REQUEST_NOT_FOUND');
      const request = { url: optionalText(args, 'url') ?? original.url, method: optionalText(args, 'method') ?? original.method, headers: (args.headers ?? original.requestHeaders) as Record<string, string>, body: args.body === undefined ? original.postData : String(args.body) };
      const response = await session.channel.send('Runtime.evaluate', { expression: buildReplayExpression(request), awaitPromise: true, returnByValue: true }, contextId, 30_000); await session.evidence.append('active.request_replay', request, { contextId, operation: 'replay_request' }); return result(response);
    }),

    // -- wx API & cloud --
    entry('wxmp_call_wx_api', 'Invoke a wx.* API in the selected runtime context.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), api: stringProp('API name without wx. prefix.'), options: { type: 'object', additionalProperties: true } }, ['session_id', 'api']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const api = text(args, 'api').replace(/^wx\./, ''); const options = args.options ?? {};
      const response = await session.channel.send('Runtime.evaluate', { expression: buildWxApiExpression(api, options), awaitPromise: true, returnByValue: true }, contextId, 30_000); await session.evidence.append('active.wx_api', { api, options }, { contextId, operation: `wx.${api}` }); return result(response);
    }),

    entry('wxmp_call_cloud_function', 'Invoke wx.cloud.callFunction with explicit name and data.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), name: stringProp('Cloud function name.'), data: { type: 'object', additionalProperties: true } }, ['session_id', 'name']), async (args) => {
      const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const call = { name: text(args, 'name'), data: args.data ?? {} };
      const response = await session.channel.send('Runtime.evaluate', { expression: buildCloudFunctionExpression(call.name, call.data), awaitPromise: true, returnByValue: true }, contextId, 60_000); await session.evidence.append('active.cloud_function', call, { contextId, operation: 'wx.cloud.callFunction' }); return result(response);
    }),

    // -- DevTools proxy --
    entry('wxmp_devtools_proxy_start', 'Expose a local Chrome DevTools WebSocket proxy for one session.', objectSchema({ session_id: stringProp('Session identifier.'), port: numberProp('Local proxy port.') }, ['session_id']), async (args) => result(await app.sessions.startProxy(text(args, 'session_id'), num(args, 'port', 62000)))),

    entry('wxmp_devtools_proxy_stop', 'Stop the optional DevTools proxy.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => { await app.sessions.stopProxy(text(args, 'session_id')); return result({ stopped: true }); }),
  ];
}
