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
  const bundle = await store.exportBundle({ state: 'connected' }, []);
  for (const filePath of Object.values(bundle)) assert.equal((await fs.stat(filePath)).isFile(), true);
  await fs.rm(root, { recursive: true, force: true });
});
