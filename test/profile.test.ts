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
