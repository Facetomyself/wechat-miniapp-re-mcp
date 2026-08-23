import { WxmpError } from '../errors.js';
import { SessionState } from '../types.js';

export const DEFAULT_RUNTIME_WAIT_MS = 60_000;
export const MIN_DEFAULT_RUNTIME_WAIT_MS = 30_000;
export const MAX_DEFAULT_RUNTIME_WAIT_MS = 90_000;

export function resolveRuntimeWaitMs(explicit?: number): number {
  if (explicit === undefined) return DEFAULT_RUNTIME_WAIT_MS;
  if (!Number.isSafeInteger(explicit) || explicit < 1) {
    throw new WxmpError('INVALID_ARGUMENT', 'Runtime wait timeout must be a positive integer', { explicit });
  }
  return explicit;
}

export const PARKED_STATES: readonly SessionState[] = ['waiting_for_runtime', 'disconnected'];
export const TERMINAL_STATES: readonly SessionState[] = ['closed', 'failed'];
export const WAITABLE_STATES: readonly SessionState[] = [
  'created',
  'attaching',
  'waiting_for_runtime',
  'connected',
  'disconnected',
];

export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  created: ['attaching', 'failed', 'detaching', 'closed'],
  attaching: ['waiting_for_runtime', 'connected', 'disconnected', 'failed', 'detaching'],
  waiting_for_runtime: ['connected', 'disconnected', 'failed', 'detaching'],
  connected: ['disconnected', 'failed', 'detaching'],
  disconnected: ['connected', 'waiting_for_runtime', 'failed', 'detaching'],
  detaching: ['closed', 'failed'],
  failed: ['detaching', 'closed'],
  closed: [],
};

export type WorkflowPhase =
  | 'discover'
  | 'profile'
  | 'attach'
  | 'wait_runtime'
  | 'probe'
  | 'observe_bootstrap'
  | 'ready'
  | 'parked'
  | 'failed'
  | 'closed';

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true;
  return SESSION_TRANSITIONS[from].includes(to);
}

export function transitionSessionState(from: SessionState, to: SessionState): SessionState {
  if (from === to) return to;
  if (!canTransition(from, to)) {
    throw new WxmpError('SESSION_STATE_INVALID', `Illegal session transition ${from} -> ${to}`, { from, to });
  }
  return to;
}

export function isParkedState(state: SessionState): boolean {
  return (PARKED_STATES as readonly string[]).includes(state);
}

export function isTerminalState(state: SessionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isWaitableState(state: SessionState): boolean {
  return (WAITABLE_STATES as readonly string[]).includes(state);
}

export function workflowPhase(input: {
  hasSession: boolean;
  state?: SessionState;
  profileInjectable?: boolean;
  bridgeConnected?: boolean;
  hasSelectedContext?: boolean;
  observationBootstrapped?: boolean;
}): WorkflowPhase {
  if (!input.hasSession || !input.state) return 'discover';
  if (input.state === 'closed') return 'closed';
  if (input.state === 'failed') return 'failed';
  if (isParkedState(input.state)) return 'parked';
  if (input.state === 'created' || input.state === 'attaching') {
    return input.profileInjectable === false ? 'profile' : 'attach';
  }
  if (input.state === 'detaching') return 'closed';
  if (input.state === 'connected') {
    if (!input.bridgeConnected) return 'wait_runtime';
    if (!input.hasSelectedContext) return 'probe';
    if (!input.observationBootstrapped) return 'observe_bootstrap';
    return 'ready';
  }
  return 'attach';
}
