import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OffsetExtractorAdapter } from '../src/runtime/extractor.js';
import { attestedPromote, importExtractorOutput, prepareCandidateProfile, smokeReady } from '../src/runtime/profile-adapt.js';
import { ProfileManager } from '../src/runtime/profile.js';
import { WxmpError } from '../src/errors.js';
import { AgentWorkflow } from '../src/workflows/agent.js';
import { WxmpApp } from '../src/app.js';
import { SessionManager } from '../src/sessions/manager.js';
import type { AppConfig } from '../src/config.js';
import type { OffsetProfile, TargetProcess } from '../src/types.js';
import type { WxmpSession } from '../src/sessions/session.js';

const FIXTURE = path.resolve('test', 'fixtures', 'offset-extractor.mjs');

function config(workspaceRoot: string, scriptPath: string | null = FIXTURE): AppConfig {
  return {
    toolset: 'agent',
    workspaceRoot,
    profileDirs: [],
    legacyProfileDirs: [],
    signatureDbPaths: [],
    gwxapkgPath: null,
    offsetExtractorPython: null,
    offsetExtractorScript: scriptPath,
    debugHost: '127.0.0.1',
    debugPort: 9421,
    eventLimit: 5000,
    maxEvidenceEvents: 100_000,
    maxEvidenceBytes: 256 * 1024 * 1024,
    protocolPreviewBytes: 2048,
    maxProtocolArtifactBytes: 8 * 1024 * 1024,
  };
}

const target: TargetProcess = {
  pid: 9,
  ppid: 1,
  executablePath: '',
  commandLine: 'WeChatAppEx.exe',
  version: 25047,
  processType: 'browser',
  renderType: null,
  appId: 'wxfixture',
  isMain: true,
};

test('extractor adapter reports missing script with install paths', () => {
  const adapter = new OffsetExtractorAdapter(config('/tmp', 'C:\\missing\\extract_wmpf_offsets.py'));
  const info = adapter.info();
  assert.equal(info.available, false);
  assert.match(info.scriptPath ?? '', /extract_wmpf_offsets\.py/);
});

test('extractor adapter throws EXTRACTOR_UNAVAILABLE with python and script paths', async () => {
  const adapter = new OffsetExtractorAdapter(config('/tmp', 'C:\\missing\\extract_wmpf_offsets.py'));
  await assert.rejects(
    () => adapter.extract({ version: 1, dllPath: 'C:\\missing\\flue.dll', outputPath: 'C:\\missing\\out.json' }),
    (error: unknown) => error instanceof WxmpError
      && error.code === 'EXTRACTOR_UNAVAILABLE'
      && String(error.details.scriptPath).includes('extract_wmpf_offsets.py')
      && String(error.recovery?.userAction).includes('WXMP_OFFSET_EXTRACTOR'),
  );
});

test('extractor adapter runs a node fixture and archives a module copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-extract-'));
  const source = path.join(root, 'flue.dll');
  await fs.writeFile(source, 'dll-bytes');
  const adapter = new OffsetExtractorAdapter(config(root));
  const archived = await adapter.archiveModule(source, 'fixture', 25047);
  assert.ok(archived.path.includes(`${path.sep}wechat-miniapp${path.sep}modules${path.sep}`));
  assert.equal(archived.sha256.length, 64);
  const copied = await fs.readFile(archived.path, 'utf8');
  assert.equal(copied, 'dll-bytes');
  const outputPath = path.join(root, 'out.json');
  const extracted = await adapter.extract({ version: 25047, dllPath: archived.path, outputPath });
  assert.equal(extracted.raw.Version, 25047);
  assert.equal(extracted.raw.CDPFilterHookOffset, '0x2000');
  assert.deepEqual(extracted.raw.SceneOffsets, [64, 1480, 8, 1416, 16, 456]);
  await fs.rm(root, { recursive: true, force: true });
});

