import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateRuntimeStatic } from '../src/workflows/correlate.js';
import { AgentWorkflow } from '../src/workflows/agent.js';
import { WxmpApp } from '../src/app.js';
import type { WxmpSession } from '../src/sessions/session.js';

test('correlateRuntimeStatic joins AppID, request pathname, script file, and route', () => {
  const result = correlateRuntimeStatic({
    appId: 'wxfixture',
    scripts: [{ scriptId: 's1', url: 'https://usr/app-service.js' }],
    requests: [{ requestId: 'r1', url: 'https://api.example.com/v1/user' }],
    snapshotRoutes: ['/pages/index/index'],
    packages: [{ appId: 'wxfixture', path: 'C:\\pkgs\\wxfixture\\app.wxapkg' }],
    index: {
      root: 'C:\\restored',
      urls: ['https://api.example.com/v1/user'],
      routes: ['/pages/index/index'],
      files: ['app-service.js', 'pages/index/index.js'],
    },
  });
  const app = result.joins.find((item) => item.kind === 'appId');
  const request = result.joins.find((item) => item.kind === 'request');
  const script = result.joins.find((item) => item.kind === 'script');
  const route = result.joins.find((item) => item.kind === 'route');
  assert.equal(app?.confidence, 'high');
  assert.equal(request?.confidence, 'high');
  assert.equal(script?.confidence, 'high');
  assert.equal(route?.confidence, 'high');
  assert.equal(result.summary.unmatched, 0);
});

test('correlateRuntimeStatic keeps none plus a reason when static evidence is missing', () => {
  const result = correlateRuntimeStatic({
    appId: 'wxmissing',
    scripts: [{ scriptId: 's1', url: 'https://usr/main.js' }],
    requests: [{ requestId: 'r1', url: 'https://api.example.com/secret' }],
    packages: [{ appId: 'wxother', path: 'C:\\pkgs\\wxother\\app.wxapkg' }],
  });
  assert.ok(result.joins.every((item) => item.confidence === 'none'));
  assert.ok(result.joins.every((item) => item.reason.length > 0));
  assert.equal(result.joins.find((item) => item.kind === 'appId')?.staticHit, null);
  assert.match(result.joins.find((item) => item.kind === 'request')?.reason ?? '', /No restored source index/);
});

test('AgentWorkflow.correlate feeds session scripts and requests into the joiner', async () => {
  const session = {
    id: 'session-correlate',
    projectName: 'fixture',
    target: { appId: 'wxfixture' },
    channel: {
      scripts: new Map([['s1', { scriptId: 's1', url: 'https://usr/app.js' }]]),
      requests: new Map([['r1', { requestId: 'r1', url: 'https://api.example.com/v1' }]]),
    },
    evidence: { append: async () => undefined },
  } as unknown as WxmpSession;
  const app = {
    sessions: {
      get: () => session,
    },
    staticAdapter: {
      scan: async () => [{ appId: 'wxfixture', path: 'C:\\pkgs\\wxfixture\\a.wxapkg' }],
      buildIndex: async () => ({
        root: 'C:\\restored',
        urls: ['https://api.example.com/v1'],
        routes: [],
        files: ['app.js'],
      }),
    },
  } as unknown as WxmpApp;
  const output = await new AgentWorkflow(app).correlate('session-correlate', { sourceRoot: 'C:\\restored' });
  assert.equal(output.sessionId, 'session-correlate');
  assert.equal(output.appId, 'wxfixture');
  const summary = output.summary as { requestJoins: number; scriptJoins: number; packageMatches: number };
  assert.equal(summary.packageMatches, 1);
  assert.equal(summary.requestJoins, 1);
  assert.equal(summary.scriptJoins, 1);
});
