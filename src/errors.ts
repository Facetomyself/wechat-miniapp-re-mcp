export class WxmpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WxmpError';
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof WxmpError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'INTERNAL_ERROR', message, details: {} } };
}
