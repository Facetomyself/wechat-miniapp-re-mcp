import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RUNTIME_WAIT_MS,
  MAX_DEFAULT_RUNTIME_WAIT_MS,
  MIN_DEFAULT_RUNTIME_WAIT_MS,
  SESSION_TRANSITIONS,
  canTransition,
  isParkedState,
  isTerminalState,
  isWaitableState,
  resolveRuntimeWaitMs,
  transitionSessionState,
  workflowPhase,
} from '../src/sessions/machine.js';
import { WxmpError } from '../src/errors.js';
import { SessionState } from '../src/types.js';

const ALL_STATES: SessionState[] = [
  'created',
  'attaching',
  'waiting_for_runtime',
  'connected',
  'disconnected',
  'detaching',
  'closed',
  'failed',
];

test('omitted runtime wait resolves inside the contract default window', () => {
  const resolved = resolveRuntimeWaitMs();
  assert.equal(resolved >= MIN_DEFAULT_RUNTIME_WAIT_MS, true);
  assert.equal(resolved <= MAX_DEFAULT_RUNTIME_WAIT_MS, true);
  assert.equal(resolved, DEFAULT_RUNTIME_WAIT_MS);
  assert.equal(resolveRuntimeWaitMs(1), 1);
  assert.throws(
    () => resolveRuntimeWaitMs(0),
    (error: unknown) => error instanceof WxmpError && error.code === 'INVALID_ARGUMENT',
  );
});

test('session transition table covers every SessionState', () => {
  assert.deepEqual(Object.keys(SESSION_TRANSITIONS).sort(), [...ALL_STATES].sort());
});

test('same-state transitions are no-ops', () => {
  for (const state of ALL_STATES) {
    assert.equal(canTransition(state, state), true);
    assert.equal(transitionSessionState(state, state), state);
  }
});

test('parked, terminal, and waitable partitions match the runtime contract', () => {
  assert.equal(isParkedState('waiting_for_runtime'), true);
  assert.equal(isParkedState('disconnected'), true);
  assert.equal(isParkedState('connected'), false);
  assert.equal(isTerminalState('closed'), true);
  assert.equal(isTerminalState('failed'), true);
  assert.equal(isTerminalState('waiting_for_runtime'), false);
  assert.equal(isWaitableState('waiting_for_runtime'), true);
  assert.equal(isWaitableState('disconnected'), true);
  assert.equal(isWaitableState('failed'), false);
  assert.equal(isWaitableState('closed'), false);
  assert.equal(isWaitableState('detaching'), false);
});

test('documented live-path transitions remain legal', () => {
  const path: SessionState[] = [
    'created',
    'attaching',
    'waiting_for_runtime',
    'connected',
    'disconnected',
    'connected',
    'detaching',
    'closed',
  ];
  for (let index = 1; index < path.length; index += 1) {
    assert.equal(canTransition(path[index - 1], path[index]), true, `${path[index - 1]} -> ${path[index]}`);
  }
});

test('attach-failure cleanup failed -> detaching -> failed is legal', () => {
  assert.equal(transitionSessionState('attaching', 'failed'), 'failed');
  assert.equal(transitionSessionState('failed', 'detaching'), 'detaching');
  assert.equal(transitionSessionState('detaching', 'failed'), 'failed');
});

test('illegal transitions throw SESSION_STATE_INVALID', () => {
  assert.throws(
    () => transitionSessionState('closed', 'connected'),
    (error: unknown) => error instanceof WxmpError && error.code === 'SESSION_STATE_INVALID',
  );
  assert.throws(
    () => transitionSessionState('connected', 'created'),
    (error: unknown) => error instanceof WxmpError && error.code === 'SESSION_STATE_INVALID',
  );
});

test('workflowPhase maps parked and ready without renaming SessionState', () => {
  assert.equal(workflowPhase({ hasSession: false }), 'discover');
  assert.equal(workflowPhase({ hasSession: true, state: 'attaching' }), 'attach');
  assert.equal(workflowPhase({ hasSession: true, state: 'attaching', profileInjectable: false }), 'profile');
  assert.equal(workflowPhase({ hasSession: true, state: 'waiting_for_runtime' }), 'parked');
  assert.equal(workflowPhase({ hasSession: true, state: 'disconnected' }), 'parked');
  assert.equal(workflowPhase({
    hasSession: true,
    state: 'connected',
    bridgeConnected: true,
    hasSelectedContext: true,
    observationBootstrapped: true,
  }), 'ready');
  assert.equal(workflowPhase({
    hasSession: true,
    state: 'connected',
    bridgeConnected: true,
    hasSelectedContext: false,
  }), 'probe');
  assert.equal(workflowPhase({ hasSession: true, state: 'failed' }), 'failed');
  assert.equal(workflowPhase({ hasSession: true, state: 'closed' }), 'closed');
});
