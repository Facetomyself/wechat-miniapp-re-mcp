import { WX_RUNTIME_RESOLVER_SOURCE } from './wx-runtime.js';

export interface ReplayInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  transport?: 'wx.request' | 'fetch' | 'xhr' | 'cdp';
}

export interface ReplayPlan {
  expression: string;
  requestedTransport: ReplayInput['transport'];
  usedTransport: Exclude<ReplayInput['transport'], 'cdp'>;
  semanticDowngrade: null | {
    from: string;
    to: string;
    reason: string;
  };
}

export function buildReplayExpression(request: ReplayInput): string {
  return buildReplayPlan(request).expression;
}

export function buildReplayPlan(request: ReplayInput, requestedTransport = request.transport ?? 'fetch'): ReplayPlan {
  const requested = requestedTransport ?? 'fetch';
  const used = requested === 'cdp' ? 'fetch' : requested;
  const semanticDowngrade = requested === 'cdp'
    ? { from: 'cdp', to: 'fetch', reason: 'CDP Network observes requests but does not expose the initiating application transport.' }
    : null;
  const payload = JSON.stringify({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  if (used === 'wx.request') {
    return {
      expression: `(async()=>{${WX_RUNTIME_RESOLVER_SOURCE};const runtime=__wxmpResolveRuntime();if(typeof runtime.wx?.request!=='function')throw new Error('wx.request unavailable');const q=${payload};return await new Promise((resolve,reject)=>runtime.wx.request({url:q.url,method:q.method,header:q.headers,data:q.body,success:(r)=>resolve({status:r.statusCode,statusText:r.errMsg||'',headers:r.header||{},body:r.data,transport:'wx.request'}),fail:reject}));})()`,
      requestedTransport: requested,
      usedTransport: used,
      semanticDowngrade,
    };
  }
  if (used === 'xhr') {
    return {
      expression: `(async()=>{const q=${payload};if(typeof XMLHttpRequest!=='function')throw new Error('XMLHttpRequest unavailable');return await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open(q.method,q.url,true);for(const [k,v] of Object.entries(q.headers||{}))x.setRequestHeader(k,v);x.onloadend=()=>resolve({status:x.status,statusText:x.statusText,headers:x.getAllResponseHeaders(),body:x.responseText,transport:'xhr'});x.onerror=()=>reject(new Error('XMLHttpRequest replay failed'));x.send(q.body===undefined?null:q.body);});})()`,
      requestedTransport: requested,
      usedTransport: used,
      semanticDowngrade,
    };
  }
  return {
    expression: `(async()=>{const q=${payload};const init={method:q.method,headers:q.headers};if(q.body!==undefined&&!/^(GET|HEAD)$/i.test(q.method))init.body=q.body;const r=await fetch(q.url,init);return {status:r.status,statusText:r.statusText,headers:Object.fromEntries(r.headers.entries()),body:await r.text(),transport:'fetch'};})()`,
    requestedTransport: requested,
    usedTransport: 'fetch',
    semanticDowngrade,
  };
}

export function buildWxApiExpression(api: string, options: unknown): string {
  return `(async()=>{${WX_RUNTIME_RESOLVER_SOURCE};const runtime=__wxmpResolveRuntime();const fn=runtime.wx?.[${JSON.stringify(api)}];if(typeof fn!=='function')throw new Error('wx API unavailable: '+${JSON.stringify(api)});const input=${JSON.stringify(options)};return await new Promise((resolve,reject)=>fn.call(runtime.wx,{...input,success:(value)=>resolve({ok:true,value}),fail:(error)=>reject(error)}));})()`;
}

export function buildCloudFunctionExpression(name: string, data: unknown): string {
  return `(async()=>{${WX_RUNTIME_RESOLVER_SOURCE};const runtime=__wxmpResolveRuntime();const cloud=runtime.wx?.cloud;if(!cloud?.callFunction)throw new Error('wx.cloud.callFunction unavailable');return await cloud.callFunction(${JSON.stringify({ name, data })});})()`;
}
