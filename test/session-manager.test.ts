import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/sessions/manager.js';
import { EvidenceStore } from '../src/evidence/store.js';
import type { WxmpSession } from '../src/sessions/manager.js';
import type { AppConfig } from '../src/config.js';
import type { DevToolsProxy } from '../src/transport/devtools-proxy.js';

function mockConfig(workspaceRoot: string): AppConfig {
  return {
    toolset: 'agent',
    workspaceRoot,
    profileDirs: [],
    legacyProfileDirs: [],
    signatureDbPaths: [],
    gwxapkgPath: null,
    debugHost: '127.0.0.1',
    debugPort: 0,
    eventLimit: 5000,
    maxEvidenceEvents: 100_000,
    maxEvidenceBytes: 256 * 1024 * 1024,
    protocolPreviewBytes: 2048,
    maxProtocolArtifactBytes: 8 * 1024 * 1024,
  };
}

interface SessionManagerInternals {
  sessions: Map<string, WxmpSession>;
  proxies: Map<string, DevToolsProxy>;
  activationPromises: Map<string, Promise<void>>;
  handleConnected(sessionId: string): void;
  handleFridaDetached(sessionId: string, event: { reason: string; crash: unknown }): void;
}

async function createSession(
  workspaceRoot: string,
  options: {
    send?: (method: string) => Promise<Record<string, unknown>>;
    disconnect?: (reason: string) => void;
  } = {},
): Promise<WxmpSession> {
  const evidence = new EvidenceStore(workspaceRoot, 'testp', 'wxmp-test');
  await evidence.init();
  return {
    id: 'wxmp-test',
    projectName: 'test-project',
    target: {
      pid: 99999,
      ppid: 1,
      executablePath: 'C:\\test\\WeChatAppEx.exe',
      commandLine: 'test.exe',
      version: 19977,
      processType: 'browser',
      renderType: null,
      appId: null,
      isMain: true,
    },
    profile: {
      schemaVersion: 1,
      platform: 'windows',
      wmpfVersion: 19977,
      moduleName: 'flue.dll',
      cdpFilterOffset: '0x1A2B',
      loadStartOffset: '0x3C4D',
      sceneOffsets: [0x10, 0x20],
      sceneWhitelist: [1005],
      provenance: { source: 'clean-room', confidence: 'high' },
    },
    profilePath: '/profiles/windows-19977.json',
    state: 'connected',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contexts: new Map(),
    selectedContextId: '',
    capabilities: {
      frida: true,
      bridge: true,
      cdp: true,
      debugger: true,
      network: true,
      wxTrace: true,
      requestHook: false,
      staticAdapter: true,
      minigameDynamic: 'unknown',
    },
    evidence,
    channel: {
      send: options.send ?? (async () => ({ result: {} })),
      disconnect: options.disconnect ?? (() => undefined),
    } as unknown as WxmpSession['channel'],
    frida: null,
    findings: [],
    traceContextIds: new Set(),
    requestHookContextIds: new Set(),
    networkContextIds: new Set(['*']),
    runtimeGeneration: 0,
  };
}

function internals(manager: SessionManager): SessionManagerInternals {
  return manager as unknown as SessionManagerInternals;
}

function setBridgeConnected(manager: SessionManager, connected: boolean): void {
  (manager.bridge as unknown as { isConnected: (sessionId: string) => boolean }).isConnected = () => connected;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('SessionManager initialises with empty session list', () => {
  const manager = new SessionManager(mockConfig('/tmp'));
  assert.deepEqual(manager.list(), []);
});

test('SessionManager.get throws WxmpError for unknown session', () => {
  const manager = new SessionManager(mockConfig('/tmp'));
  assert.throws(
    () => manager.get('nonexistent'),
    (error: unknown) => error instanceof Error && error.message.includes('Unknown session'),
  );
});

test('SessionManager.bridge returns expected info fields', () => {
  const manager = new SessionManager(mockConfig('/tmp'));
  const info = manager.bridge.info();
  assert.equal(typeof info.listening, 'boolean');
  assert.deepEqual(info.connectedSessions, []);
  assert.deepEqual(info.pendingSessions, []);
});

test('SessionManager.profileManager is accessible', () => {
  const manager = new SessionManager(mockConfig('/tmp'));
  assert.ok(manager.profileManager());
});

test('SessionManager.publicStatus shape includes required fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const session = await createSession(root);

  const manager = new SessionManager(mockConfig(root));
  const status = manager.publicStatus(session);
  assert.equal(status.sessionId, 'wxmp-test');
  assert.equal(status.state, 'connected');
  assert.equal((status.capabilities as Record<string, unknown>).cdp, true);
  assert.equal((status.profile as Record<string, unknown>).version, 19977);

  await fs.rm(root, { recursive: true, force: true });
});

