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
