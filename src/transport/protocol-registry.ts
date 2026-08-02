const KNOWN_CATEGORIES = new Set([
  'chromeDevtools',
  'chromeDevtoolsResult',
  'addJsContext',
  'removeJsContext',
]);

export function isKnownProtocolCategory(category: string): boolean {
  return KNOWN_CATEGORIES.has(category);
}

export function protocolArtifactName(seq: number | undefined, category: string, sha256: string): string {
  const safeCategory = (category || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return `protocol/${seq ?? 0}-${safeCategory}-${sha256.slice(0, 16)}.bin`;
}

export function knownProtocolCategories(): string[] {
  return [...KNOWN_CATEGORIES].sort();
}
