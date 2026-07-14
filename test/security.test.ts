import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveInside, sanitize } from '../src/security.js';

test('evidence sanitizer redacts credential-shaped keys', () => {
  assert.deepEqual(sanitize({ Authorization: 'Bearer value', nested: { cookie: 'a=b', ok: 1 } }), {
    Authorization: '[redacted]',
    nested: { cookie: '[redacted]', ok: 1 },
  });
});

test('workspace resolver rejects traversal', () => {
  const root = path.resolve('workspace-root');
  assert.throws(() => resolveInside(root, '..', 'escape'), /escapes the configured workspace/);
  assert.equal(resolveInside(root, 'safe'), path.join(root, 'safe'));
});
