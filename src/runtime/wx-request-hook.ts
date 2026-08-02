import { WX_RUNTIME_RESOLVER_SOURCE } from './wx-runtime.js';

export function buildWxRequestHookSource(): string {
  return `(() => {
  const root = globalThis;
  if (root.__wxmpRequestHook && root.__wxmpRequestHook.active) {
    return { ok: true, reused: true, status: root.__wxmpRequestHook.status ? root.__wxmpRequestHook.status() : null };
  }
  ${WX_RUNTIME_RESOLVER_SOURCE}
  const runtime = __wxmpResolveRuntime();
  const wxObject = runtime.wx;

  const MAX_RECORDS = 200;
  const records = [];
  const originals = [];
  const installed = [];
  let sequence = 0;
  let dropped = 0;

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
    sequence += 1;
    entry.cursor = sequence;
    entry.requestId = 'hook-' + sequence;
    entry.transport = entry.type === 'XMLHttpRequest' ? 'xhr' : entry.type;
    entry.bodyEncoding = 'bounded-string-preview';
    if (records.length >= MAX_RECORDS) {
      records.shift();
      dropped += 1;
    }
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
  if (wxObject && typeof wxObject.request === 'function') {
    const original = wxObject.request;
    if (!original.__wxmpHooked) {
      wxObject.request = function (options) {
        const input = options && typeof options === 'object' ? options : {};
        const req = {
          type: 'wx.request',
          url: input.url || '',
          method: (input.method || 'GET').toUpperCase(),
          headers: input.header || {},
          body: safeString(input.data, 4000),
          timestamp: Date.now(),
          callStack: captureCallStack(),
          response: null
        };

        const origSuccess = input.success;
        const origFail = input.fail;
        const origComplete = input.complete;

        input.success = function (res) {
          req.response = {
            status: res.statusCode,
            body: safeString(res.data, 8000),
            headers: res.header || {}
          };
          pushRecord(req);
          if (typeof origSuccess === 'function') origSuccess(res);
        };
        input.fail = function (err) {
          req.response = { status: 0, body: safeString(err, 2000), headers: {} };
          pushRecord(req);
          if (typeof origFail === 'function') origFail(err);
        };
        input.complete = function (res) {
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

        return original.call(this, input);
      };
      wxObject.request.__wxmpHooked = true;
      originals.push({ object: wxObject, key: 'request', original: original });
      installed.push('wx.request');
    }
  }

  // Hook fetch
  if (typeof root.fetch === 'function') {
    const originalFetch = root.fetch;
    if (!originalFetch.__wxmpHooked) {
      root.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const headers = {};
        const headerSource = (init && init.headers) || (input && input.headers);
        if (headerSource) {
          if (typeof Headers !== 'undefined' && headerSource instanceof Headers) {
            headerSource.forEach(function (v, k) { headers[k] = v; });
          } else if (Array.isArray(headerSource)) {
            for (var h = 0; h < headerSource.length; h++) headers[String(headerSource[h][0])] = String(headerSource[h][1]);
          } else if (typeof headerSource === 'object') {
            Object.assign(headers, headerSource);
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
      installed.push('fetch');
    }
  }

  // Hook XMLHttpRequest without replacing the constructor.
  if (root.XMLHttpRequest && root.XMLHttpRequest.prototype) {
    const proto = root.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSetRequestHeader = proto.setRequestHeader;
    const originalSend = proto.send;
    if (typeof originalOpen === 'function' && typeof originalSend === 'function' && !originalSend.__wxmpHooked) {
      proto.open = function (method, url) {
        this.__wxmpMeta = {
          type: 'XMLHttpRequest',
          url: String(url || ''),
          method: String(method || 'GET').toUpperCase(),
          headers: {},
          timestamp: 0,
          callStack: '',
          response: null,
          recorded: false
        };
        return originalOpen.apply(this, arguments);
      };
      if (typeof originalSetRequestHeader === 'function') {
        proto.setRequestHeader = function (name, value) {
          if (this.__wxmpMeta) this.__wxmpMeta.headers[String(name)] = String(value);
          return originalSetRequestHeader.apply(this, arguments);
        };
      }
      proto.send = function (body) {
        const xhr = this;
        const meta = xhr.__wxmpMeta || {
          type: 'XMLHttpRequest', url: '', method: 'GET', headers: {}, response: null, recorded: false
        };
        meta.body = safeString(body, 4000);
        meta.timestamp = Date.now();
        meta.callStack = captureCallStack();
        xhr.__wxmpMeta = meta;
        const finalize = function () {
          if (meta.recorded) return;
          meta.recorded = true;
          let responseBody;
          try { responseBody = safeString(xhr.responseText, 8000); } catch (_) { responseBody = '[unavailable]'; }
          meta.response = {
            status: Number(xhr.status || 0),
            body: responseBody,
            headers: typeof xhr.getAllResponseHeaders === 'function' ? safeString(xhr.getAllResponseHeaders(), 4000) : ''
          };
          pushRecord(meta);
        };
        if (typeof xhr.addEventListener === 'function') xhr.addEventListener('loadend', finalize, { once: true });
        else {
          const previous = xhr.onreadystatechange;
          xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) finalize();
            if (typeof previous === 'function') return previous.apply(this, arguments);
          };
        }
        return originalSend.apply(xhr, arguments);
      };
      proto.send.__wxmpHooked = true;
      originals.push({ object: proto, key: 'open', original: originalOpen });
      if (typeof originalSetRequestHeader === 'function') originals.push({ object: proto, key: 'setRequestHeader', original: originalSetRequestHeader });
      originals.push({ object: proto, key: 'send', original: originalSend });
      installed.push('XMLHttpRequest');
    }
  }

  root.__wxmpRequestHook = {
    active: true,
    records: records,
    peek(cursor, limit) {
      const parsedCursor = Number(cursor);
      const after = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
      const parsedLimit = Number(limit);
      const boundedLimit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_RECORDS)
        : MAX_RECORDS;
      const snapshot = records.filter(function (record) { return record.cursor > after; }).slice(0, boundedLimit);
      return {
        records: snapshot,
        nextCursor: snapshot.length ? snapshot[snapshot.length - 1].cursor : after,
        oldestCursor: records.length ? records[0].cursor : sequence + 1,
        latestCursor: sequence,
        dropped: dropped,
        capacity: MAX_RECORDS,
        active: this.active
      };
    },
    drain() {
      return this.peek(0, MAX_RECORDS).records;
    },
    status() {
      return {
        active: this.active,
        installed: installed.slice(),
        oldestCursor: records.length ? records[0].cursor : sequence + 1,
        latestCursor: sequence,
        dropped: dropped,
        buffered: records.length,
        capacity: MAX_RECORDS
      };
    },
    stop() {
      for (var i = 0; i < originals.length; i++) {
        var entry = originals[i];
        entry.object[entry.key] = entry.original;
      }
      this.active = false;
      records.length = 0;
      return { restored: true, count: originals.length, installed: installed.slice(), latestCursor: sequence, dropped: dropped };
    }
  };

  return {
    ok: true,
    installed: installed.slice(),
    wrapped: installed.length,
    capabilities: {
      wx: Boolean(wxObject),
      fetch: typeof root.fetch === 'function',
      xhr: typeof root.XMLHttpRequest === 'function'
    },
    wxRuntimePath: runtime.path
  };
})()`;
}
