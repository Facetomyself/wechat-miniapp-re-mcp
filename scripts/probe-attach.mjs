// Real-target attach probe using compiled MCP modules.
import { loadConfig } from '../build/src/config.js';
import { SessionManager } from '../build/src/sessions/manager.js';

const cfg = loadConfig();
console.error('[probe] config:', JSON.stringify({ workspaceRoot: cfg.workspaceRoot, legacyProfileDirs: cfg.legacyProfileDirs }));

const mgr = new SessionManager(cfg);
const targets = await mgr.listTargets();
const main = targets.find(t => t.isMain);
if (!main) { console.error('[probe] no main WMPF process'); process.exit(1); }
console.error(`[probe] main: PID=${main.pid} version=${main.version}`);

try {
  console.error('[probe] attaching...');
  const session = await mgr.attach({ pid: main.pid, projectName: 'probe-test', connectTimeoutMs: 5000 });
  console.log(JSON.stringify({
    ok: true, sessionId: session.id, state: session.state,
    target: { pid: session.target.pid, version: session.target.version },
    profile: { version: session.profile.wmpfVersion, provenance: session.profile.provenance },
    capabilities: session.capabilities,
    bridgeConnected: mgr.bridge.isConnected(session.id),
    contexts: [...session.contexts.values()],
  }, null, 2));

  console.error('[probe] waiting 5s for CDP events...');
  await new Promise(r => setTimeout(r, 5000));
  console.error(`[probe] bridge=${mgr.bridge.isConnected(session.id)} contexts=${session.contexts.size} scripts=${session.channel.scripts.size}`);

  console.error('[probe] detaching...');
  await mgr.detach(session.id);
  console.error('[probe] done');
} catch (error) {
  console.error('[probe] FAILED:', error.message);
  process.exit(1);
} finally {
  await mgr.shutdown().catch(() => {});
}
