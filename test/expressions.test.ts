import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudFunctionExpression, buildReplayExpression, buildWxApiExpression } from '../src/runtime/expressions.js';
import { buildTraceScript } from '../src/runtime/trace-script.js';

test('runtime injection expressions are syntactically valid', () => {
  const expressions = [
    buildReplayExpression({ url: 'https://example.test', method: 'POST', headers: { 'x-test': '1' }, body: '{}' }),
    buildWxApiExpression('request', { url: 'https://example.test' }),
    buildCloudFunctionExpression('fixture', { value: 1 }),
    buildTraceScript(['all']),
  ];
  for (const expression of expressions) {
    assert.doesNotThrow(() => new Function(`return ${expression};`));
  }
});
