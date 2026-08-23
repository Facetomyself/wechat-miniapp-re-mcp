import { IndexedHit } from '../static/index-v2.js';

export type CorrelateConfidence = 'high' | 'medium' | 'low' | 'none';

export interface CorrelateJoin {
  kind: 'appId' | 'request' | 'script' | 'route' | 'initiator';
  confidence: CorrelateConfidence;
  reason: string;
  runtime: Record<string, unknown>;
  staticHit: Record<string, unknown> | null;
}

export interface CorrelateInput {
  appId?: string | null;
  scripts: Array<{ scriptId: string; url: string }>;
  requests: Array<{
    requestId: string;
    url: string;
    initiator?: Record<string, unknown>;
    hookCallStack?: unknown;
  }>;
  snapshotRoutes?: string[];
  packages: Array<{ appId: string; path: string }>;
  index?: {
    root: string;
    urls: string[];
    routes: string[];
    files?: string[];
    urlHits?: IndexedHit[];
    routeHits?: IndexedHit[];
    pages?: IndexedHit[];
    kind?: string;
  } | null;
}

export function correlateRuntimeStatic(input: CorrelateInput): {
  joins: CorrelateJoin[];
  summary: {
    appId: string | null;
    packageMatches: number;
    requestJoins: number;
    scriptJoins: number;
    routeJoins: number;
    initiatorJoins: number;
    unmatched: number;
    hasStaticIndex: boolean;
    indexKind?: string;
  };
} {
  const joins: CorrelateJoin[] = [];
  const appId = input.appId?.trim() || null;
  const packages = appId
    ? input.packages.filter((item) => item.appId.toLowerCase() === appId.toLowerCase())
    : [];

  if (!appId) {
    joins.push({
      kind: 'appId',
      confidence: 'none',
      reason: 'Runtime AppID is missing, so packages cannot be joined.',
      runtime: { appId: null },
      staticHit: null,
    });
  } else if (packages.length) {
    joins.push({
      kind: 'appId',
      confidence: 'high',
      reason: `Runtime AppID matched ${packages.length} local package path(s).`,
      runtime: { appId },
      staticHit: { matches: packages.slice(0, 20) },
    });
  } else if (input.packages.length) {
    joins.push({
      kind: 'appId',
      confidence: 'none',
      reason: `Scanned ${input.packages.length} package(s); none matched AppID ${appId}.`,
      runtime: { appId },
      staticHit: null,
    });
  } else {
    joins.push({
      kind: 'appId',
      confidence: 'none',
      reason: 'No local wxapkg packages were available to join with the runtime AppID.',
      runtime: { appId },
      staticHit: null,
    });
  }

  const index = input.index ?? null;
  for (const request of input.requests.slice(0, 50)) {
    if (!index) {
      joins.push({
        kind: 'request',
        confidence: 'none',
        reason: 'No restored source index was provided, so the request URL cannot be joined to static sources.',
        runtime: { requestId: request.requestId, url: request.url },
        staticHit: null,
      });
      continue;
    }
    const hit = matchUrl(request.url, index.urls, index.urlHits);
    joins.push({
      kind: 'request',
      confidence: hit ? hit.confidence : 'none',
      reason: hit
        ? `Request URL joined to static URL via ${hit.mode}${hit.location ? ` at ${hit.location.file}:${hit.location.line}` : ''}.`
        : 'No static URL matched this request pathname.',
      runtime: { requestId: request.requestId, url: request.url, pathname: pathnameOf(request.url) },
      staticHit: hit ? { url: hit.url, mode: hit.mode, location: hit.location ?? null, sourceConfidence: hit.sourceConfidence } : null,
    });
    const initiatorJoin = joinInitiator(request, index);
    if (initiatorJoin) joins.push(initiatorJoin);
  }

  const files = index?.files ?? [];
  for (const script of input.scripts.slice(0, 50)) {
    if (!script.url) {
      joins.push({
        kind: 'script',
        confidence: 'none',
        reason: 'Runtime script has an empty URL, so it cannot be joined.',
        runtime: { scriptId: script.scriptId, url: script.url },
        staticHit: null,
      });
      continue;
    }
    if (!index) {
      joins.push({
        kind: 'script',
        confidence: 'none',
        reason: 'No restored source index was provided, so the script URL cannot be joined.',
        runtime: { scriptId: script.scriptId, url: script.url },
        staticHit: null,
      });
      continue;
    }
    const base = basename(script.url);
    const fileHit = files.find((file) => basename(file) === base);
    const urlHit = matchUrl(script.url, index.urls);
    if (fileHit) {
      joins.push({
        kind: 'script',
        confidence: 'high',
        reason: 'Script basename matched a restored source file.',
        runtime: { scriptId: script.scriptId, url: script.url },
        staticHit: { file: fileHit },
      });
    } else if (urlHit) {
      joins.push({
        kind: 'script',
        confidence: urlHit.confidence,
        reason: `Script URL joined to static URL via ${urlHit.mode}.`,
        runtime: { scriptId: script.scriptId, url: script.url },
        staticHit: { url: urlHit.url, mode: urlHit.mode },
      });
    } else {
      joins.push({
        kind: 'script',
        confidence: 'none',
        reason: 'No restored file or static URL matched this script.',
        runtime: { scriptId: script.scriptId, url: script.url, basename: base },
        staticHit: null,
      });
    }
  }

  for (const route of (input.snapshotRoutes ?? []).slice(0, 50)) {
    if (!index) {
      joins.push({
        kind: 'route',
        confidence: 'none',
        reason: 'No restored source index was provided, so the route cannot be joined.',
        runtime: { route },
        staticHit: null,
      });
      continue;
    }
    const matched = matchRoute(route, index);
    joins.push({
      kind: 'route',
      confidence: matched ? matched.confidence : 'none',
      reason: matched
        ? `Snapshot route matched a static ${matched.source} route${matched.location ? ` at ${matched.location.file}:${matched.location.line}` : ''}.`
        : 'No static route matched this snapshot route.',
      runtime: { route },
      staticHit: matched,
    });
  }

  return {
    joins,
    summary: {
      appId,
      packageMatches: packages.length,
      requestJoins: joins.filter((item) => item.kind === 'request' && item.confidence !== 'none').length,
      scriptJoins: joins.filter((item) => item.kind === 'script' && item.confidence !== 'none').length,
      routeJoins: joins.filter((item) => item.kind === 'route' && item.confidence !== 'none').length,
      initiatorJoins: joins.filter((item) => item.kind === 'initiator' && item.confidence !== 'none').length,
      unmatched: joins.filter((item) => item.confidence === 'none').length,
      hasStaticIndex: Boolean(index),
      indexKind: index?.kind,
    },
  };
}