test('SessionManager keeps CDP capabilities false when all activation probes fail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const manager = new SessionManager(mockConfig(root));
  const session = await createSession(root, {
    send: async (method) => { throw new Error(`${method} unavailable`); },
  });
  const runtime = internals(manager);
  runtime.sessions.set(session.id, session);
  setBridgeConnected(manager, true);
  try {
    runtime.handleConnected(session.id);
    const activation = runtime.activationPromises.get(session.id);
    assert.ok(activation);
    await activation;
    assert.equal(session.state, 'connected');
    assert.equal(session.capabilities.cdp, false);
    assert.equal(session.capabilities.debugger, false);
    assert.equal(session.capabilities.network, false);
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionManager reports partial CDP capabilities from individual activation probes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const manager = new SessionManager(mockConfig(root));
  const session = await createSession(root, {
    send: async (method) => {
      if (method === 'Debugger.enable') throw new Error('Debugger unavailable');
      return { result: {} };
    },
  });
  const runtime = internals(manager);
  runtime.sessions.set(session.id, session);
  setBridgeConnected(manager, true);
  try {
    runtime.handleConnected(session.id);
    const activation = runtime.activationPromises.get(session.id);
    assert.ok(activation);
    await activation;
    assert.equal(session.capabilities.cdp, true);
    assert.equal(session.capabilities.debugger, false);
    assert.equal(session.capabilities.network, true);
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionManager stops the DevTools proxy after an unexpected Frida detach', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const manager = new SessionManager(mockConfig(root));
  let disconnectReason = '';
  const session = await createSession(root, {
    disconnect: (reason) => { disconnectReason = reason; },
  });
  const runtime = internals(manager);
  let stopCalls = 0;
  const proxy = {
    stop: async () => { stopCalls += 1; },
  } as unknown as DevToolsProxy;
  runtime.sessions.set(session.id, session);
  runtime.proxies.set(session.id, proxy);
  try {
    runtime.handleFridaDetached(session.id, { reason: 'process-terminated', crash: null });
    await waitUntil(() => stopCalls === 1 && !runtime.proxies.has(session.id));
    assert.equal(session.state, 'failed');
    assert.match(disconnectReason, /process-terminated/);
    assert.equal(session.capabilities.frida, false);
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionManager records a finding when unexpected-detach proxy cleanup fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const manager = new SessionManager(mockConfig(root));
  const session = await createSession(root);
  const runtime = internals(manager);
  const proxy = {
    stop: async () => { throw new Error('proxy close failed'); },
  } as unknown as DevToolsProxy;
  runtime.sessions.set(session.id, session);
  runtime.proxies.set(session.id, proxy);
  try {
    runtime.handleFridaDetached(session.id, { reason: 'connection-terminated', crash: null });
    await waitUntil(() => session.findings.some((finding) => finding.id === 'devtools-proxy-cleanup-failed'));
    assert.equal(runtime.proxies.has(session.id), true);
    const finding = session.findings.find((entry) => entry.id === 'devtools-proxy-cleanup-failed');
    assert.equal(finding?.status, 'open');
    assert.match(finding?.summary ?? '', /proxy close failed/);
    await session.evidence.flush();
    const events = await session.evidence.readEvents(0, 100, 'devtools_proxy.cleanup_failed');
    assert.equal(events.total, 1);
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionManager.listTargets uses the injected discovery seam', async () => {
  const targets = [{
    pid: 111,
    ppid: 1,
    executablePath: 'C:\\test\\WeChatAppEx.exe',
    commandLine: 'test.exe',
    version: 25459,
    processType: 'browser',
    renderType: null,
    appId: null,
    isMain: true,
  }];
  let calls = 0;
  const manager = new SessionManager(mockConfig('/tmp'), {
    discoverTargets: async () => {
      calls += 1;
      return targets;
    },
  });
  assert.deepEqual(await manager.listTargets(), targets);
  assert.equal(calls, 1);
});

test('SessionManager uses the injected clock for finding timestamps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const frozen = new Date('2026-08-22T12:00:00.000Z');
  const manager = new SessionManager(mockConfig(root), { now: () => frozen });
  const session = await createSession(root);
  const runtime = internals(manager);
  runtime.sessions.set(session.id, session);
  try {
    runtime.handleFridaDetached(session.id, { reason: 'process-terminated', crash: null });
    const finding = session.findings.find((entry) => entry.id === 'frida-detached');
    assert.equal(finding?.firstObservedAt, frozen.toISOString());
    assert.equal(session.updatedAt, frozen.toISOString());
    assert.equal(session.state, 'failed');
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SessionManager.waitForRuntime rejects terminal session states', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-sess-'));
  const manager = new SessionManager(mockConfig(root));
  const session = await createSession(root);
  session.state = 'closed';
  internals(manager).sessions.set(session.id, session);
  try {
    await assert.rejects(
      () => manager.waitForRuntime(session.id, 10),
      (error: unknown) => error instanceof Error && error.message.includes('is in state closed'),
    );
  } finally {
    await session.evidence.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
});
