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

test('agent open uses a 30-90s runtime wait when connectTimeoutMs is omitted', async () => {
  let attachTimeout: number | undefined;
  const app = mockApp({
    listTargets: async () => [target],
    list: () => [],
    attach: async (options: { connectTimeoutMs?: number }) => {
      attachTimeout = options.connectTimeoutMs;
      return waitingSession('session-default-wait');
    },
  });
  const opened = await new AgentWorkflow(app).open({});
  assert.equal(typeof attachTimeout, 'number');
  assert.ok(attachTimeout! >= 30_000 && attachTimeout! <= 90_000);
  assert.equal(opened.sessionId, 'session-default-wait');
  assert.equal(opened.resumeTool, 'wxmp_open');
});

test('agent open forwards an explicit connect timeout to attach', async () => {
  let attachTimeout: number | undefined;
  const app = mockApp({
    listTargets: async () => [target],
    list: () => [],
    attach: async (options: { connectTimeoutMs?: number }) => {
      attachTimeout = options.connectTimeoutMs;
      return waitingSession('session-explicit');
    },
  });
  await new AgentWorkflow(app).open({ connectTimeoutMs: 7 });
  assert.equal(attachTimeout, 7);
});

test('parked session_id resume waits without attaching Frida again', async () => {
  const existing = waitingSession('session-existing');
  let attachCalls = 0;
  let waitId: string | undefined;
  let waitTimeout: number | undefined;
  const app = mockApp({
    get: () => existing,
    attach: async () => {
      attachCalls += 1;
      return existing;
    },
    waitForRuntime: async (sessionId: string, timeoutMs: number) => {
      waitId = sessionId;
      waitTimeout = timeoutMs;
      return {};
    },
    bridge: { isConnected: () => false },
  });
  const opened = await new AgentWorkflow(app).open({ sessionId: existing.id });
  assert.equal(attachCalls, 0);
  assert.equal(waitId, existing.id);
  assert.ok(waitTimeout! >= 30_000 && waitTimeout! <= 90_000);
  assert.equal(opened.sessionId, existing.id);
  assert.equal(opened.state, 'needs_user_action');
  assert.equal(opened.resumeTool, 'wxmp_open');
  assert.deepEqual(opened.resumeArguments, { session_id: existing.id });
});

test('disconnected session_id resume waits without attaching Frida again', async () => {
  const existing = waitingSession('session-disconnected');
  existing.state = 'disconnected';
  let attachCalls = 0;
  const app = mockApp({
    get: () => existing,
    attach: async () => {
      attachCalls += 1;
      return existing;
    },
    waitForRuntime: async () => ({}),
    bridge: { isConnected: () => false },
  });
  const opened = await new AgentWorkflow(app).open({ sessionId: existing.id, connectTimeoutMs: 11 });
  assert.equal(attachCalls, 0);
  assert.equal(opened.sessionId, existing.id);
  assert.equal(opened.resumeTool, 'wxmp_open');
  assert.deepEqual(opened.resumeArguments, { session_id: existing.id });
});

function waitingSession(id: string): WxmpSession {
  return { id, state: 'waiting_for_runtime', target } as WxmpSession;
}

function mockApp(overrides: Record<string, unknown> = {}): WxmpApp {
  const extractor = overrides.extractor;
  const config = overrides.config;
  const staticAdapter = overrides.staticAdapter;
  const sessionOverrides = { ...overrides };
  delete sessionOverrides.extractor;
  delete sessionOverrides.config;
  delete sessionOverrides.staticAdapter;
  const sessions = {
    listTargets: async () => [],
    list: () => [],
    get: () => waitingSession('session-default'),
    attach: async () => waitingSession('session-attached'),
    waitForRuntime: async () => ({}),
    bridge: { isConnected: () => false },
    publicStatus: (session: WxmpSession) => ({ id: session.id, state: session.state }),
    contextGraph: (sessionId: string) => ({ sessionId }),
    profileManager: () => ({
      load: async () => ({
        profile: { provenance: { source: 'clean-room', confidence: 'high' }, review: { decision: 'promoted' } },
        path: 'windows-20079.json',
      }),
      assertInjectable: () => undefined,
    }),
    ...sessionOverrides,
  };
  return {
    sessions,
    extractor: extractor ?? { info: () => ({ available: false, pythonPath: null, scriptPath: null, name: 'wmpf-offset-adaptation' }) },
    config: config ?? { workspaceRoot: 'C:\\tmp' },
    staticAdapter: staticAdapter ?? { info: () => ({ available: false }) },
  } as unknown as WxmpApp;
}