export function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname || '/';
  } catch {
    const pathOnly = url.split('?')[0];
    return pathOnly.startsWith('/') ? pathOnly : null;
  }
}

function matchUrl(
  url: string,
  staticUrls: string[],
  hits?: IndexedHit[],
): {
  url: string;
  mode: 'exact' | 'pathname';
  confidence: CorrelateConfidence;
  location?: { file: string; line: number };
  sourceConfidence?: string;
} | null {
  const exactHit = hits?.find((hit) => hit.value === url);
  if (exactHit) {
    return {
      url: exactHit.value,
      mode: 'exact',
      confidence: exactHit.confidence === 'structure' ? 'high' : 'medium',
      location: exactHit.location,
      sourceConfidence: exactHit.confidence,
    };
  }
  const exact = staticUrls.find((item) => item === url);
  if (exact) return { url: exact, mode: 'exact', confidence: 'high' };
  const path = pathnameOf(url);
  if (!path || path === '/') return null;
  const hitByPath = hits?.find((hit) => pathnameOf(hit.value) === path || hit.value.includes(path));
  if (hitByPath) {
    return {
      url: hitByPath.value,
      mode: 'pathname',
      confidence: 'medium',
      location: hitByPath.location,
      sourceConfidence: hitByPath.confidence,
    };
  }
  const byPath = staticUrls.find((item) => pathnameOf(item) === path || item.includes(path));
  if (byPath) return { url: byPath, mode: 'pathname', confidence: 'medium' };
  return null;
}

function matchRoute(route: string, index: NonNullable<CorrelateInput['index']>): {
  route: string;
  source: string;
  confidence: CorrelateConfidence;
  location: { file: string; line: number } | null;
} | null {
  const normalized = normalizeRoute(route);
  const page = index.pages?.find((item) => normalizeRoute(item.value) === normalized || normalizeRoute(item.value) === normalized.replace(/^\//, ''));
  if (page) {
    return {
      route: page.value,
      source: 'manifest-page',
      confidence: 'high',
      location: page.location ?? null,
    };
  }
  const hit = index.routeHits?.find((item) => normalizeRoute(item.value) === normalized);
  if (hit) {
    return {
      route: hit.value,
      source: hit.confidence === 'structure' ? 'manifest-page' : 'navigate-heuristic',
      confidence: hit.confidence === 'structure' ? 'high' : 'medium',
      location: hit.location ?? null,
    };
  }
  const matched = index.routes.find((item) => normalizeRoute(item) === normalized);
  return matched ? { route: matched, source: 'navigate-heuristic', confidence: 'high', location: null } : null;
}

function joinInitiator(
  request: CorrelateInput['requests'][number],
  index: NonNullable<CorrelateInput['index']>,
): CorrelateJoin | null {
  const candidates = initiatorUrls(request);
  if (!candidates.length) return null;
  const files = index.files ?? [];
  for (const candidate of candidates) {
    const base = basename(candidate);
    const fileHit = files.find((file) => basename(file) === base);
    if (fileHit) {
      return {
        kind: 'initiator',
        confidence: 'medium',
        reason: 'Request initiator URL basename matched a restored source file.',
        runtime: { requestId: request.requestId, initiatorUrl: candidate },
        staticHit: { file: fileHit },
      };
    }
  }
  return {
    kind: 'initiator',
    confidence: 'none',
    reason: 'Request initiator was present but did not match a restored source file.',
    runtime: { requestId: request.requestId, initiatorUrls: candidates },
    staticHit: null,
  };
}

function initiatorUrls(request: CorrelateInput['requests'][number]): string[] {
  const values: string[] = [];
  const initiator = request.initiator;
  if (typeof initiator?.url === 'string' && initiator.url) values.push(initiator.url);
  const stack = initiator?.stack && typeof initiator.stack === 'object' ? initiator.stack as Record<string, unknown> : null;
  const frames = Array.isArray(stack?.callFrames) ? stack.callFrames as Array<Record<string, unknown>> : [];
  for (const frame of frames) {
    if (typeof frame.url === 'string' && frame.url) values.push(frame.url);
  }
  if (typeof request.hookCallStack === 'string' && request.hookCallStack) values.push(request.hookCallStack);
  if (Array.isArray(request.hookCallStack)) {
    for (const item of request.hookCallStack) {
      if (typeof item === 'string' && item) values.push(item);
    }
  }
  return values;
}

function basename(value: string): string {
  const trimmed = value.split('?')[0].replace(/\\/g, '/');
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
}

function normalizeRoute(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}
