import { WxmpError } from '../errors.js';
import { ToolEntry } from './types.js';

type Schema = Record<string, unknown>;
export const stringProp = (description: string): Schema => ({ type: 'string', description });
export const numberProp = (description: string): Schema => ({ type: 'number', description });
export const booleanProp = (description: string): Schema => ({ type: 'boolean', description });

export function objectSchema(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export function entry(name: string, description: string, inputSchema: Schema, handler: ToolEntry['handler']): ToolEntry {
  return { tool: { name, description, inputSchema: inputSchema as ToolEntry['tool']['inputSchema'] }, handler };
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
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new WxmpError('INVALID_ARGUMENT', `${key} must be numeric`);
  return value;
}

export function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  return args[key] === undefined ? fallback : Boolean(args[key]);
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
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data }, null, 2) }] };
}

export function safeFile(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }
export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
