export function buildWxRequestHookSource(): string {
  return `(() => {
  const root = globalThis;
  if (root.__wxmpRequestHook && root.__wxmpRequestHook.active) {
    return { ok: true, reused: true };
  }

  const MAX_RECORDS = 200;
  const records = [];
  const originals = [];

  function safeString(value, maxLen) {
    if (value === undefined || value === null) return undefined;
    try {
      const s = typeof value === 'string' ? value : JSON.stringify(value);
      return s.length > (maxLen || 4000) ? s.slice(0, maxLen || 4000) + '...(truncated)' : s;
    } catch (_) {
      return '[unserializable]';
    }
  }

  function captureCallStack() {
    try {
      const stack = new Error().stack || '';
      const lines = stack.split(/\\r?\\n/).slice(2, 8);
      return lines.join('\\n');
    } catch (_) {
      return '';
    }
  }

  function pushRecord(entry) {
    if (records.length >= MAX_RECORDS) records.shift();
    records.push(entry);
    try {
      console.debug('__WXMP_TRACE__' + JSON.stringify({
        category: 'wx_request_hook',
        data: {
          type: entry.type,
          url: entry.url,
          method: entry.method,
          status: entry.response ? entry.response.status : undefined,
          timestamp: entry.timestamp
        }
      }));
    } catch (_) {}
  }

  // Hook wx.request
  if (root.wx && typeof root.wx.request === 'function') {
    const original = root.wx.request;
    if (!original.__wxmpHooked) {
      root.wx.request = function (options) {
        const req = {
          type: 'wx.request',
          url: (options || {}).url || '',
          method: ((options || {}).method || 'GET').toUpperCase(),
          headers: (options || {}).header || {},
          body: safeString((options || {}).data, 4000),
          timestamp: Date.now(),
          callStack: captureCallStack(),
          response: null
        };

        const origSuccess = (options || {}).success;
        const origFail = (options || {}).fail;
        const origComplete = (options || {}).complete;

        options.success = function (res) {
          req.response = {
            status: res.statusCode,
            body: safeString(res.data, 8000),
            headers: res.header || {}
          };
          pushRecord(req);
          if (typeof origSuccess === 'function') origSuccess(res);
        };
        options.fail = function (err) {
          req.response = { status: 0, body: safeString(err, 2000), headers: {} };
          pushRecord(req);
          if (typeof origFail === 'function') origFail(err);
        };
        options.complete = function (res) {
          if (!req.response && res) {
            req.response = {
              status: res.statusCode || 0,
              body: safeString(res.data, 8000),
              headers: res.header || {}
            };
            pushRecord(req);
          }
          if (typeof origComplete === 'function') origComplete(res);
        };

        return original.call(this, options);
      };
      root.wx.request.__wxmpHooked = true;
      originals.push({ object: root.wx, key: 'request', original: original });
    }
  }

  // Hook fetch
  if (typeof root.fetch === 'function') {
    const originalFetch = root.fetch;
    if (!originalFetch.__wxmpHooked) {
      root.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || 'GET';
        const headers = {};
        if (init && init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach(function (v, k) { headers[k] = v; });
          } else if (typeof init.headers === 'object') {
            Object.assign(headers, init.headers);
          }
        }
        const req = {
          type: 'fetch',
          url: url,
          method: method.toUpperCase(),
          headers: headers,
          body: safeString(init && init.body, 4000),
          timestamp: Date.now(),
          callStack: captureCallStack(),
          response: null
        };

        return originalFetch.call(this, input, init).then(function (res) {
          return res.clone().text().then(function (body) {
            req.response = {
              status: res.status,
              body: safeString(body, 8000),
              headers: Object.fromEntries(res.headers.entries())
            };
            pushRecord(req);
            return res;
          }).catch(function () {
            req.response = { status: res.status, body: undefined, headers: {} };
            pushRecord(req);
            return res;
          });
        }).catch(function (err) {
          req.response = { status: 0, body: safeString(err.message || String(err), 2000), headers: {} };
          pushRecord(req);
          throw err;
        });
      };
      root.fetch.__wxmpHooked = true;
      originals.push({ object: root, key: 'fetch', original: originalFetch });
    }
  }

  root.__wxmpRequestHook = {
    active: true,
    records: records,
    drain() {
      const snapshot = records.splice(0);
      return snapshot;
    },
    stop() {
      for (var i = 0; i < originals.length; i++) {
        var entry = originals[i];
        entry.object[entry.key] = entry.original;
      }
      this.active = false;
      records.length = 0;
      return { restored: true, count: originals.length };
    }
  };

  return { ok: true, capabilities: { wx: typeof root.wx !== 'undefined', fetch: typeof root.fetch === 'function' } };
})()`;
}
