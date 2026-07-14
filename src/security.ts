import path from 'node:path';
import { WxmpError } from './errors.js';

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|session|jwt|key)$/i;

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value.length > 8192 ? `${value.slice(0, 8192)}...[truncated:${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function safeProjectName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new WxmpError('INVALID_PROJECT_NAME', `Invalid project name: ${value}`);
  }
  return normalized.slice(0, 100);
}

export function resolveInside(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WxmpError('PATH_OUTSIDE_WORKSPACE', 'Resolved path escapes the configured workspace', {
      root: resolvedRoot,
      target,
    });
  }
  return target;
}
