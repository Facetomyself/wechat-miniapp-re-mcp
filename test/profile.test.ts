import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPattern, ProfileManager } from '../src/runtime/profile.js';
import type { OffsetProfile, TargetProcess } from '../src/types.js';

test('AOB signatures support wildcards', () => {
  const buffer = Buffer.from([0x90, 0x48, 0x8b, 0x11, 0x89, 0x90, 0x48, 0x8b, 0x22, 0x89]);
  assert.deepEqual(findPattern(buffer, '48 8B ?? 89'), [1, 6]);
});

test('AOB signatures reject malformed bytes', () => {
  assert.throws(() => findPattern(Buffer.from([1, 2]), 'GG'), /Invalid byte signature/);
  assert.throws(() => findPattern(Buffer.from([1, 2]), '1G'), /Invalid byte signature/);
});

test('profile loader rejects offset strings with trailing garbage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  await fs.writeFile(path.join(root, 'windows-19977.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    moduleSha256: '0'.repeat(64),
    cdpFilterOffset: '0x10garbage',
    loadStartOffset: '25junk',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'clean-room', confidence: 'high' },
  }));
  const manager = new ProfileManager([root], []);
  await assert.rejects(manager.load(19977), (error: unknown) => error instanceof Error && error.message.includes('Invalid offset'));
  await fs.rm(root, { recursive: true, force: true });
});

