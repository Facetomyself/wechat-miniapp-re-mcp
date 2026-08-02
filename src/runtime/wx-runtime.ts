export const WX_RUNTIME_RESOLVER_SOURCE = `
function __wxmpResolveRuntime() {
  const root = globalThis;
  const candidates = [];
  const seen = [];

  function add(value, path, priority) {
    try {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return;
      for (let i = 0; i < seen.length; i++) {
        if (seen[i] === value) return;
      }
      seen.push(value);
      candidates.push({ value, path, priority });
    } catch (_) {}
  }

  add(root, 'globalThis', 80);
  try { add(root.nav && root.nav.wxFrame, 'globalThis.nav.wxFrame', 120); } catch (_) {}
  try { add(root.wxFrame, 'globalThis.wxFrame', 110); } catch (_) {}
  try { if (root.parent && root.parent !== root) add(root.parent, 'globalThis.parent', 40); } catch (_) {}
  try { if (root.top && root.top !== root) add(root.top, 'globalThis.top', 30); } catch (_) {}

  for (let index = 0; index < candidates.length && index < 32; index++) {
    const candidate = candidates[index];
    const value = candidate.value;
    try { add(value.nav && value.nav.wxFrame, candidate.path + '.nav.wxFrame', 115); } catch (_) {}
    try {
      const frames = value.frames;
      const count = Math.min(Number(frames && frames.length) || 0, 16);
      for (let frameIndex = 0; frameIndex < count; frameIndex++) {
        try { add(frames[frameIndex], candidate.path + '.frames[' + frameIndex + ']', 60); } catch (_) {}
      }
    } catch (_) {}
  }

  let best = null;
  let bestScore = -1;
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      const wxObject = candidate.value.wx;
      if (!wxObject || (typeof wxObject !== 'object' && typeof wxObject !== 'function')) continue;
      let score = candidate.priority;
      if (typeof wxObject.request === 'function') score += 50;
      if (typeof candidate.value.getCurrentPages === 'function') score += 25;
      if (candidate.value.__wxConfig) score += 20;
      if (wxObject.cloud && typeof wxObject.cloud.callFunction === 'function') score += 10;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    } catch (_) {}
  }

  const wxRoot = best ? best.value : root;
  let wxObject;
  let config;
  let library;
  try { wxObject = best ? wxRoot.wx : undefined; } catch (_) {}
  try { config = wxRoot.__wxConfig; } catch (_) {}
  try { library = wxRoot.__wxLibrary || root.__wxLibrary || {}; } catch (_) { library = {}; }
  return {
    root,
    wxRoot,
    wx: wxObject,
    config,
    library,
    path: best ? best.path : '',
    hasGetCurrentPages: typeof wxRoot.getCurrentPages === 'function'
  };
}`;

export function buildWxRuntimeProbeExpression(): string {
  return `(() => {
    ${WX_RUNTIME_RESOLVER_SOURCE}
    const runtime = __wxmpResolveRuntime();
    const library = runtime.library || {};
    let href = '';
    let wxRuntimeHref = '';
    try { href = runtime.root.location?.href || ''; } catch (_) {}
    try { wxRuntimeHref = runtime.wxRoot.location?.href || ''; } catch (_) {}
    return {
      hasWx: Boolean(runtime.wx),
      hasWxRequest: typeof runtime.wx?.request === 'function',
      hasWxConfig: Boolean(runtime.config),
      hasGetCurrentPages: runtime.hasGetCurrentPages,
      wxRuntimePath: runtime.path,
      wxRuntimeHref,
      contextType: typeof library.contextType === 'string' ? library.contextType : '',
      envType: typeof library.envType === 'string' ? library.envType : '',
      href
    };
  })()`;
}

