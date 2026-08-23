import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyContextKind, contextScore, inferContextRole, selectBestContextId } from '../src/sessions/contexts.js';
import { applyTrackedCapability, refreshContextCapabilities } from '../src/sessions/capabilities.js';
import type { WxmpSession } from '../src/sessions/session.js';
import type { WmpfContext } from '../src/types.js';

function context(partial: Partial<WmpfContext> & Pick<WmpfContext, 'id'>): WmpfContext {
  return {
    name: '',
    kind: 'unknown',
    role: 'unknown',
    probeConfidence: 'unprobed',
    connectedAt: '2026-08-22T00:00:00.000Z',
    capabilities: [],
    ...partial,
  };
}

test('inferContextRole prefers appservice markers and wx presence', () => {
  assert.equal(inferContextRole(context({ id: '1', name: 'AppService' })), 'appservice');
  assert.equal(inferContextRole(context({ id: '2', contextType: 'mainContext' })), 'appservice');
  assert.equal(inferContextRole(context({ id: '3', hasWx: true })), 'appservice');
  assert.equal(inferContextRole(context({ id: '4', name: 'MiniGame' })), 'minigame');
  assert.equal(inferContextRole(context({ id: '5', envType: 'webview' })), 'webview');
  assert.equal(inferContextRole(context({ id: '6', name: 'Worker' })), 'worker');
});

test('contextScore ranks wx above appservice and webview', () => {
  assert.equal(contextScore(context({ id: 'wx', hasWx: true })), 100);
  assert.equal(contextScore(context({ id: 'app', role: 'appservice' })), 80);
  assert.equal(contextScore(context({ id: 'cfg', hasWxConfig: true })), 60);
  assert.equal(contextScore(context({ id: 'game', role: 'minigame' })), 50);
  assert.equal(contextScore(context({ id: 'web', role: 'webview' })), 30);
  assert.equal(contextScore(context({ id: 'unk' })), 0);
});

test('selectBestContextId prefers wx-capable active contexts', () => {
  const webview = context({ id: 'web', role: 'webview' });
  const appservice = context({ id: 'app', role: 'appservice' });
  const wx = context({ id: 'wx', hasWx: true, role: 'appservice' });
  const inactive = context({ id: 'dead', hasWx: true, active: false });
  assert.equal(selectBestContextId([webview, appservice, inactive, wx]), 'wx');
  assert.equal(selectBestContextId([webview, appservice]), 'app');
  assert.equal(selectBestContextId([inactive]), '');
});

test('classifyContextKind reads WMPF context names', () => {
  assert.equal(classifyContextKind('appservice'), 'miniapp');
  assert.equal(classifyContextKind('MiniGame'), 'minigame');
  assert.equal(classifyContextKind('unknown-tab'), 'unknown');
});

test('applyTrackedCapability keeps request-hook and network flags per context', () => {
  const session = {
    capabilities: {
      frida: true,
      bridge: true,
      cdp: true,
      debugger: true,
      network: false,
      wxTrace: false,
      requestHook: false,
      staticAdapter: false,
      minigameDynamic: 'unknown',
    },
    contexts: new Map<string, WmpfContext>([
      ['ctx-a', context({ id: 'ctx-a', hasWx: true, active: true })],
      ['ctx-b', context({ id: 'ctx-b', active: false })],
    ]),
    traceContextIds: new Set<string>(),
    requestHookContextIds: new Set<string>(),
    networkContextIds: new Set<string>(),
  } as unknown as WxmpSession;

  applyTrackedCapability(session, 'requestHook', true, 'ctx-a');
  applyTrackedCapability(session, 'network', true, '*');
  refreshContextCapabilities(session);
  assert.equal(session.capabilities.requestHook, true);
  assert.equal(session.capabilities.network, true);
  assert.ok(session.contexts.get('ctx-a')?.capabilities.includes('request-hook'));
  assert.ok(session.contexts.get('ctx-a')?.capabilities.includes('wx-api'));
  assert.deepEqual(session.contexts.get('ctx-b')?.capabilities, ['capability-probe']);
});
