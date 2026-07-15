import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDynamicTools } from '../src/tools/dynamic.js';
import type { WxmpApp } from '../src/app.js';

function tool(app: WxmpApp, name: string) {
  const entry = buildDynamicTools(app).find((candidate) => candidate.tool.name === name);
  assert.ok(entry, `missing tool ${name}`);
  return entry;
}

test('hook-backed API inventory extracts Runtime.evaluate returnByValue data in the selected context', async () => {
  const sentContexts: string[] = [];
  const session = {
    channel: {
      requests: new Map(),
      send: async (_method: string, _params: unknown, contextId: string) => {
        sentContexts.push(contextId);
        return {
          id: 1,
          result: {
            result: {
              type: 'object',
              value: [{ url: 'https://api.example.test/v1/items?cursor=1', method: 'POST', response: { status: 201 } }],
            },
          },
        };
      },
    },
    evidence: { append: async () => {} },
  };
  const app = {
    sessions: {
      get: () => session,
      contextId: () => 'ctx-appservice',
    },
  } as unknown as WxmpApp;

  const response = await tool(app, 'wxmp_get_api_inventory').handler({
    session_id: 'session-1',
    context_id: 'ctx-appservice',
    include_hooks: true,
  });
  const payload = JSON.parse((response.content[0] as { type: 'text'; text: string }).text) as { data: { totalUrls: number; inventory: Array<{ host: string }> } };
  assert.equal(payload.data.totalUrls, 1);
  assert.equal(payload.data.inventory[0].host, 'api.example.test');
  assert.deepEqual(sentContexts, ['ctx-appservice']);
});

test('trace start rejects wrapped=0 instead of reporting a synthetic success', async () => {
  const capabilities: Record<string, boolean> = { wxTrace: true };
  const findings: string[] = [];
  const session = {
    channel: {
      traceActive: false,
      send: async () => ({ id: 1, result: { result: { type: 'object', value: { ok: true, wrapped: 0 } } } }),
    },
    evidence: { append: async () => {} },
  };
  const app = {
    sessions: {
      get: () => session,
      contextId: () => 'ctx-webview',
      setCapability: (_sessionId: string, key: string, value: boolean) => { capabilities[key] = value; },
      recordFinding: (_session: unknown, finding: { id: string }) => findings.push(finding.id),
      resolveFinding: () => {},
    },
  } as unknown as WxmpApp;

  await assert.rejects(
    tool(app, 'wxmp_trace_start').handler({ session_id: 'session-1', context_id: 'ctx-webview', categories: ['all'] }),
    (error: unknown) => error instanceof Error && error.message.includes('no wrappable wx APIs'),
  );
  assert.equal(capabilities.wxTrace, false);
  assert.deepEqual(findings, ['trace-target-ctx-webview']);
});

test('script source retrieval uses the context that originally reported the script', async () => {
  const sentContexts: string[] = [];
  const session = {
    channel: {
      scripts: new Map([['script-1', { scriptId: 'script-1', contextId: 'ctx-origin', url: 'app.js' }]]),
      send: async (_method: string, _params: unknown, contextId: string) => {
        sentContexts.push(contextId);
        return { id: 1, result: { scriptSource: 'const answer = 42;' } };
      },
    },
    evidence: { writeText: async () => 'artifact.js' },
  };
  const app = {
    sessions: {
      get: () => session,
      contextId: () => '',
    },
  } as unknown as WxmpApp;

  const response = await tool(app, 'wxmp_get_source').handler({ session_id: 'session-1', script_id: 'script-1' });
  const payload = JSON.parse((response.content[0] as { type: 'text'; text: string }).text) as { data: { contextId: string; source: string } };
  assert.equal(payload.data.contextId, 'ctx-origin');
  assert.equal(payload.data.source, 'const answer = 42;');
  assert.deepEqual(sentContexts, ['ctx-origin']);
});

test('large replay bodies are replaced in both value and raw CDP response', async () => {
  const body = 'x'.repeat(210_000);
  const sentContexts: string[] = [];
  const session = {
    channel: {
      requests: new Map([['request-1', {
        requestId: 'request-1', contextId: 'ctx-origin', url: 'https://api.example.test/items', method: 'GET', requestHeaders: {},
      }]]),
      send: async (_method: string, _params: unknown, contextId: string) => {
        sentContexts.push(contextId);
        return { id: 1, result: { result: { type: 'object', value: { status: 200, body } } } };
      },
    },
    evidence: {
      append: async () => {},
      writeText: async () => 'D:/fixture/replay-body.txt',
    },
  };
  const app = {
    sessions: {
      get: () => session,
      contextId: () => '',
    },
  } as unknown as WxmpApp;

  const response = await tool(app, 'wxmp_replay_request').handler({ session_id: 'session-1', request_id: 'request-1' });
  const text = (response.content[0] as { type: 'text'; text: string }).text;
  const payload = JSON.parse(text) as {
    data: { value: { body: string; bodyLength: number; truncated: boolean }; response: { result: { result: { value: { body: string } } } }; contextId: string };
  };
  assert.equal(payload.data.contextId, 'ctx-origin');
  assert.equal(payload.data.value.body.length, 4000);
  assert.equal(payload.data.value.bodyLength, body.length);
  assert.equal(payload.data.value.truncated, true);
  assert.equal(payload.data.response.result.result.value.body.length, 4000);
  assert.ok(text.length < 20_000);
  assert.deepEqual(sentContexts, ['ctx-origin']);
});
