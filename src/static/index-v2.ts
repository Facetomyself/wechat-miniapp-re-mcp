export type IndexConfidence = 'structure' | 'heuristic';
export type PackageKind = 'main' | 'subpackage' | 'plugin' | 'minigame' | 'unknown';

export interface IndexLocation {
  file: string;
  line: number;
}

export interface IndexedHit {
  value: string;
  confidence: IndexConfidence;
  location?: IndexLocation;
}

export interface SubpackageEntry {
  root: string;
  pages: string[];
  location?: IndexLocation;
}

export interface PackageManifest {
  kind: PackageKind;
  pages: IndexedHit[];
  subPackages: SubpackageEntry[];
  tabBar: Array<{ pagePath: string; text?: string }>;
  usingComponents: Array<{ name: string; path: string; file: string }>;
  workers?: string;
  plugins: Array<{ name: string; version?: string; provider?: string }>;
  permissions: string[];
}

export interface StaticIndexV2 {
  schemaVersion: 2;
  root: string;
  generatedAt: string;
  kind: PackageKind;
  manifest: PackageManifest;
  fileCount: number;
  files: string[];
  urls: string[];
  wxApis: string[];
  routes: string[];
  urlHits: IndexedHit[];
  apiHits: IndexedHit[];
  routeHits: IndexedHit[];
  storageHits: IndexedHit[];
  cloudHits: IndexedHit[];
  summary: {
    kind: PackageKind;
    pages: number;
    subPackages: number;
    urls: number;
    apis: number;
    routes: number;
    storage: number;
    cloud: number;
    permissions: number;
    usingComponents: number;
  };
}

export interface IndexSourceFile {
  relativePath: string;
  size: number;
  content?: string;
}