test('importExtractorOutput builds a non-injectable candidate', () => {
  const candidate = importExtractorOutput({
    version: 25047,
    moduleName: 'flue.dll',
    moduleSha256: 'a'.repeat(64),
    raw: {
      Version: 25047,
      CDPFilterHookOffset: '0x2000',
      LoadStartHookOffset: '0x1000',
      SceneOffsets: [64, 1480, 8, 1416, 16, 456],
    },
    outputPath: 'C:\\ws\\extractor-25047.json',
  });
  assert.equal(candidate.provenance.confidence, 'candidate');
  assert.equal(candidate.cdpFilterOffset, '0x2000');
  const manager = new ProfileManager([], []);
  assert.throws(
    () => manager.assertInjectable(candidate),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_REVIEW_REQUIRED',
  );
});

test('attestedPromote requires smoke and unique AOB or extractor structure', () => {
  const candidate = importExtractorOutput({
    version: 25047,
    moduleName: 'flue.dll',
    moduleSha256: 'a'.repeat(64),
    raw: {
      Version: 25047,
      CDPFilterHookOffset: '0x2000',
      LoadStartHookOffset: '0x1000',
      SceneOffsets: [64, 1480, 8, 1416, 16, 456],
    },
    outputPath: 'C:\\ws\\extractor-25047.json',
  });
  assert.equal(smokeReady({ ready: true, cdpFilterAttached: true, loadStartAttached: false }), false);
  assert.throws(
    () => attestedPromote({
      candidate,
      hashValidated: true,
      boundsValid: true,
      moduleSha256: 'a'.repeat(64),
      extractor: {
        cdpFilterOffset: '0x2000',
        loadStartOffset: '0x1000',
        sceneOffsets: candidate.sceneOffsets,
        outputPath: 'C:\\ws\\extractor-25047.json',
      },
      smoke: { ready: true, cdpFilterAttached: true, loadStartAttached: false },
    }),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_SMOKE_FAILED',
  );
  assert.throws(
    () => attestedPromote({
      candidate,
      hashValidated: true,
      boundsValid: true,
      moduleSha256: 'a'.repeat(64),
      aob: { cdpFilterOffset: '0x9999', loadStartOffset: '0x1000', unique: true },
      extractor: {
        cdpFilterOffset: '0x2000',
        loadStartOffset: '0x1000',
        sceneOffsets: candidate.sceneOffsets,
        outputPath: 'C:\\ws\\extractor-25047.json',
      },
      smoke: { ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' },
    }),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_OFFSET_CONFLICT',
  );
  const promoted = attestedPromote({
    candidate,
    hashValidated: true,
    boundsValid: true,
    moduleSha256: 'a'.repeat(64),
    extractor: {
      cdpFilterOffset: '0x2000',
      loadStartOffset: '0x1000',
      sceneOffsets: candidate.sceneOffsets,
      outputPath: 'C:\\ws\\extractor-25047.json',
    },
    smoke: { ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' },
  });
  assert.equal(promoted.provenance.confidence, 'medium');
  assert.equal(promoted.review?.decision, 'promoted');
  assert.equal(promoted.provenance.note, 'extractor+runtime-smoke');
  new ProfileManager([], []).assertInjectable(promoted);
});

test('prepareCandidateProfile writes a workspace candidate from the fixture extractor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-adapt-'));
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir);
  const dll = path.join(runtimeDir, 'flue.dll');
  await fs.writeFile(dll, Buffer.alloc(0x3000, 1));
  const localTarget = { ...target, executablePath: path.join(runtimeDir, 'WeChatAppEx.exe') };
  const adapter = new OffsetExtractorAdapter(config(root));
  const profiles = new ProfileManager([], []);
  const prepared = await prepareCandidateProfile({
    target: localTarget,
    projectName: 'adapt-fixture',
    extractor: adapter,
    profiles,
    workspaceRoot: root,
  });
  assert.equal(prepared.candidate.provenance.confidence, 'candidate');
  assert.equal(prepared.aob, null);
  const written = JSON.parse(await fs.readFile(prepared.candidatePath, 'utf8')) as OffsetProfile;
  assert.equal(written.wmpfVersion, 25047);
  assert.equal(written.cdpFilterOffset, '0x2000');
  await fs.rm(root, { recursive: true, force: true });
});

