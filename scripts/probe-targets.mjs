// Quick target discovery probe
import { discoverTargets } from '../src/runtime/target-discovery.js';
const targets = await discoverTargets();
console.log(JSON.stringify({ ok: true, count: targets.length, targets: targets.map(t => ({
  pid: t.pid,
  version: t.version,
  processType: t.processType,
  isMain: t.isMain,
  appId: t.appId,
  exePath: t.executablePath,
})) }, null, 2));
