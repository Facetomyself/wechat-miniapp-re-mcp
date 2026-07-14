export function buildTraceScript(categories: string[]): string {
  const selected = JSON.stringify(categories);
  return `(() => {
    const root = globalThis;
    if (root.__wxmpTrace && root.__wxmpTrace.active) return { ok: true, reused: true };
    const selected = new Set(${selected});
    const originals = [];
    const emit = (kind, name, phase, payload) => {
      try {
        console.debug('__WXMP_TRACE__' + JSON.stringify({
          timestamp: Date.now(), kind, name, phase, payload
        }));
      } catch (_) {}
    };
    const wrap = (object, key, kind) => {
      if (!object || typeof object[key] !== 'function') return;
      const original = object[key];
      if (original.__wxmpWrapped) return;
      function wrapped(...args) {
        emit(kind, key, 'call', args);
        try {
          const result = original.apply(this, args);
          if (result && typeof result.then === 'function') {
            result.then((value) => emit(kind, key, 'resolve', value), (error) => emit(kind, key, 'reject', String(error)));
          } else emit(kind, key, 'return', result);
          return result;
        } catch (error) {
          emit(kind, key, 'throw', String(error));
          throw error;
        }
      }
      wrapped.__wxmpWrapped = true;
      originals.push([object, key, original]);
      object[key] = wrapped;
    };
    const wxObject = root.wx;
    if (wxObject) {
      const keys = Object.keys(wxObject);
      for (const key of keys) {
        const lower = key.toLowerCase();
        const kind = lower.includes('storage') ? 'storage'
          : lower.includes('navigate') || lower.includes('redirect') || lower.includes('launch') ? 'navigation'
          : lower.includes('request') || lower.includes('upload') || lower.includes('download') ? 'network'
          : 'wx';
        if (selected.has('all') || selected.has(kind) || selected.has('wx')) wrap(wxObject, key, kind);
      }
      if (wxObject.cloud && (selected.has('all') || selected.has('cloud'))) {
        for (const key of Object.keys(wxObject.cloud)) wrap(wxObject.cloud, key, 'cloud');
      }
    }
    root.__wxmpTrace = {
      active: true,
      stop() {
        for (const [object, key, original] of originals.splice(0)) object[key] = original;
        this.active = false;
        return { restored: true };
      }
    };
    return { ok: true, wrapped: originals.length, categories: Array.from(selected) };
  })()`;
}
