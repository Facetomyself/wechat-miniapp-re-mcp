import { WxmpSession } from './session.js';

export type TrackedCapability = 'network' | 'wxTrace' | 'requestHook';

export function applyTrackedCapability(
  session: WxmpSession,
  capability: TrackedCapability,
  enabled: boolean,
  contextId = '',
): void {
  if (capability === 'wxTrace') {
    if (enabled && contextId) session.traceContextIds.add(contextId);
    else if (contextId) session.traceContextIds.delete(contextId);
    else if (!enabled) session.traceContextIds.clear();
    session.capabilities.wxTrace = session.traceContextIds.size > 0;
  } else if (capability === 'requestHook') {
    if (enabled && contextId) session.requestHookContextIds.add(contextId);
    else if (contextId) session.requestHookContextIds.delete(contextId);
    else if (!enabled) session.requestHookContextIds.clear();
    session.capabilities.requestHook = session.requestHookContextIds.size > 0;
  } else {
    if (enabled) session.networkContextIds.add(contextId || '*');
    else if (contextId) session.networkContextIds.delete(contextId);
    else session.networkContextIds.clear();
    session.capabilities.network = session.networkContextIds.size > 0;
  }
}

export function refreshContextCapabilities(session: WxmpSession): void {
  for (const context of session.contexts.values()) {
    const capabilities = new Set(['evaluate', 'capability-probe']);
    if (context.active === false) {
      context.capabilities = ['capability-probe'];
      continue;
    }
    if (session.capabilities.debugger) capabilities.add('debugger');
    if (session.networkContextIds.has('*') || session.networkContextIds.has(context.id)) capabilities.add('network');
    if (context.hasWx) capabilities.add('wx-api');
    if (session.traceContextIds.has(context.id) && context.hasWx) capabilities.add('wx-trace');
    if (session.requestHookContextIds.has(context.id)) capabilities.add('request-hook');
    context.capabilities = [...capabilities];
  }
}
