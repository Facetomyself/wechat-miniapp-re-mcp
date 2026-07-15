import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceStore } from '../src/evidence/store.js';

test('evidence store writes NDJSON and three-piece artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-evidence-'));
  const store = new EvidenceStore(root, 'fixture', 'session-1');
  await store.init();
  await store.append('test.event', { token: 'secret', value: 1 });
  const events = await store.readEvents();
  assert.equal(events.total, 1);
  assert.deepEqual(events.items[0].data, { token: '[redacted]', value: 1 });
  const bundle = await store.exportBundle({ state: 'waiting_for_runtime' }, [{
    id: 'fixture-gap',
    title: 'Fixture capability gap',
    severity: 'medium',
    status: 'open',
    summary: 'The fixture intentionally records an unresolved capability.',
    evidenceTypes: ['test.event'],
    firstObservedAt: '2026-01-01T00:00:00.000Z',
    lastObservedAt: '2026-01-01T00:00:00.000Z',
  }]);
  for (const filePath of Object.values(bundle)) assert.equal((await fs.stat(filePath)).isFile(), true);
  const findings = JSON.parse(await fs.readFile(bundle.findingsPath, 'utf8')) as Array<{ id: string }>;
  assert.deepEqual(findings.map((finding) => finding.id), ['runtime-not-ready', 'fixture-gap']);
  assert.match(await fs.readFile(bundle.reportPath, 'utf8'), /Fixture capability gap/);
  assert.match(await fs.readFile(bundle.triagePath, 'utf8'), /runtime channel is not ready/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('evidence store caps events, reports overflow, and recovers after a write error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-evidence-'));
  const store = new EvidenceStore(root, 'fixture', 'session-cap', 100, 2);
  await store.init();
  await store.append('event.one', { value: 1 });
  await store.append('event.two', { value: 2 });
  await store.append('event.three', { value: 3 });
  const bundle = await store.exportBundle({ state: 'connected' }, []);
  const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8')) as { eventCount: number; droppedEventCount: number };
  const findings = JSON.parse(await fs.readFile(bundle.findingsPath, 'utf8')) as Array<{ id: string }>;
  assert.equal(manifest.eventCount, 2);
  assert.equal(manifest.droppedEventCount, 1);
  assert.ok(findings.some((finding) => finding.id === 'evidence-overflow'));

  const recovery = new EvidenceStore(root, 'fixture', 'session-recovery');
  await recovery.init();
  await fs.rm(recovery.sessionRoot, { recursive: true, force: true });
  await recovery.append('write.failure', {});
  await fs.mkdir(recovery.sessionRoot, { recursive: true });
  await recovery.append('write.recovered', {});
  const recovered = await recovery.readEvents();
  assert.deepEqual(recovered.items.map((event) => event.type), ['write.recovered']);
  const recoveryBundle = await recovery.exportBundle({ state: 'connected' }, []);
  const recoveryFindings = JSON.parse(await fs.readFile(recoveryBundle.findingsPath, 'utf8')) as Array<{ id: string }>;
  assert.ok(recoveryFindings.some((finding) => finding.id === 'evidence-write-error'));
  await fs.rm(root, { recursive: true, force: true });
});

test('evidence store bounds event bytes and skips malformed NDJSON lines during export', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-evidence-'));
  const store = new EvidenceStore(root, 'fixture', 'session-bytes', 100, 100, 10_000, 1024);
  await store.init();
  await store.append('event.large', { body: 'x'.repeat(5000) });
  await fs.appendFile(store.eventsPath, '{malformed-json}\n', 'utf8');

  const events = await store.readEvents();
  assert.equal(events.total, 1);
  assert.deepEqual(events.items[0].data && typeof events.items[0].data === 'object'
    ? (events.items[0].data as Record<string, unknown>).truncated
    : undefined, true);

  const bundle = await store.exportBundle({ state: 'connected' }, []);
  const manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8')) as {
    eventBytes: number; truncatedEventCount: number; corruptLineCount: number;
  };
  const findings = JSON.parse(await fs.readFile(bundle.findingsPath, 'utf8')) as Array<{ id: string }>;
  assert.ok(manifest.eventBytes <= 1024);
  assert.equal(manifest.truncatedEventCount, 1);
  assert.equal(manifest.corruptLineCount, 1);
  assert.ok(findings.some((finding) => finding.id === 'evidence-event-truncated'));
  assert.ok(findings.some((finding) => finding.id === 'evidence-corrupt-lines'));
  await fs.rm(root, { recursive: true, force: true });
});
