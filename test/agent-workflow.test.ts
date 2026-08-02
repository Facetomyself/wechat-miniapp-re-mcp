import test from 'node:test';
import assert from 'node:assert/strict';
import { WxmpApp } from '../src/app.js';
import { WxmpSession } from '../src/sessions/manager.js';
import { AgentWorkflow } from '../src/workflows/agent.js';
import { TargetProcess } from '../src/types.js';

const target: TargetProcess = {
  pid: 4242,
  ppid: 1,
  executablePath: 'C:\\fixture\\WeChatAppEx.exe',
  commandLine: 'WeChatAppEx.exe --type=browser',
  version: 20079,
  processType: 'browser',
  renderType: null,
  appId: 'wxfixture',
  isMain: true,
};

test('agent open does not repeat the attach wait and returns an exact continuation', async () => {
  const newlyAttached = waitingSession('session-new');
  let attachCalls = 0;
  let waitCalls = 0;
  const newSessionApp = mockApp({
    listTargets: async () => [target],
    list: () => [],
    attach: async () => { attachCalls += 1; return newlyAttached; },
    waitForRuntime: async () => { waitCalls += 1; return {}; },
  });
  const opened = await new AgentWorkflow(newSessionApp).open({ connectTimeoutMs: 1 });
  assert.equal(attachCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(opened.state, 'needs_user_action');
  assert.equal(opened.resumeTool, 'wxmp_open');
  assert.deepEqual(opened.resumeArguments, { session_id: 'session-new' });

  const existing = waitingSession('session-existing');
  const existingSessionApp = mockApp({
    get: () => existing,
    waitForRuntime: async () => { waitCalls += 1; return {}; },
  });
  await new AgentWorkflow(existingSessionApp).open({ sessionId: existing.id, connectTimeoutMs: 1 });
  assert.equal(waitCalls, 1);
});

function waitingSession(id: string): WxmpSession {
  return { id, state: 'waiting_for_runtime', target } as WxmpSession;
}

function mockApp(overrides: Record<string, unknown>): WxmpApp {
  const sessions = {
    listTargets: async () => [],
    list: () => [],
    get: () => waitingSession('session-default'),
    attach: async () => waitingSession('session-attached'),
    waitForRuntime: async () => ({}),
    bridge: { isConnected: () => false },
    publicStatus: (session: WxmpSession) => ({ id: session.id, state: session.state }),
    contextGraph: (sessionId: string) => ({ sessionId }),
    ...overrides,
  };
  return { sessions } as unknown as WxmpApp;
}
