import { WX_RUNTIME_RESOLVER_SOURCE } from './wx-runtime.js';

export interface ReplayInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export function buildReplayExpression(request: ReplayInput): string {
  return `(async()=>{const r=await fetch(${JSON.stringify(request.url)},{method:${JSON.stringify(request.method)},headers:${JSON.stringify(request.headers)},body:${JSON.stringify(request.body)}});return {status:r.status,statusText:r.statusText,headers:Object.fromEntries(r.headers.entries()),body:await r.text()};})()`;
}

export function buildWxApiExpression(api: string, options: unknown): string {
  return `(async()=>{${WX_RUNTIME_RESOLVER_SOURCE};const runtime=__wxmpResolveRuntime();const fn=runtime.wx?.[${JSON.stringify(api)}];if(typeof fn!=='function')throw new Error('wx API unavailable: '+${JSON.stringify(api)});const input=${JSON.stringify(options)};return await new Promise((resolve,reject)=>fn.call(runtime.wx,{...input,success:(value)=>resolve({ok:true,value}),fail:(error)=>reject(error)}));})()`;
}

export function buildCloudFunctionExpression(name: string, data: unknown): string {
  return `(async()=>{${WX_RUNTIME_RESOLVER_SOURCE};const runtime=__wxmpResolveRuntime();const cloud=runtime.wx?.cloud;if(!cloud?.callFunction)throw new Error('wx.cloud.callFunction unavailable');return await cloud.callFunction(${JSON.stringify({ name, data })});})()`;
}
