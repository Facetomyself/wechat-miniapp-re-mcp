import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceScript } from '../src/runtime/trace-script.js';
import { buildReplayExpression, buildReplayPlan, buildWxApiExpression, buildCloudFunctionExpression } from '../src/runtime/expressions.js';

test('trace script wraps wx API categories selectively', () => {
  const all = buildTraceScript(['all']);
  assert.ok(all.includes('selected.has(\'all\')'));
  assert.ok(all.includes('wrap(wxObject, key, kind)'));

  const networkOnly = buildTraceScript(['network']);
  // The condition always checks 'all' but the Set only contains 'network'
  assert.ok(networkOnly.includes('"network"'));

  const multi = buildTraceScript(['wx', 'cloud', 'storage']);
  assert.ok(multi.includes('"wx"'));
  assert.ok(multi.includes('"cloud"'));
  assert.ok(multi.includes('"storage"'));

  // All returned expressions are valid JS
  for (const expression of [all, networkOnly, multi]) {
    assert.doesNotThrow(() => new Function(`return ${expression};`));
  }
});

test('replay expression constructs fetch with correct method and headers', () => {
  const expression = buildReplayExpression({
    url: 'https://api.example.com/v1/data',
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer t' },
    body: '{"key":"value"}',
  });
  assert.ok(expression.includes('fetch'));
  assert.ok(expression.includes('PUT'));
  assert.ok(expression.includes('Content-Type'));
  assert.ok(expression.includes('key'));
  assert.ok(expression.includes('value'));
  assert.doesNotThrow(() => new Function(`return ${expression};`));
});

test('wx API expression handles nested options', () => {
  const expression = buildWxApiExpression('login', { timeout: 5000, force: true });
  assert.ok(expression.includes('__wxmpResolveRuntime'));
  assert.ok(expression.includes('"login"'));
  assert.ok(expression.includes('"timeout"'));
  assert.doesNotThrow(() => new Function(`return ${expression};`));
});

test('cloud function expression includes name and data', () => {
  const expression = buildCloudFunctionExpression('getUserInfo', { userId: 'abc', fields: ['name', 'email'] });
  assert.ok(expression.includes('getUserInfo'));
  assert.ok(expression.includes('userId'));
  assert.ok(expression.includes('wx.cloud.callFunction'));
  assert.doesNotThrow(() => new Function(`return ${expression};`));
});

test('all runtime expressions are syntactically valid', () => {
  const expressions = [
    buildReplayExpression({ url: 'https://e.test', method: 'GET', headers: {} }),
    buildReplayExpression({ url: 'https://e.test', method: 'DELETE', headers: { 'x': 'y' }, body: 'data' }),
    buildWxApiExpression('request', { url: 'https://e.test' }),
    buildWxApiExpression('setStorage', { key: 'k', data: { nested: true } }),
    buildCloudFunctionExpression('test', { a: 1, b: 'two' }),
    buildCloudFunctionExpression('empty', {}),
    buildTraceScript([]),
    buildTraceScript(['all']),
    buildTraceScript(['wx']),
    buildTraceScript(['network', 'storage']),
    buildTraceScript(['cloud', 'navigation']),
  ];
  for (const expression of expressions) {
    assert.doesNotThrow(() => new Function(`return ${expression};`), `Invalid expression: ${expression.slice(0, 60)}`);
  }
});

test('replay plans preserve known transports and disclose CDP downgrade', () => {
  const wxPlan = buildReplayPlan({
    url: 'https://api.test', method: 'POST', headers: {}, body: '{}', transport: 'wx.request',
  });
  assert.equal(wxPlan.usedTransport, 'wx.request');
  assert.equal(wxPlan.semanticDowngrade, null);
  assert.ok(wxPlan.expression.includes('runtime.wx.request'));

  const xhrPlan = buildReplayPlan({ url: 'https://api.test', method: 'GET', headers: {}, transport: 'xhr' });
  assert.equal(xhrPlan.usedTransport, 'xhr');
  assert.doesNotThrow(() => new Function(`return ${xhrPlan.expression};`));

  const cdpPlan = buildReplayPlan({ url: 'https://api.test', method: 'GET', headers: {}, transport: 'cdp' });
  assert.equal(cdpPlan.usedTransport, 'fetch');
  assert.deepEqual(cdpPlan.semanticDowngrade, {
    from: 'cdp',
    to: 'fetch',
    reason: 'CDP Network observes requests but does not expose the initiating application transport.',
  });
});
