import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCdpPayload, decodeEnvelope, encodeCdpEnvelope } from '../src/transport/codec.js';

test('WMPF CDP envelope round-trips without compression', () => {
  const payload = JSON.stringify({ id: 7, method: 'Runtime.enable', params: {} });
  const encoded = encodeCdpEnvelope(42, payload, 'context-1');
  const envelope = decodeEnvelope(encoded);
  assert.equal(envelope.seq, 42);
  assert.equal(envelope.category, 'chromeDevtools');
  const inner = decodeCdpPayload(envelope.data);
  assert.equal(inner.payload, payload);
  assert.equal(inner.jscontextId, 'context-1');
});
