import test from 'node:test';
import assert from 'node:assert/strict';
import { WxmpError, errorPayload } from '../src/errors.js';

test('WxmpError serializes code, message, and details', () => {
  const error = new WxmpError('TEST_CODE', 'Something went wrong', { pid: 1234, file: 'test.ts' });
  const payload = errorPayload(error);
  assert.deepEqual(payload, {
    ok: false,
    error: {
      code: 'TEST_CODE',
      message: 'Something went wrong',
      details: { pid: 1234, file: 'test.ts' },
    },
    retryable: false,
    needsUserAction: false,
    nextActions: ['wxmp_doctor'],
  });
  const profilePayload = errorPayload(new WxmpError('PROFILE_NOT_FOUND', 'No reviewed Profile is available'));
  assert.equal(profilePayload.needsUserAction, true);
  assert.equal(profilePayload.missingCapability, 'runtimeProfile');
  assert.match(String(profilePayload.userAction), /hash-bound Profile/);
  const extractorPayload = errorPayload(new WxmpError('EXTRACTOR_UNAVAILABLE', 'missing extractor'));
  assert.equal(extractorPayload.needsUserAction, true);
  assert.equal(extractorPayload.missingCapability, 'runtimeProfile');
  assert.match(String(extractorPayload.userAction), /WXMP_OFFSET_EXTRACTOR/);
});

test('errorPayload wraps generic Error as INTERNAL_ERROR', () => {
  const payload = errorPayload(new Error('generic failure'));
  assert.equal((payload.error as Record<string, unknown>).code, 'INTERNAL_ERROR');
  assert.equal((payload.error as Record<string, unknown>).message, 'generic failure');
});

test('errorPayload handles non-Error throws', () => {
  const payload = errorPayload('raw string error');
  assert.equal((payload.error as Record<string, unknown>).code, 'INTERNAL_ERROR');
  assert.equal((payload.error as Record<string, unknown>).message, 'raw string error');
});

test('errorPayload handles null', () => {
  const payload = errorPayload(null);
  assert.equal((payload.error as Record<string, unknown>).code, 'INTERNAL_ERROR');
  assert.equal((payload.error as Record<string, unknown>).message, 'null');
});