test('profile manager loads verified signatures from the configured database', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const databasePath = path.join(root, 'signatures.json');
  await fs.writeFile(databasePath, JSON.stringify({
    schemaVersion: 2,
    signatures: {
      cdpFilter: { verifiedVersions: [19977], aobPre: 'AA BB CC', adjustment: 3 },
      loadStart: { verifiedVersions: [19977], pattern: '11 22 33', adjustment: 0 },
    },
  }));
  const manager = new ProfileManager([], [], [databasePath]);
  assert.deepEqual(await manager.signaturesForVersion(19977), [
    { name: 'cdpFilter', pattern: 'AA BB CC', adjustment: 3 },
    { name: 'loadStart', pattern: '11 22 33', adjustment: 0 },
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

test('bundled signature database serves the reviewed cross-version patterns', async () => {
  const databasePath = path.resolve('data', 'profiles', 'aob-signatures.json');
  const manager = new ProfileManager([], [], [databasePath]);
  const expected = [
    {
      name: 'cdpFilter',
      pattern: '85 C9 79 05 4B 8B 44 25 08 4C 8B 6C 24 30 48 85',
      adjustment: 32,
    },
    {
      name: 'loadStart',
      pattern: '89 02 48 C7 42 08 66 00 00 00 48 8D 5C 24 30 48 89 D9 E8 ?? ?? ?? FF 48 8B 13 4C 8B 43 08 48 89',
      adjustment: 0,
    },
  ];

  assert.deepEqual(await manager.signaturesForVersion(19977), expected);
  assert.deepEqual(await manager.signaturesForVersion(20079), expected);

  const database = JSON.parse(await fs.readFile(databasePath, 'utf8')) as {
    verification: { verifiedVersions: number[] };
    versionProfiles: Array<{ wmpfVersion: number; moduleSha256: string; reviewedProfile: string }>;
  };
  assert.deepEqual(database.verification.verifiedVersions, [19977, 20079]);
  assert.deepEqual(database.versionProfiles.map(({ wmpfVersion, moduleSha256, reviewedProfile }) => ({
    wmpfVersion,
    moduleSha256,
    reviewedProfile,
  })), [
    {
      wmpfVersion: 19977,
      moduleSha256: 'f569e0ddcd622e85fb33a0e2a4c647561fd27440c9612a54140572a42c8cfc7d',
      reviewedProfile: 'data/profiles/clean-room/windows-19977.json',
    },
    {
      wmpfVersion: 20079,
      moduleSha256: 'b28ec2d547e8771aeebe94ba77bc618941c0ce0794ef443f905666f0668f5d2b',
      reviewedProfile: 'data/profiles/clean-room/windows-20079.json',
    },
  ]);
});

test('cross-version loadStart signature wildcards the relocated call displacement', () => {
  const pattern = '89 02 48 C7 42 08 66 00 00 00 48 8D 5C 24 30 48 89 D9 E8 ?? ?? ?? FF 48 8B 13 4C 8B 43 08 48 89';
  const modules = [
    Buffer.from('890248c7420866000000488d5c24304889d9e8698ec8ff488b134c8b43084889', 'hex'),
    Buffer.from('890248c7420866000000488d5c24304889d9e879b2c7ff488b134c8b43084889', 'hex'),
  ];

  assert.notEqual(modules[0].subarray(19, 22).toString('hex'), modules[1].subarray(19, 22).toString('hex'));
  for (const module of modules) assert.deepEqual(findPattern(module, pattern), [0]);
});

test('bundled reviewed profiles use canonical filenames and remain injectable', async () => {
  const profileDir = path.resolve('data', 'profiles', 'clean-room');
  const manager = new ProfileManager([profileDir], []);
  const expected = new Map([
    [19977, 'f569e0ddcd622e85fb33a0e2a4c647561fd27440c9612a54140572a42c8cfc7d'],
    [20079, 'b28ec2d547e8771aeebe94ba77bc618941c0ce0794ef443f905666f0668f5d2b'],
  ]);
  for (const [version, moduleSha256] of expected) {
    const loaded = await manager.load(version);
    assert.equal(loaded.profile.provenance.confidence, 'high');
    assert.equal(loaded.profile.moduleSha256, moduleSha256);
    assert.equal(path.basename(loaded.path), `windows-${version}.json`);
    assert.doesNotThrow(() => manager.assertInjectable(loaded.profile));
  }
});

test('generated profiles bind candidates to the module SHA-256', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const executablePath = path.join(root, 'WeChatAppEx.exe');
  const modulePath = path.join(root, 'flue.dll');
  const module = Buffer.from([0x00, 0xAA, 0xBB, 0xCC, 0x00, 0x11, 0x22, 0x33, 0x00]);
  await fs.writeFile(executablePath, 'fixture');
  await fs.writeFile(modulePath, module);
  const manager = new ProfileManager([], []);
  const profile = await manager.generate(target(executablePath), [
    { name: 'cdpFilter', pattern: 'AA BB CC' },
    { name: 'loadStart', pattern: '11 22 33' },
  ], [0x10, 0x20]);

  assert.equal(profile.moduleSha256, createHash('sha256').update(module).digest('hex'));
  assert.equal(profile.provenance.confidence, 'candidate');
  assert.throws(() => manager.assertInjectable(profile), (error: unknown) => error instanceof Error && error.message.includes('require review'));

  await fs.rm(root, { recursive: true, force: true });
});

test('profile probe rejects a mismatched expected module hash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const executablePath = path.join(root, 'WeChatAppEx.exe');
  await fs.writeFile(executablePath, 'fixture');
  await fs.writeFile(path.join(root, 'flue.dll'), Buffer.alloc(128, 0x41));
  const manager = new ProfileManager([], []);
  const profile: OffsetProfile = {
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    moduleSha256: '0'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'clean-room', confidence: 'high' },
  };
  const probe = await manager.probe(target(executablePath), profile);
  assert.equal(probe.hashMatches, false);
  assert.equal(probe.valid, false);

  await fs.rm(root, { recursive: true, force: true });
});

test('profile loader requires module hashes for non-legacy profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  await fs.writeFile(path.join(root, 'windows-19977.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'clean-room', confidence: 'high' },
  }));
  const manager = new ProfileManager([root], []);
  await assert.rejects(manager.load(19977), (error: unknown) => error instanceof Error && error.message.includes('moduleSha256'));

  await fs.rm(root, { recursive: true, force: true });
});

test('profile loader rejects module path traversal and incomplete hook fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  await fs.writeFile(path.join(root, 'windows-19977.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: '..\\outside.dll',
    moduleSha256: '0'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    provenance: { source: 'clean-room', confidence: 'high' },
  }));
  const manager = new ProfileManager([root], []);
  await assert.rejects(manager.load(19977), (error: unknown) => error instanceof Error && error.message.includes('schema version 1'));
  await fs.rm(root, { recursive: true, force: true });
});