const MAX_HITS = 2000;
const URL_RE = /https?:\/\/[^\s"'`<>]+/g;
const WX_API_RE = /\bwx\.([A-Za-z_$][\w$]*)/g;
const ROUTE_RE = /(?:navigateTo|redirectTo|reLaunch|switchTab)\s*\(\s*\{[^}]*?url\s*:\s*["'`]([^"'`]+)["'`]/g;
const STORAGE_RE = /\bwx\.(setStorage|getStorage|removeStorage|setStorageSync|getStorageSync|removeStorageSync|clearStorage|clearStorageSync)\b/g;
const CLOUD_RE = /\bwx\.cloud\.([A-Za-z_$][\w$]*)/g;

export function buildStaticIndexFromFiles(root: string, files: IndexSourceFile[], now = () => new Date().toISOString()): StaticIndexV2 {
  const posixFiles = files.map((file) => ({
    ...file,
    relativePath: toPosix(file.relativePath),
  }));
  const jsonFiles = new Map<string, unknown>();
  for (const file of posixFiles) {
    if (file.content !== undefined && file.relativePath.endsWith('.json')) {
      const parsed = parseJson(file.content);
      if (parsed) jsonFiles.set(file.relativePath, parsed);
    }
  }

  const kind = detectKind(jsonFiles, posixFiles.map((file) => file.relativePath));
  const manifest = buildManifest(kind, jsonFiles);
  const urlHits: IndexedHit[] = [];
  const apiHits: IndexedHit[] = [];
  const routeHits: IndexedHit[] = [...manifest.pages];
  const storageHits: IndexedHit[] = [];
  const cloudHits: IndexedHit[] = [];

  for (const file of posixFiles) {
    if (!file.content) continue;
    collectRegexHits(file, URL_RE, urlHits, (match) => match[0]);
    collectRegexHits(file, WX_API_RE, apiHits, (match) => match[1]);
    collectRegexHits(file, ROUTE_RE, routeHits, (match) => match[1]);
    collectRegexHits(file, STORAGE_RE, storageHits, (match) => match[1]);
    collectRegexHits(file, CLOUD_RE, cloudHits, (match) => `cloud.${match[1]}`);
  }

  const filesList = posixFiles.map((file) => file.relativePath).sort();
  const urls = uniqueValues(urlHits);
  const wxApis = uniqueValues(apiHits);
  const routes = uniqueValues(routeHits);
  return {
    schemaVersion: 2,
    root,
    generatedAt: now(),
    kind,
    manifest,
    fileCount: filesList.length,
    files: filesList,
    urls,
    wxApis,
    routes,
    urlHits: urlHits.slice(0, MAX_HITS),
    apiHits: apiHits.slice(0, MAX_HITS),
    routeHits: routeHits.slice(0, MAX_HITS),
    storageHits: storageHits.slice(0, MAX_HITS),
    cloudHits: cloudHits.slice(0, MAX_HITS),
    summary: {
      kind,
      pages: manifest.pages.length,
      subPackages: manifest.subPackages.length,
      urls: urls.length,
      apis: wxApis.length,
      routes: routes.length,
      storage: uniqueValues(storageHits).length,
      cloud: uniqueValues(cloudHits).length,
      permissions: manifest.permissions.length,
      usingComponents: manifest.usingComponents.length,
    },
  };
}

function detectKind(jsonFiles: Map<string, unknown>, files: string[]): PackageKind {
  if (jsonFiles.has('game.json')) return 'minigame';
  if (jsonFiles.has('plugin.json')) return 'plugin';
  if (jsonFiles.has('app.json')) return 'main';
  if (files.some((file) => file.startsWith('pages/'))) return 'subpackage';
  return 'unknown';
}

function buildManifest(kind: PackageKind, jsonFiles: Map<string, unknown>): PackageManifest {
  const appJson = asObject(jsonFiles.get('app.json'));
  const gameJson = asObject(jsonFiles.get('game.json'));
  const pluginJson = asObject(jsonFiles.get('plugin.json'));
  const source = appJson ?? gameJson ?? pluginJson ?? {};
  const pages = stringArray(source.pages).map((page) => ({
    value: page,
    confidence: 'structure' as const,
    location: locationForJsonKey(kind === 'minigame' ? 'game.json' : kind === 'plugin' ? 'plugin.json' : 'app.json', 'pages', page),
  }));
  const subPackages = parseSubpackages(source, kind === 'minigame' ? 'game.json' : 'app.json');
  const tabBarList = asObject(source.tabBar)?.list;
  const tabBar = Array.isArray(tabBarList)
    ? tabBarList.flatMap((item) => {
      const record = asObject(item);
      const pagePath = typeof record?.pagePath === 'string' ? record.pagePath : '';
      if (!pagePath) return [];
      return [{ pagePath, text: typeof record?.text === 'string' ? record.text : undefined }];
    })
    : [];
  const plugins = parsePlugins(source.plugins);
  const permissions = [
    ...Object.keys(asObject(source.permission) ?? {}),
    ...stringArray(source.requiredPrivateInfos),
    ...stringArray(source.requiredBackgroundModes),
  ];
  const usingComponents: PackageManifest['usingComponents'] = [];
  for (const [file, value] of jsonFiles) {
    const components = asObject(asObject(value)?.usingComponents);
    if (!components) continue;
    for (const [name, componentPath] of Object.entries(components)) {
      if (typeof componentPath === 'string' && componentPath) {
        usingComponents.push({ name, path: componentPath, file });
      }
    }
  }
  return {
    kind,
    pages,
    subPackages,
    tabBar,
    usingComponents,
    workers: typeof source.workers === 'string' ? source.workers : undefined,
    plugins,
    permissions: [...new Set(permissions)],
  };
}

function parseSubpackages(source: Record<string, unknown>, file: string): SubpackageEntry[] {
  const raw = source.subPackages ?? source.subpackages;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const record = asObject(item);
    const root = typeof record?.root === 'string' ? record.root : '';
    if (!root) return [];
    return [{
      root,
      pages: stringArray(record?.pages),
      location: { file, line: 1 },
    }];
  });
}

function parsePlugins(value: unknown): Array<{ name: string; version?: string; provider?: string }> {
  const record = asObject(value);
  if (!record) return [];
  return Object.entries(record).map(([name, spec]) => {
    const object = asObject(spec);
    return {
      name,
      version: typeof object?.version === 'string' ? object.version : undefined,
      provider: typeof object?.provider === 'string' ? object.provider : undefined,
    };
  });
}

function collectRegexHits(
  file: IndexSourceFile,
  pattern: RegExp,
  output: IndexedHit[],
  valueOf: (match: RegExpMatchArray) => string,
): void {
  if (!file.content || output.length >= MAX_HITS) return;
  const lines = file.content.split(/\r?\n/);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (let index = 0; index < lines.length && output.length < MAX_HITS; index += 1) {
    global.lastIndex = 0;
    for (const match of lines[index].matchAll(global)) {
      const value = valueOf(match);
      if (!value) continue;
      output.push({
        value,
        confidence: 'heuristic',
        location: { file: file.relativePath, line: index + 1 },
      });
      if (output.length >= MAX_HITS) return;
    }
  }
}

function uniqueValues(hits: IndexedHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.value))].sort();
}

function locationForJsonKey(file: string, _key: string, _value: string): IndexLocation {
  return { file, line: 1 };
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}
