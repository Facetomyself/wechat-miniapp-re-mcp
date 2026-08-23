import { CdpExecutionContext, WmpfContext } from '../types.js';

export function inferContextRole(context: WmpfContext): WmpfContext['role'] {
  const marker = `${context.contextType ?? ''} ${context.envType ?? ''} ${context.name}`.toLowerCase();
  if (marker.includes('game')) return 'minigame';
  if (marker.includes('service') || marker.includes('maincontext') || marker.includes('subcontext') || context.hasWx) {
    return 'appservice';
  }
  if (marker.includes('webview') || marker.includes('render')) return 'webview';
  if (marker.includes('worker')) return 'worker';
  return 'unknown';
}

export function contextScore(context: WmpfContext): number {
  if (context.hasWx) return 100;
  if (context.role === 'appservice') return 80;
  if (context.hasWxConfig) return 60;
  if (context.role === 'minigame') return 50;
  if (context.role === 'webview') return 30;
  return 0;
}

export function selectBestContextId(contexts: Iterable<WmpfContext>): string {
  const next = [...contexts]
    .filter((context) => context.active !== false)
    .sort((left, right) => contextScore(right) - contextScore(left))[0];
  return next?.id ?? '';
}

export function classifyContextKind(name: string): WmpfContext['kind'] {
  const lower = name.toLowerCase();
  if (lower.includes('game')) return 'minigame';
  if (lower.includes('app') || lower.includes('service')) return 'miniapp';
  return 'unknown';
}

export function mergeExecutionContext(
  existing: WmpfContext | undefined,
  value: CdpExecutionContext,
  runtimeGeneration: number,
): WmpfContext {
  return {
    ...existing,
    id: value.wmpfContextId ?? existing?.id ?? '',
    name: existing?.name || value.name || '',
    kind: existing?.kind && existing.kind !== 'unknown' ? existing.kind : value.kind,
    role: existing?.role && existing.role !== 'unknown' ? existing.role : value.role,
    origin: value.origin ?? existing?.origin,
    probeConfidence: existing?.probeConfidence ?? 'unprobed',
    connectedAt: existing?.connectedAt ?? value.createdAt,
    capabilities: existing?.capabilities ?? ['evaluate', 'capability-probe'],
    provenance: [...new Set([...(existing?.provenance ?? []), 'cdp.executionContext.route'])],
    runtimeGeneration,
    active: true,
  };
}