test('profile loader rejects a profile for a different WMPF version', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const profilePath = path.join(root, 'windows-19841.json');
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19841,
    moduleName: 'flue.dll',
    moduleSha256: '0'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'generated', confidence: 'candidate' },
  }));
  const manager = new ProfileManager([], []);
  await assert.rejects(
    manager.load(19977, profilePath),
    (error: unknown) => error instanceof Error && error.message.includes('does not match target WMPF'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('profile loader does not silently fall back when an explicit path is missing', async () => {
  const profileDir = path.resolve('data', 'profiles', 'clean-room');
  const manager = new ProfileManager([profileDir], []);
  await assert.rejects(
    manager.load(19977, path.join(profileDir, 'missing-profile.json')),
    (error: unknown) => error instanceof Error && error.message.includes('Explicit profile path does not exist'),
  );
});

test('generated profiles cannot bypass review by editing confidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const profilePath = path.join(root, 'windows-19977.json');
  await fs.writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    moduleSha256: '0'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'generated', confidence: 'medium' },
  }));
  const manager = new ProfileManager([], []);
  await assert.rejects(
    manager.load(19977, profilePath),
    (error: unknown) => error instanceof Error && error.message.includes('review evidence'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('candidate promotion records review evidence and becomes injectable', () => {
  const manager = new ProfileManager([], []);
  const candidate: OffsetProfile = {
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    moduleSha256: 'a'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'generated', confidence: 'candidate' },
  };
  const promoted = manager.promote(candidate, {
    confidence: 'medium',
    reviewer: 'fixture-reviewer',
    evidence: ['evidence/session-1/report.md'],
    note: 'Offsets and module hash reviewed against the fixture.',
  });
  assert.equal(promoted.provenance.confidence, 'medium');
  assert.equal(promoted.review?.decision, 'promoted');
  assert.deepEqual(promoted.review?.evidence, ['evidence/session-1/report.md']);
  assert.doesNotThrow(() => manager.assertInjectable(promoted));
});

test('unreviewed clean-room profiles are probeable but not injectable', () => {
  const manager = new ProfileManager([], []);
  const profile: OffsetProfile = {
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: 19977,
    moduleName: 'flue.dll',
    moduleSha256: 'a'.repeat(64),
    cdpFilterOffset: '0x10',
    loadStartOffset: '0x20',
    sceneOffsets: [0x10, 0x20],
    sceneWhitelist: [1005],
    provenance: { source: 'clean-room', confidence: 'high' },
  };
  assert.throws(() => manager.assertInjectable(profile), /require recorded review evidence/);
});

test('profile generation rejects incomplete or adjusted out-of-bounds signatures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-profile-'));
  const executablePath = path.join(root, 'WeChatAppEx.exe');
  await fs.writeFile(executablePath, 'fixture');
  await fs.writeFile(path.join(root, 'flue.dll'), Buffer.from([0xAA, 0xBB, 0xCC, 0x11, 0x22, 0x33]));
  const manager = new ProfileManager([], []);
  await assert.rejects(
    manager.generate(target(executablePath), [{ name: 'cdpFilter', pattern: 'AA BB CC' }], [0x10, 0x20]),
    (error: unknown) => error instanceof Error && error.message.includes('exactly one'),
  );
  await assert.rejects(
    manager.generate(target(executablePath), [
      { name: 'cdpFilter', pattern: 'AA BB CC', adjustment: 100 },
      { name: 'loadStart', pattern: '11 22 33' },
    ], [0x10, 0x20]),
    (error: unknown) => error instanceof Error && error.message.includes('outside the target module'),
  );
  await assert.rejects(
    manager.generate(target(executablePath), [
      { name: 'cdpFilter', pattern: 'AA BB CC', adjustment: 0.5 },
      { name: 'loadStart', pattern: '11 22 33' },
    ], [0x10, 0x20]),
    (error: unknown) => error instanceof Error && error.message.includes('safe integer'),
  );
  await fs.rm(root, { recursive: true, force: true });
});

function target(executablePath: string): TargetProcess {
  return {
    pid: 1234,
    ppid: 1,
    executablePath,
    commandLine: executablePath,
    version: 19977,
    processType: 'browser',
    renderType: null,
    appId: null,
    isMain: true,
  };
}
