import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/sessions/manager.js';
import { EvidenceStore } from '../src/evidence/store.js';
import type { WxmpSession } from '../src/sessions/manager.js';
import type { AppConfig } from '../src/config.js';

function mockConfig(workspaceRoot: string): AppConfig {
  return {
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
  };
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
  const evidence = new EvidenceStore(root, 'testp', 'wxmp-test');
  await evidence.init();

  const session: WxmpSession = {
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
      minigameDynamic: 'unknown' as const,
    },
    evidence,
    channel: null as unknown as WxmpSession['channel'],
    frida: null,
    findings: [],
    traceContextIds: new Set(),
    requestHookContextIds: new Set(),
    runtimeGeneration: 1,
  };

  const manager = new SessionManager(mockConfig(root));
  const status = manager.publicStatus(session);
  assert.equal(status.sessionId, 'wxmp-test');
  assert.equal(status.state, 'connected');
  assert.equal((status.capabilities as Record<string, unknown>).cdp, true);
  assert.equal((status.profile as Record<string, unknown>).version, 19977);

  await fs.rm(root, { recursive: true, force: true });
});
