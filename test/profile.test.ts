import test from 'node:test';
import assert from 'node:assert/strict';
import { findPattern } from '../src/runtime/profile.js';

test('AOB signatures support wildcards', () => {
  const buffer = Buffer.from([0x90, 0x48, 0x8b, 0x11, 0x89, 0x90, 0x48, 0x8b, 0x22, 0x89]);
  assert.deepEqual(findPattern(buffer, '48 8B ?? 89'), [1, 6]);
});

test('AOB signatures reject malformed bytes', () => {
  assert.throws(() => findPattern(Buffer.from([1, 2]), 'GG'), /Invalid byte signature/);
});
