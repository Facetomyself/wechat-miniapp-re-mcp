import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { buildTraceScript } from '../runtime/trace-script.js';
import { buildCloudFunctionExpression, buildReplayExpression, buildWxApiExpression } from '../runtime/expressions.js';
import { buildWxRequestHookSource } from '../runtime/wx-request-hook.js';
import { SignatureSpec } from '../runtime/profile.js';
import { resolveInside, safeProjectName } from '../security.js';
import { ToolEntry } from './types.js';
import { VERSION } from '../version.js';

type Schema = Record<string, unknown>;
const stringProp = (description: string): Schema => ({ type: 'string', description });
const numberProp = (description: string): Schema => ({ type: 'number', description });
const booleanProp = (description: string): Schema => ({ type: 'boolean', description });

function objectSchema(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function entry(name: string, description: string, inputSchema: Schema, handler: ToolEntry['handler']): ToolEntry {
  return { tool: { name, description, inputSchema: inputSchema as ToolEntry['tool']['inputSchema'] }, handler };
}

function text(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (!required) return '';
  throw new WxmpError('INVALID_ARGUMENT', `${key} must be a non-empty string`);
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number {
  if (args[key] === undefined && fallback !== undefined) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new WxmpError('INVALID_ARGUMENT', `${key} must be numeric`);
  return value;
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  return args[key] === undefined ? fallback : Boolean(args[key]);
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new WxmpError('INVALID_ARGUMENT', `${key} must be a string array`);
  }
  return value as string[];
}

function sessionContext(app: WxmpApp, args: Record<string, unknown>, required = true): { sessionId: string; contextId: string } {
  const sessionId = text(args, 'session_id');
  const contextId = app.sessions.contextId(sessionId, optionalText(args, 'context_id'));
  if (required && !contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'Select or provide a WMPF JavaScript context before invoking this tool', { sessionId });
  return { sessionId, contextId };
}

export function buildTools(app: WxmpApp): ToolEntry[] {
  const tools: ToolEntry[] = [];

  tools.push(entry('wxmp_health', 'Report cold-start health and lazy runtime capabilities.', objectSchema({}), async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {
      name: 'wechat-miniapp-re-mcp', version: VERSION, platform: process.platform,
      workspaceRoot: app.config.workspaceRoot, bridge: app.sessions.bridge.info(), staticAdapter: app.staticAdapter.info(),
      startupRequiresTarget: false,
    } }, null, 2) }],
  })));

  tools.push(entry('wxmp_list_targets', 'Discover PC WeChat WMPF processes and runtime metadata.', objectSchema({}), async () => result(await app.sessions.listTargets())));
  tools.push(entry('wxmp_list_sessions', 'List all MCP-managed WMPF sessions.', objectSchema({}), async () => result(app.sessions.list().map((session) => app.sessions.publicStatus(session)))));

  tools.push(entry('wxmp_attach', 'Attach Frida to a WMPF main process and wait for the local debug bridge.', objectSchema({
    pid: numberProp('Optional WeChatAppEx.exe PID; defaults to the main WMPF browser process.'),
    project_name: stringProp('Workspace project name used for evidence output.'),
    profile_path: stringProp('Optional explicit clean-room profile JSON path.'),
    connect_timeout_ms: numberProp('How long to wait for a WMPF debug WebSocket connection.'),
  }, ['project_name']), async (args) => {
    const session = await app.sessions.attach({
      pid: args.pid === undefined ? undefined : num(args, 'pid'),
      projectName: text(args, 'project_name'),
      profilePath: optionalText(args, 'profile_path'),
      connectTimeoutMs: args.connect_timeout_ms === undefined ? undefined : num(args, 'connect_timeout_ms'),
    });
    return result(app.sessions.publicStatus(session));
  }));

  tools.push(entry('wxmp_detach', 'Detach a WMPF session and release Frida, CDP, proxy, and bridge state.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => {
    const sessionId = text(args, 'session_id');
    await app.sessions.detach(sessionId);
    return result({ sessionId, state: 'closed' });
  }));

  tools.push(entry('wxmp_session_status', 'Read one session state, capabilities, contexts, and evidence path.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.publicStatus(app.sessions.get(text(args, 'session_id'))))));

  tools.push(entry('wxmp_wait_for_runtime', 'Wait for an attached or disconnected WMPF session to connect again without reinjecting Frida.', objectSchema({ session_id: stringProp('Session identifier.'), timeout_ms: numberProp('Wait timeout in milliseconds.') }, ['session_id']), async (args) => result(await app.sessions.waitForRuntime(text(args, 'session_id'), Math.min(120_000, Math.max(1, num(args, 'timeout_ms', 30_000)))))));

  tools.push(entry('wxmp_list_contexts', 'List JS contexts observed for a WMPF session.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => {
    const session = app.sessions.get(text(args, 'session_id'));
    return result({ selectedContextId: session.selectedContextId, contexts: [...session.contexts.values()] });
  }));

  tools.push(entry('wxmp_select_context', 'Select the default JS context for subsequent tools.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('WMPF JS context identifier.'),
  }, ['session_id', 'context_id']), async (args) => result(app.sessions.selectContext(text(args, 'session_id'), text(args, 'context_id')))));

  tools.push(entry('wxmp_get_runtime_info', 'Return target, profile, bridge, context, and capability information.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.publicStatus(app.sessions.get(text(args, 'session_id'))))));

  tools.push(entry('wxmp_evaluate', 'Evaluate JavaScript in a selected WMPF context.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional JS context.'), expression: stringProp('JavaScript expression.'), await_promise: booleanProp('Await Promise results.'), return_by_value: booleanProp('Return serializable value.'),
  }, ['session_id', 'expression']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args);
    const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Runtime.evaluate', {
      expression: text(args, 'expression'), awaitPromise: bool(args, 'await_promise', true), returnByValue: bool(args, 'return_by_value', true), includeCommandLineAPI: true,
    }, contextId);
    await session.evidence.append('active.evaluate', { expression: text(args, 'expression'), response }, { contextId, operation: 'Runtime.evaluate' });
    return result(response);
  }));

  tools.push(entry('wxmp_raw_cdp', 'Send an arbitrary CDP method and parameters to WMPF.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional JS context.'), method: stringProp('CDP method.'), params: { type: 'object', description: 'CDP params object.', additionalProperties: true }, timeout_ms: numberProp('Timeout in milliseconds.'),
  }, ['session_id', 'method']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args, false);
    return result(await app.sessions.get(sessionId).channel.send(text(args, 'method'), (args.params ?? {}) as Record<string, unknown>, contextId, num(args, 'timeout_ms', 10_000)));
  }));

  tools.push(entry('wxmp_list_scripts', 'List scripts reported by Debugger.scriptParsed.', objectSchema({
    session_id: stringProp('Session identifier.'), offset: numberProp('Pagination offset.'), limit: numberProp('Page size.'), url_filter: stringProp('Optional URL substring.'),
  }, ['session_id']), async (args) => {
    const session = app.sessions.get(text(args, 'session_id'));
    await session.channel.send('Debugger.enable').catch(() => undefined);
    const filter = optionalText(args, 'url_filter')?.toLowerCase();
    const all = [...session.channel.scripts.values()].filter((script) => !filter || script.url.toLowerCase().includes(filter));
    const offset = num(args, 'offset', 0); const limit = Math.min(500, num(args, 'limit', 100));
    return result({ total: all.length, items: all.slice(offset, offset + limit) });
  }));

  tools.push(entry('wxmp_get_source', 'Get script source; large sources are saved as evidence artifacts.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), script_id: stringProp('CDP scriptId.'), inline_limit: numberProp('Maximum source characters returned inline.'),
  }, ['session_id', 'script_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Debugger.getScriptSource', { scriptId: text(args, 'script_id') }, contextId);
    const source = String(((response.result ?? {}) as Record<string, unknown>).scriptSource ?? '');
    const inlineLimit = num(args, 'inline_limit', 100_000);
    if (source.length <= inlineLimit) return result({ scriptId: text(args, 'script_id'), source });
    const artifactPath = await session.evidence.writeText(`script-${safeFile(text(args, 'script_id'))}.js`, source);
    return result({ scriptId: text(args, 'script_id'), length: source.length, artifactPath, preview: source.slice(0, 4000) });
  }));

  tools.push(entry('wxmp_search_sources', 'Search loaded WMPF script sources and save evidence-backed matches.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), query: stringProp('Text or regular expression.'), regex: booleanProp('Treat query as regex.'), case_sensitive: booleanProp('Case-sensitive search.'), max_scripts: numberProp('Maximum scripts fetched.'), max_results: numberProp('Maximum matches.'),
  }, ['session_id', 'query']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const expression = bool(args, 'regex') ? new RegExp(text(args, 'query'), bool(args, 'case_sensitive') ? 'g' : 'gi') : new RegExp(escapeRegExp(text(args, 'query')), bool(args, 'case_sensitive') ? 'g' : 'gi');
    const maxScripts = Math.min(500, num(args, 'max_scripts', 100)); const maxResults = Math.min(5000, num(args, 'max_results', 200));
    const matches: Array<Record<string, unknown>> = [];
    for (const script of [...session.channel.scripts.values()].slice(0, maxScripts)) {
      const response = await session.channel.send('Debugger.getScriptSource', { scriptId: script.scriptId }, contextId).catch(() => null);
      if (!response) continue;
      const source = String((((response.result ?? {}) as Record<string, unknown>).scriptSource) ?? '');
      const lines = source.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) { expression.lastIndex = 0; if (expression.test(lines[index])) matches.push({ scriptId: script.scriptId, url: script.url, line: index + 1, text: lines[index].slice(0, 1000) }); }
      if (matches.length >= maxResults) break;
    }
    const artifactPath = await session.evidence.writeJson(`source-search-${Date.now()}.json`, { query: text(args, 'query'), matches });
    return result({ count: matches.length, matches: matches.slice(0, 100), artifactPath });
  }));

  tools.push(entry('wxmp_set_breakpoint', 'Set a breakpoint by script location, URL, or URL regex.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), script_id: stringProp('Optional scriptId.'), url: stringProp('Optional exact URL.'), url_regex: stringProp('Optional URL regex.'), line_number: numberProp('Zero-based line.'), column_number: numberProp('Zero-based column.'), condition: stringProp('Optional condition.'),
  }, ['session_id', 'line_number']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const channel = app.sessions.get(sessionId).channel;
    const scriptId = optionalText(args, 'script_id');
    const response = scriptId
      ? await channel.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: num(args, 'line_number'), columnNumber: num(args, 'column_number', 0) }, condition: optionalText(args, 'condition') ?? '' }, contextId)
      : await channel.send('Debugger.setBreakpointByUrl', { lineNumber: num(args, 'line_number'), columnNumber: num(args, 'column_number', 0), url: optionalText(args, 'url'), urlRegex: optionalText(args, 'url_regex'), condition: optionalText(args, 'condition') ?? '' }, contextId);
    return result(response);
  }));

  tools.push(entry('wxmp_remove_breakpoint', 'Remove a CDP breakpoint by identifier.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), breakpoint_id: stringProp('Breakpoint identifier.') }, ['session_id', 'breakpoint_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Debugger.removeBreakpoint', { breakpointId: text(args, 'breakpoint_id') }, contextId));
  }));
  tools.push(entry('wxmp_pause_info', 'Return the latest Debugger.paused payload.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.get(text(args, 'session_id')).channel.lastPaused)));
  for (const [name, method] of [['wxmp_step_over', 'Debugger.stepOver'], ['wxmp_step_into', 'Debugger.stepInto'], ['wxmp_step_out', 'Debugger.stepOut'], ['wxmp_resume', 'Debugger.resume'], ['wxmp_pause', 'Debugger.pause']] as const) {
    tools.push(entry(name, `Invoke ${method}.`, objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send(method, {}, contextId)); }));
  }

  tools.push(entry('wxmp_trace_start', 'Inject reversible tracing for wx.*, cloud, storage, navigation, and network calls.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), categories: { type: 'array', items: { type: 'string' }, description: 'all, wx, cloud, storage, navigation, network' },
  }, ['session_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    await session.channel.send('Runtime.enable', {}, contextId);
    const categories = stringArray(args, 'categories');
    const response = await session.channel.send('Runtime.evaluate', { expression: buildTraceScript(categories.length ? categories : ['all']), awaitPromise: true, returnByValue: true }, contextId);
    session.channel.traceActive = true; await session.evidence.append('trace.started', { categories }, { contextId, operation: 'trace_start' });
    return result(response);
  }));
  tools.push(entry('wxmp_trace_query', 'Query persisted trace events for a session.', objectSchema({ session_id: stringProp('Session identifier.'), offset: numberProp('Offset.'), limit: numberProp('Limit.') }, ['session_id']), async (args) => result(await app.sessions.get(text(args, 'session_id')).evidence.readEvents(num(args, 'offset', 0), Math.min(1000, num(args, 'limit', 100)), 'trace.event'))));
  tools.push(entry('wxmp_trace_stop', 'Restore wrapped wx/cloud methods and stop tracing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Runtime.evaluate', { expression: 'globalThis.__wxmpTrace?.stop?.() ?? {restored:false}', returnByValue: true }, contextId);
    session.channel.traceActive = false; await session.evidence.append('trace.stopped', {}, { contextId, operation: 'trace_stop' }); return result(response);
  }));

  // Non-CDP wx.request / fetch / XHR hooks (independent of Network domain)
  tools.push(entry('wxmp_hook_wx_request', 'Inject non-destructive wrappers around wx.request, fetch, and XMLHttpRequest in the appservice context. Captures full request/response bodies and JavaScript call stacks independently of the CDP Network domain.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
  }, ['session_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Runtime.evaluate', {
      expression: buildWxRequestHookSource(), awaitPromise: true, returnByValue: true,
    }, contextId);
    await session.evidence.append('active.wx_request_hook', response, { contextId, operation: 'wxmp_hook_wx_request' });
    return result(response);
  }));

  tools.push(entry('wxmp_get_hooked_requests', 'Read captured wx.request, fetch, and XHR records drained from an active request hook, including response bodies and JS call stacks.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
  }, ['session_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Runtime.evaluate', {
      expression: 'globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.drain() : []', awaitPromise: true, returnByValue: true,
    }, contextId);
    return result(response);
  }));

  tools.push(entry('wxmp_unhook_wx_request', 'Restore original wx.request, fetch, and XMLHttpRequest and release the hook buffer.', objectSchema({
    session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'),
  }, ['session_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId);
    const response = await session.channel.send('Runtime.evaluate', {
      expression: 'globalThis.__wxmpRequestHook?.stop?.() ?? {restored:false}', returnByValue: true,
    }, contextId);
    await session.evidence.append('active.wx_request_unhook', response, { contextId, operation: 'wxmp_unhook_wx_request' });
    return result(response);
  }));

  tools.push(entry('wxmp_capture_start', 'Enable the CDP Network domain and begin request indexing.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), max_total_buffer_size: numberProp('CDP network buffer size.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Network.enable', { maxTotalBufferSize: num(args, 'max_total_buffer_size', 100_000_000) }, contextId)); }));
  tools.push(entry('wxmp_capture_stop', 'Disable the CDP Network domain.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.') }, ['session_id']), async (args) => { const { sessionId, contextId } = sessionContext(app, args); return result(await app.sessions.get(sessionId).channel.send('Network.disable', {}, contextId)); }));
  tools.push(entry('wxmp_list_requests', 'List indexed network requests.', objectSchema({ session_id: stringProp('Session identifier.'), offset: numberProp('Offset.'), limit: numberProp('Limit.'), url_filter: stringProp('URL substring.') }, ['session_id']), async (args) => {
    const session = app.sessions.get(text(args, 'session_id')); const filter = optionalText(args, 'url_filter')?.toLowerCase();
    const all = [...session.channel.requests.values()].filter((request) => !filter || request.url.toLowerCase().includes(filter)); const offset = num(args, 'offset', 0); const limit = Math.min(500, num(args, 'limit', 100));
    return result({ total: all.length, items: all.slice(offset, offset + limit) });
  }));
  tools.push(entry('wxmp_get_request', 'Get one indexed request and optionally fetch its response body.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('CDP requestId.'), include_body: booleanProp('Fetch response body.') }, ['session_id', 'request_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const requestId = text(args, 'request_id'); const request = session.channel.requests.get(requestId);
    if (!request) throw new WxmpError('REQUEST_NOT_FOUND', `Unknown request ${requestId}`);
    let body: unknown; if (bool(args, 'include_body')) body = await session.channel.send('Network.getResponseBody', { requestId }, contextId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    return result({ request, body });
  }));

  tools.push(entry('wxmp_replay_request', 'Replay an indexed request inside the WMPF runtime with optional overrides.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), request_id: stringProp('Indexed requestId.'), url: stringProp('Optional URL override.'), method: stringProp('Optional method override.'), headers: { type: 'object', additionalProperties: { type: 'string' } }, body: stringProp('Optional body override.') }, ['session_id', 'request_id']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const original = session.channel.requests.get(text(args, 'request_id')); if (!original) throw new WxmpError('REQUEST_NOT_FOUND', 'Request is not indexed');
    const request = { url: optionalText(args, 'url') ?? original.url, method: optionalText(args, 'method') ?? original.method, headers: (args.headers ?? original.requestHeaders) as Record<string, string>, body: args.body === undefined ? original.postData : String(args.body) };
    const expression = buildReplayExpression(request);
    const response = await session.channel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, contextId, 30_000); await session.evidence.append('active.request_replay', request, { contextId, operation: 'replay_request' }); return result(response);
  }));

  tools.push(entry('wxmp_call_wx_api', 'Invoke a wx.* API in the selected runtime context.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), api: stringProp('API name without wx. prefix.'), options: { type: 'object', additionalProperties: true } }, ['session_id', 'api']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const api = text(args, 'api').replace(/^wx\./, ''); const options = args.options ?? {};
    const expression = buildWxApiExpression(api, options);
    const response = await session.channel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, contextId, 30_000); await session.evidence.append('active.wx_api', { api, options }, { contextId, operation: `wx.${api}` }); return result(response);
  }));
  tools.push(entry('wxmp_call_cloud_function', 'Invoke wx.cloud.callFunction with explicit name and data.', objectSchema({ session_id: stringProp('Session identifier.'), context_id: stringProp('Optional context.'), name: stringProp('Cloud function name.'), data: { type: 'object', additionalProperties: true } }, ['session_id', 'name']), async (args) => {
    const { sessionId, contextId } = sessionContext(app, args); const session = app.sessions.get(sessionId); const call = { name: text(args, 'name'), data: args.data ?? {} }; const expression = buildCloudFunctionExpression(call.name, call.data); const response = await session.channel.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, contextId, 60_000); await session.evidence.append('active.cloud_function', call, { contextId, operation: 'wx.cloud.callFunction' }); return result(response);
  }));

  tools.push(entry('wxmp_devtools_proxy_start', 'Expose a local Chrome DevTools WebSocket proxy for one session.', objectSchema({ session_id: stringProp('Session identifier.'), port: numberProp('Local proxy port.') }, ['session_id']), async (args) => result(await app.sessions.startProxy(text(args, 'session_id'), num(args, 'port', 62000)))));
  tools.push(entry('wxmp_devtools_proxy_stop', 'Stop the optional DevTools proxy.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => { await app.sessions.stopProxy(text(args, 'session_id')); return result({ stopped: true }); }));

  tools.push(entry('wxmp_scan_packages', 'Scan default or explicit package roots for .wxapkg files.', objectSchema({ roots: { type: 'array', items: { type: 'string' } }, limit: numberProp('Maximum packages.') }), async (args) => result(await app.staticAdapter.scan(stringArray(args, 'roots'), Math.min(10_000, num(args, 'limit', 1000))))));
  tools.push(entry('wxmp_unpack', 'Run the configured Gwxapkg backend for extraction without embedding it into the MCP core.', objectSchema({ input_path: stringProp('wxapkg file or package directory.'), project_name: stringProp('Workspace project.'), app_id: stringProp('Optional AppID.'), output_name: stringProp('Optional output directory name.'), extra_args: { type: 'array', items: { type: 'string' } } }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.decompile({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), appId: optionalText(args, 'app_id'), outputName: optionalText(args, 'output_name'), extraArgs: ['-restore=false', ...stringArray(args, 'extra_args')] }))));
  tools.push(entry('wxmp_decompile', 'Run full Gwxapkg restore/decompile into the controlled workspace.', objectSchema({ input_path: stringProp('wxapkg file or directory.'), project_name: stringProp('Workspace project.'), app_id: stringProp('Optional AppID.'), output_name: stringProp('Optional output directory name.'), extra_args: { type: 'array', items: { type: 'string' } } }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.decompile({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), appId: optionalText(args, 'app_id'), outputName: optionalText(args, 'output_name'), extraArgs: stringArray(args, 'extra_args') }))));
  tools.push(entry('wxmp_static_search', 'Search restored JS/WXML/WXSS/WXS/JSON sources.', objectSchema({ root: stringProp('Restored source root.'), query: stringProp('Text or regex.'), regex: booleanProp('Regex mode.'), case_sensitive: booleanProp('Case-sensitive.'), limit: numberProp('Max results.') }, ['root', 'query']), async (args) => result(await app.staticAdapter.search(text(args, 'root'), text(args, 'query'), { regex: bool(args, 'regex'), caseSensitive: bool(args, 'case_sensitive'), limit: num(args, 'limit', 200) }))));
  tools.push(entry('wxmp_build_index', 'Build URL, wx API, route, and file indexes for restored sources.', objectSchema({ root: stringProp('Restored source root.'), project_name: stringProp('Workspace project.') }, ['root', 'project_name']), async (args) => result(await app.staticAdapter.buildIndex(text(args, 'root'), text(args, 'project_name')))));
  tools.push(entry('wxmp_repack', 'Repack a controlled restored source tree with Gwxapkg.', objectSchema({ input_path: stringProp('Restored source directory.'), project_name: stringProp('Workspace project.'), output_name: stringProp('Output wxapkg filename.') }, ['input_path', 'project_name']), async (args) => result(await app.staticAdapter.repack({ inputPath: text(args, 'input_path'), projectName: text(args, 'project_name'), outputName: optionalText(args, 'output_name') }))));
  tools.push(entry('wxmp_raw_adapter', 'Invoke the configured static adapter while keeping output inside the controlled workspace.', objectSchema({ project_name: stringProp('Workspace project.'), output_name: stringProp('Optional controlled output name.'), args: { type: 'array', items: { type: 'string' } } }, ['project_name', 'args']), async (args) => result(await app.staticAdapter.raw(stringArray(args, 'args'), text(args, 'project_name'), optionalText(args, 'output_name')))));

  tools.push(entry('wxmp_detect_wmpf', 'Detect WMPF versions and process roles.', objectSchema({}), async () => result(await app.sessions.listTargets())));
  tools.push(entry('wxmp_profile_probe', 'Load and statically probe an offset profile against a WMPF module.', objectSchema({ pid: numberProp('WMPF PID.'), profile_path: stringProp('Optional profile path.') }, ['pid']), async (args) => { const targets = await app.sessions.listTargets(); const target = targets.find((item) => item.pid === num(args, 'pid')); if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target or version not found'); const loaded = await app.sessions.profileManager().load(target.version, optionalText(args, 'profile_path')); return result(await app.sessions.profileManager().probe(target, loaded.profile)); }));
  tools.push(entry('wxmp_profile_generate', 'Generate a candidate profile from explicit AOB signatures; never auto-inject candidates.', objectSchema({ pid: numberProp('WMPF PID.'), project_name: stringProp('Workspace project.'), signatures: { type: 'array', items: { type: 'object', properties: { name: { enum: ['cdpFilter', 'loadStart'] }, pattern: { type: 'string' }, adjustment: { type: 'number' } }, required: ['name', 'pattern'] } }, scene_offsets: { type: 'array', items: { type: 'number' } } }, ['pid', 'project_name', 'signatures', 'scene_offsets']), async (args) => {
    const target = (await app.sessions.listTargets()).find((item) => item.pid === num(args, 'pid')); if (!target) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
    const signatures = args.signatures as SignatureSpec[]; const sceneOffsets = (args.scene_offsets as number[]).map(Number); const profile = await app.sessions.profileManager().generate(target, signatures, sceneOffsets);
    const project = safeProjectName(text(args, 'project_name')); const dir = resolveInside(app.config.workspaceRoot, project, 'wechat-miniapp', 'profiles'); await fs.mkdir(dir, { recursive: true }); const outputPath = resolveInside(dir, `windows-${profile.wmpfVersion}-candidate.json`); await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8'); return result({ profile, outputPath, warning: 'candidate profile requires validation and runtime review' });
  }));
  tools.push(entry('wxmp_profile_validate', 'Validate profile schema, module hash, offset bounds, and injection readiness without injection.', objectSchema({ pid: numberProp('WMPF PID.'), profile_path: stringProp('Profile path.') }, ['pid', 'profile_path']), async (args) => {
    const target = (await app.sessions.listTargets()).find((item) => item.pid === num(args, 'pid'));
    if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
    const manager = app.sessions.profileManager();
    const loaded = await manager.load(target.version, text(args, 'profile_path'));
    const probe = await manager.probe(target, loaded.profile);
    let injectable = true;
    let injectionBlock: Record<string, unknown> | null = null;
    try {
      manager.assertInjectable(loaded.profile);
    } catch (error) {
      injectable = false;
      injectionBlock = error instanceof WxmpError ? { code: error.code, message: error.message, details: error.details } : { message: String(error) };
    }
    return result({ ...probe, injectable: injectable && probe.valid === true, injectionBlock });
  }));
  tools.push(entry('wxmp_profile_promote', 'Promote a hash-matched generated candidate with explicit review evidence; writes a reviewed profile inside the controlled workspace.', objectSchema({
    pid: numberProp('WMPF PID.'),
    candidate_path: stringProp('Generated candidate profile path.'),
    project_name: stringProp('Workspace project.'),
    confidence: { enum: ['medium', 'high'] },
    reviewer: stringProp('Reviewer identifier.'),
    evidence: { type: 'array', items: { type: 'string' }, minItems: 1 },
    note: stringProp('Optional review note.'),
  }, ['pid', 'candidate_path', 'project_name', 'confidence', 'reviewer', 'evidence']), async (args) => {
    const target = (await app.sessions.listTargets()).find((item) => item.pid === num(args, 'pid'));
    if (!target || !target.version) throw new WxmpError('TARGET_NOT_FOUND', 'Target not found');
    const manager = app.sessions.profileManager();
    const loaded = await manager.load(target.version, text(args, 'candidate_path'));
    const probe = await manager.probe(target, loaded.profile);
    if (probe.hashValidated !== true || probe.valid !== true) {
      throw new WxmpError('PROFILE_REVIEW_FAILED', 'Candidate must match the target module hash and pass offset bounds before promotion', probe);
    }
    const confidence = text(args, 'confidence') as 'medium' | 'high';
    if (!['medium', 'high'].includes(confidence)) throw new WxmpError('INVALID_ARGUMENT', 'confidence must be medium or high');
    const reviewEvidence = stringArray(args, 'evidence').map((item) => item.trim()).filter(Boolean);
    if (reviewEvidence.length === 0) throw new WxmpError('INVALID_ARGUMENT', 'evidence must contain at least one review reference');
    const profile = manager.promote(loaded.profile, {
      confidence,
      reviewer: text(args, 'reviewer'),
      evidence: [...reviewEvidence, `module-sha256:${String(probe.sha256)}`],
      note: optionalText(args, 'note'),
    });
    const project = safeProjectName(text(args, 'project_name'));
    const dir = resolveInside(app.config.workspaceRoot, project, 'wechat-miniapp', 'profiles');
    await fs.mkdir(dir, { recursive: true });
    const outputPath = resolveInside(dir, `windows-${profile.wmpfVersion}-reviewed-${Date.now()}.json`);
    await fs.writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    return result({ profile, outputPath, probe });
  }));

  tools.push(entry('wxmp_export_evidence', 'Export evidence manifest plus report/findings/triage artifacts for one session.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => { const session = app.sessions.get(text(args, 'session_id')); const paths = await session.evidence.exportBundle(app.sessions.publicStatus(session), session.findings); return result(paths); }));

  return tools;
}

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }, null, 2) }] };
}

function safeFile(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