test('node extractor fixture is available without a python interpreter', () => {
  const adapter = new OffsetExtractorAdapter(config('/tmp'));
  assert.equal(adapter.info().available, true);
  assert.equal(adapter.info().name, 'wmpf-offset-adaptation');
});

test('extractor adapter throws EXTRACTOR_FAILED when the subprocess exits non-zero', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-extract-fail-'));
  const failScript = path.join(root, 'fail.mjs');
  await fs.writeFile(failScript, 'process.stderr.write(\'boom\'); process.exit(2);\n');
  const adapter = new OffsetExtractorAdapter(config(root, failScript));
  await assert.rejects(
    () => adapter.extract({ version: 1, dllPath: path.join(root, 'flue.dll'), outputPath: path.join(root, 'out.json') }),
    (error: unknown) => error instanceof WxmpError
      && error.code === 'EXTRACTOR_FAILED'
      && String(error.details.stderr).includes('boom'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('extractor adapter throws EXTRACTOR_OUTPUT_INVALID for non-JSON output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-extract-bad-'));
  const badScript = path.join(root, 'bad.mjs');
  await fs.writeFile(badScript, `
    import { writeFileSync } from 'node:fs';
    const output = process.argv[process.argv.indexOf('--output') + 1];
    writeFileSync(output, 'not-json', 'utf8');
  `);
  const adapter = new OffsetExtractorAdapter(config(root, badScript));
  await assert.rejects(
    () => adapter.extract({ version: 1, dllPath: path.join(root, 'flue.dll'), outputPath: path.join(root, 'out.json') }),
    (error: unknown) => error instanceof WxmpError && error.code === 'EXTRACTOR_OUTPUT_INVALID',
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('attestedPromote accepts unique AOB without extractor structure', () => {
  const candidate = importExtractorOutput({
    version: 25047,
    moduleName: 'flue.dll',
    moduleSha256: 'a'.repeat(64),
    raw: {
      Version: 25047,
      CDPFilterHookOffset: '0x2000',
      LoadStartHookOffset: '0x1000',
      SceneOffsets: [64, 1480, 8, 1416, 16, 456],
    },
    outputPath: 'C:\\ws\\extractor-25047.json',
  });
  const promoted = attestedPromote({
    candidate,
    hashValidated: true,
    boundsValid: true,
    moduleSha256: 'a'.repeat(64),
    aob: { cdpFilterOffset: '0x2000', loadStartOffset: '0x1000', unique: true },
    extractor: null,
    smoke: { ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' },
  });
  assert.equal(promoted.provenance.confidence, 'medium');
  assert.throws(
    () => attestedPromote({
      candidate,
      hashValidated: true,
      boundsValid: true,
      moduleSha256: 'a'.repeat(64),
      aob: { cdpFilterOffset: '0x2000', loadStartOffset: '0x1000', unique: false },
      extractor: null,
      smoke: { ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' },
    }),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_EVIDENCE_INSUFFICIENT',
  );
});

test('doctor advertises extractor auto-adapt when no injectable profile exists', async () => {
  const available = await new AgentWorkflow(mockDoctorApp({
    extractorAvailable: true,
    loadError: new WxmpError('PROFILE_NOT_FOUND', 'missing'),
  })).doctor();
  assert.equal(available.state, 'ready_to_open');
  assert.equal(available.needsUserAction, false);
  assert.match(String(available.userAction), /wmpf-offset-adaptation/);
  assert.deepEqual(available.nextActions, ['wxmp_open']);

  const missing = await new AgentWorkflow(mockDoctorApp({
    extractorAvailable: false,
    loadError: new WxmpError('PROFILE_NOT_FOUND', 'missing'),
  })).doctor();
  assert.equal(missing.state, 'degraded');
  assert.equal(missing.needsUserAction, true);
  assert.match(String(missing.userAction), /Install the offset extractor/);
});

test('agent open smoke-promotes an extractor candidate when no injectable profile exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-open-adapt-'));
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir);
  await fs.writeFile(path.join(runtimeDir, 'flue.dll'), Buffer.alloc(0x3000, 1));
  const localTarget = { ...target, executablePath: path.join(runtimeDir, 'WeChatAppEx.exe') };
  const cfg = config(root);
  const extractor = new OffsetExtractorAdapter(cfg);
  const profiles = new ProfileManager([], []);
  const session = waitingOpenSession('session-smoke', localTarget);
  let attachOptions: { allowCandidateSmoke?: boolean; profilePath?: string; projectName?: string } | undefined;
  const app = {
    config: cfg,
    extractor,
    sessions: {
      listTargets: async () => [localTarget],
      list: () => [],
      attach: async (options: { allowCandidateSmoke?: boolean; profilePath?: string; projectName?: string }) => {
        attachOptions = options;
        session.projectName = options.projectName ?? 'adapt-fixture';
        session.profile = JSON.parse(await fs.readFile(String(options.profilePath), 'utf8')) as OffsetProfile;
        session.profilePath = String(options.profilePath);
        return session;
      },
      waitForRuntime: async () => ({}),
      get: () => session,
      bridge: { isConnected: () => false, info: () => ({}) },
      publicStatus: (item: WxmpSession) => ({ id: item.id, state: item.state }),
      contextGraph: () => ({}),
      profileManager: () => profiles,
    },
    staticAdapter: { info: () => ({ available: false }), scan: async () => [] },
  } as unknown as WxmpApp;

  const opened = await new AgentWorkflow(app).open({ projectName: 'adapt-fixture', connectTimeoutMs: 1 });
  assert.equal(attachOptions?.allowCandidateSmoke, true);
  assert.equal(opened.sessionId, 'session-smoke');
  assert.equal(session.profile.provenance.confidence, 'medium');
  assert.equal(session.profile.provenance.note, 'extractor+runtime-smoke');
  const reviewedPath = path.join(root, 'adapt-fixture', 'wechat-miniapp', 'profiles', 'windows-25047-reviewed.json');
  const written = JSON.parse(await fs.readFile(reviewedPath, 'utf8')) as OffsetProfile;
  assert.equal(written.review?.decision, 'promoted');
  assert.equal(session.profilePath, reviewedPath);

  const reused: { allowCandidateSmoke?: boolean; profilePath?: string }[] = [];
  const reuseApp = {
    ...app,
    sessions: {
      ...app.sessions,
      attach: async (options: { allowCandidateSmoke?: boolean; profilePath?: string }) => {
        reused.push(options);
        return session;
      },
    },
  } as unknown as WxmpApp;
  await new AgentWorkflow(reuseApp).open({ projectName: 'adapt-fixture', connectTimeoutMs: 1 });
  assert.equal(reused[0]?.allowCandidateSmoke, false);
  assert.equal(reused[0]?.profilePath, reviewedPath);
  await fs.rm(root, { recursive: true, force: true });
});

test('session attach blocks candidates unless smoke-ready RPC is observed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-attach-smoke-'));
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir);
  const dll = path.join(runtimeDir, 'flue.dll');
  await fs.writeFile(dll, Buffer.alloc(0x3000, 1));
  const localTarget = { ...target, executablePath: path.join(runtimeDir, 'WeChatAppEx.exe'), pid: 77 };
  const candidate = importExtractorOutput({
    version: 25047,
    moduleName: 'flue.dll',
    moduleSha256: (await import('node:crypto')).createHash('sha256').update(await fs.readFile(dll)).digest('hex'),
    raw: {
      Version: 25047,
      CDPFilterHookOffset: '0x2000',
      LoadStartHookOffset: '0x1000',
      SceneOffsets: [64, 1480, 8, 1416, 16, 456],
    },
    outputPath: path.join(root, 'extractor-25047.json'),
  });
  const candidatePath = path.join(root, 'candidate.json');
  await fs.writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  const blocked = new SessionManager(config(root), {
    resolveTarget: async () => localTarget,
    createBridge: fakeBridge,
    frida: fakeFrida({ ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' }),
  });
  await assert.rejects(
    () => blocked.attach({ pid: localTarget.pid, projectName: 'smoke', profilePath: candidatePath, connectTimeoutMs: 1 }),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_REVIEW_REQUIRED',
  );

  const failing = new SessionManager(config(root), {
    resolveTarget: async () => localTarget,
    createBridge: fakeBridge,
    frida: fakeFrida({ ready: true, cdpFilterAttached: true, loadStartAttached: false, moduleName: 'flue.dll' }),
  });
  await assert.rejects(
    () => failing.attach({
      pid: localTarget.pid,
      projectName: 'smoke',
      profilePath: candidatePath,
      connectTimeoutMs: 1,
      allowCandidateSmoke: true,
    }),
    (error: unknown) => error instanceof WxmpError && error.code === 'PROFILE_SMOKE_FAILED',
  );

  const passing = new SessionManager(config(root), {
    resolveTarget: async () => localTarget,
    createBridge: fakeBridge,
    frida: fakeFrida({ ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' }),
  });
  const session = await passing.attach({
    pid: localTarget.pid,
    projectName: 'smoke',
    profilePath: candidatePath,
    connectTimeoutMs: 1,
    allowCandidateSmoke: true,
  });
  assert.equal(session.profile.provenance.confidence, 'candidate');
  assert.equal(session.state, 'waiting_for_runtime');
  await passing.detach(session.id);
  await passing.shutdown();
  await failing.shutdown();
  await blocked.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

function waitingOpenSession(id: string, sessionTarget: TargetProcess): WxmpSession {
  return {
    id,
    state: 'waiting_for_runtime',
    target: sessionTarget,
    projectName: 'adapt-fixture',
    profile: importExtractorOutput({
      version: 25047,
      moduleName: 'flue.dll',
      moduleSha256: 'a'.repeat(64),
      raw: {
        Version: 25047,
        CDPFilterHookOffset: '0x2000',
        LoadStartHookOffset: '0x1000',
        SceneOffsets: [64, 1480, 8, 1416, 16, 456],
      },
      outputPath: 'C:\\ws\\extractor-25047.json',
    }),
    profilePath: '',
    evidence: { append: async () => undefined },
    frida: {
      status: async () => ({ ready: true, cdpFilterAttached: true, loadStartAttached: true, moduleName: 'flue.dll' }),
    },
    selectedContextId: '',
    capabilities: {},
  } as unknown as WxmpSession;
}

function mockDoctorApp(options: { extractorAvailable: boolean; loadError: WxmpError }): WxmpApp {
  return {
    extractor: {
      info: () => ({
        available: options.extractorAvailable,
        pythonPath: options.extractorAvailable ? 'C:\\py\\python.exe' : null,
        scriptPath: options.extractorAvailable ? FIXTURE : null,
        name: 'wmpf-offset-adaptation',
      }),
    },
    config: { workspaceRoot: 'C:\\tmp' },
    staticAdapter: { info: () => ({ available: false }) },
    sessions: {
      listTargets: async () => [target],
      list: () => [],
      profileManager: () => ({
        load: async () => {
          throw options.loadError;
        },
      }),
      bridge: { info: () => ({}) },
      publicStatus: () => ({}),
    },
  } as unknown as WxmpApp;
}

function fakeFrida(observation: Record<string, unknown>) {
  return {
    attach: async () => ({
      detach: async () => undefined,
      status: async () => observation,
      forceDebugTrigger: async () => observation,
    }),
  } as never;
}

function fakeBridge() {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    prepare: () => undefined,
    waitForConnection: async () => false,
    isConnected: () => false,
    release: () => undefined,
    sendCdp: async () => undefined,
    info: () => ({}),
  } as never;
}