export function buildWxAppSnapshotExpression(options: {
  includePageData?: boolean;
  dataDepth?: number;
  maxDataBytes?: number;
} = {}): string {
  const includePageData = options.includePageData !== false;
  const dataDepth = Math.max(0, Math.min(5, Math.trunc(options.dataDepth ?? 2)));
  const maxDataBytes = Math.max(1024, Math.min(512 * 1024, Math.trunc(options.maxDataBytes ?? 64 * 1024)));
  return `(() => {
    ${WX_RUNTIME_RESOLVER_SOURCE}
    const runtime = __wxmpResolveRuntime();
    const errors = [];
    function attempt(name, fn, fallback) {
      try { return fn(); } catch (error) { errors.push({ name, message: String(error && error.message || error) }); return fallback; }
    }
    function bounded(value, depth, budget) {
      const seen = [];
      function visit(input, level) {
        if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') return input;
        if (typeof input === 'string') return input.length > 2000 ? input.slice(0, 2000) + '...(truncated)' : input;
        if (typeof input === 'function') return '[Function]';
        if (level > depth) return '[DepthLimit]';
        if (typeof input !== 'object') return String(input);
        if (seen.indexOf(input) >= 0) return '[Circular]';
        seen.push(input);
        if (Array.isArray(input)) return input.slice(0, 100).map(function (item) { return visit(item, level + 1); });
        const output = {};
        const keys = Object.keys(input).slice(0, 200);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          try { output[key] = visit(input[key], level + 1); } catch (_) { output[key] = '[Unavailable]'; }
        }
        return output;
      }
      const result = visit(value, 0);
      let encoded = '';
      try { encoded = JSON.stringify(result); } catch (_) { return { value: '[Unserializable]', truncated: true, bytes: 0 }; }
      if (encoded.length <= budget) return { value: result, truncated: false, bytes: encoded.length };
      return { value: encoded.slice(0, budget), truncated: true, bytes: encoded.length, encoding: 'json-preview' };
    }
    const wxObject = runtime.wx;
    const config = runtime.config || {};
    const accountInfo = attempt('wx.getAccountInfoSync', function () { return wxObject && wxObject.getAccountInfoSync ? wxObject.getAccountInfoSync() : null; }, null);
    const systemInfo = attempt('wx.getSystemInfoSync', function () { return wxObject && wxObject.getSystemInfoSync ? wxObject.getSystemInfoSync() : null; }, null);
    const launchOptions = attempt('wx.getLaunchOptionsSync', function () { return wxObject && wxObject.getLaunchOptionsSync ? wxObject.getLaunchOptionsSync() : null; }, null);
    const enterOptions = attempt('wx.getEnterOptionsSync', function () { return wxObject && wxObject.getEnterOptionsSync ? wxObject.getEnterOptionsSync() : null; }, null);
    const storageInfo = attempt('wx.getStorageInfoSync', function () { return wxObject && wxObject.getStorageInfoSync ? wxObject.getStorageInfoSync() : null; }, null);
    const pages = attempt('getCurrentPages', function () { return runtime.hasGetCurrentPages ? runtime.wxRoot.getCurrentPages() : []; }, []);
    const pageStack = Array.isArray(pages) ? pages.slice(-30).map(function (page) {
      const route = String(page && (page.route || page.__route__) || '');
      const output = { route, options: bounded(page && page.options || {}, 2, 8192) };
      if (${JSON.stringify(includePageData)}) output.data = bounded(page && page.data, ${dataDepth}, ${maxDataBytes});
      return output;
    }) : [];
    const app = attempt('getApp', function () { return typeof runtime.wxRoot.getApp === 'function' ? runtime.wxRoot.getApp() : null; }, null);
    const configAppId = config.appId || config.appid || config.accountInfo && config.accountInfo.appId || '';
    const accountMiniProgram = accountInfo && accountInfo.miniProgram || {};
    return {
      capturedAt: new Date().toISOString(),
      runtimePath: runtime.path,
      identity: {
        appId: accountMiniProgram.appId || configAppId || '',
        envVersion: accountMiniProgram.envVersion || config.envVersion || '',
        version: accountMiniProgram.version || config.version || '',
        provenance: accountMiniProgram.appId ? 'wx.getAccountInfoSync' : configAppId ? '__wxConfig' : 'unavailable'
      },
      library: {
        sdkVersion: systemInfo && systemInfo.SDKVersion || runtime.library && (runtime.library.version || runtime.library.SDKVersion) || '',
        platform: systemInfo && systemInfo.platform || '',
        system: systemInfo && systemInfo.system || '',
        contextType: runtime.library && runtime.library.contextType || '',
        envType: runtime.library && runtime.library.envType || ''
      },
      launchOptions: bounded(launchOptions, 3, 16384),
      enterOptions: bounded(enterOptions, 3, 16384),
      pageStack,
      currentRoute: pageStack.length ? pageStack[pageStack.length - 1].route : '',
      storage: storageInfo ? {
        keys: Array.isArray(storageInfo.keys) ? storageInfo.keys.slice(0, 500) : [],
        currentSize: storageInfo.currentSize,
        limitSize: storageInfo.limitSize
      } : null,
      app: app ? { globalData: bounded(app.globalData, ${dataDepth}, ${maxDataBytes}) } : null,
      config: bounded(config, 2, ${maxDataBytes}),
      capabilities: {
        hasWx: Boolean(wxObject),
        hasRequest: typeof wxObject?.request === 'function',
        hasCloud: Boolean(wxObject?.cloud),
        hasGetCurrentPages: runtime.hasGetCurrentPages
      },
      errors
    };
  })()`;
}
