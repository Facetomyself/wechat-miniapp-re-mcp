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
  void store.append('test.event', { token: 'secret', value: 1 });
  await store.flush();
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
