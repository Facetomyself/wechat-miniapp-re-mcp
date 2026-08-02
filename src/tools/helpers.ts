import { WxmpError } from '../errors.js';
import { ToolEntry, ToolOptions } from './types.js';

type Schema = Record<string, unknown>;
export const stringProp = (description: string): Schema => ({ type: 'string', description });
export const numberProp = (description: string): Schema => ({ type: 'number', description });
export const booleanProp = (description: string): Schema => ({ type: 'boolean', description });

export function objectSchema(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const OUTPUT_SCHEMA: NonNullable<ToolEntry['tool']['outputSchema']> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: {},
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
      required: ['code', 'message', 'details'],
      additionalProperties: false,
    },
    retryable: { type: 'boolean' },
    needsUserAction: { type: 'boolean' },
    missingCapability: { type: 'string' },
    userAction: { type: 'string' },
    nextActions: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
  additionalProperties: false,
};

export function entry(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: ToolEntry['handler'],
  options: ToolOptions = {},
): ToolEntry {
  const title = options.title ?? titleFromName(name);
  const annotations = options.annotations ?? inferAnnotations(name, title);
  return {
    tool: {
      name,
      title,
      description,
      inputSchema: inputSchema as ToolEntry['tool']['inputSchema'],
      outputSchema: options.outputSchema ?? OUTPUT_SCHEMA,
      annotations,
    },
    handler,
    visibility: options.visibility ?? 'expert',
  };
}

export function text(args: Record<string, unknown>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (!required) return '';
  throw new WxmpError('INVALID_ARGUMENT', `${key} must be a non-empty string`);
}

export function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function num(args: Record<string, unknown>, key: string, fallback?: number): number {
  if (args[key] === undefined && fallback !== undefined) return fallback;
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WxmpError('INVALID_ARGUMENT', `${key} must be numeric`);
  return value;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  if (args[key] === undefined) return fallback;
  if (typeof args[key] !== 'boolean') throw new WxmpError('INVALID_ARGUMENT', `${key} must be boolean`);
  return args[key];
}

export function int(args: Record<string, unknown>, key: string, fallback?: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const value = num(args, key, fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WxmpError('INVALID_ARGUMENT', `${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new WxmpError('INVALID_ARGUMENT', `${key} must be a string array`);
  }
  return value as string[];
}

export function result(data: unknown) {
  const structuredContent = { ok: true, data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function safeFile(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }
export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function titleFromName(name: string): string {
  return name
    .replace(/^wxmp_/, '')
    .split('_')
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function inferAnnotations(name: string, title: string) {
  const readOnly = /_(health|doctor|status|info|list|search|scan|probe|snapshot|get|query|detect|validate)(?:_|$)/.test(name)
    && !/_(build_index|open|observe)/.test(name);
  const destructive = /_(close|detach|remove(?:_|$)|repack|promote|call(?:_|$)|replay|evaluate$|raw_cdp|raw_adapter|set_breakpoint|pause$|resume$|step_)/.test(name);
  const idempotent = readOnly;
  const openWorld = /_(attach|open|wait|capture|trace|hook|request|cloud|api|evaluate|debugger|decompile|unpack|repack|raw|proxy)/.test(name);
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: idempotent,
    openWorldHint: openWorld,
  };
}
