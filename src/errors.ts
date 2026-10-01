export interface RecoveryAdvice {
  retryable: boolean;
  needsUserAction: boolean;
  nextActions: string[];
  missingCapability?: string;
  userAction?: string;
}

export class WxmpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly recovery?: Partial<RecoveryAdvice>,
  ) {
    super(message);
    this.name = 'WxmpError';
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof WxmpError) {
    const recovery = { ...defaultRecovery(error.code), ...error.recovery };
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      ...recovery,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message, details: {} },
    ...defaultRecovery('INTERNAL_ERROR'),
  };
}

function defaultRecovery(code: string): RecoveryAdvice {
  if (code === 'TARGET_NOT_FOUND' || code === 'WMPF_VERSION_UNKNOWN') {
    return {
      retryable: true,
      needsUserAction: true,
      missingCapability: 'wmpfTarget',
      userAction: 'Open or foreground the target mini-program in PC WeChat, then retry wxmp_open.',
      nextActions: ['wxmp_doctor', 'wxmp_open'],
    };
  }
  if (['RUNTIME_NOT_CONNECTED', 'SESSION_DISCONNECTED', 'CDP_TIMEOUT', 'SESSION_NOT_WAITABLE'].includes(code)) {
    return {
      retryable: true,
      needsUserAction: code === 'RUNTIME_NOT_CONNECTED',
      missingCapability: 'runtimeBridge',
      userAction: code === 'RUNTIME_NOT_CONNECTED'
        ? 'Foreground or reload the target mini-program once, then resume wxmp_open with the same session.'
        : undefined,
      nextActions: ['wxmp_doctor', 'wxmp_open'],
    };
  }
  if (code.startsWith('EXTRACTOR_')) {
    return {
      retryable: false,
      needsUserAction: true,
      missingCapability: 'runtimeProfile',
      userAction: 'Install or configure WXMP_OFFSET_EXTRACTOR / WXMP_OFFSET_EXTRACTOR_PYTHON for wmpf-offset-adaptation.',
      nextActions: ['wxmp_doctor'],
    };
  }
  if (code.includes('PROFILE')) {
    return {
      retryable: false,
      needsUserAction: true,
      missingCapability: 'runtimeProfile',
      userAction: 'Generate and review a hash-bound Profile for the detected WMPF version, install it in a configured profile directory, then rerun wxmp_doctor.',
      nextActions: ['wxmp_doctor'],
    };
  }
  if (['NOT_PAUSED', 'CALL_FRAME_NOT_FOUND', 'SCOPE_NOT_FOUND', 'SCOPE_OBJECT_UNAVAILABLE'].includes(code)) {
    return {
      retryable: true,
      needsUserAction: false,
      missingCapability: 'debugger',
      nextActions: ['wxmp_pause', 'wxmp_get_paused_state'],
    };
  }
  if (code === 'BREAKPOINT_STALE' || code === 'WASM_NOT_FOUND' || code === 'WEBSOCKET_NOT_FOUND' || code === 'WASM_SOURCE_UNAVAILABLE') {
    return {
      retryable: false,
      needsUserAction: false,
      missingCapability: 'debugger',
      nextActions: ['wxmp_list_breakpoints', 'wxmp_list_scripts', 'wxmp_list_websockets'],
    };
  }
  if (code.includes('CONTEXT') || code.includes('TRACE_TARGET') || code.includes('REQUEST_HOOK_TARGET')) {
    return {
      retryable: true,
      needsUserAction: false,
      missingCapability: 'appContext',
      nextActions: ['wxmp_open', 'wxmp_status'],
    };
  }
  return { retryable: false, needsUserAction: false, nextActions: ['wxmp_doctor'] };
}
