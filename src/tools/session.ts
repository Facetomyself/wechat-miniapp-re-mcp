import { WxmpApp } from '../app.js';
import { VERSION } from '../version.js';
import { DEFAULT_RUNTIME_WAIT_MS } from '../sessions/machine.js';
import { entry, int, numberProp, objectSchema, optionalText, result, stringProp, text } from './helpers.js';
import { ToolEntry } from './types.js';

export function buildSessionTools(app: WxmpApp): ToolEntry[] {
  return [
    entry('wxmp_health', 'Report cold-start health and lazy runtime capabilities.', objectSchema({}), async () => result({
        name: 'wechat-miniapp-re-mcp', version: VERSION, platform: process.platform,
        toolset: app.config.toolset,
        workspaceRoot: app.config.workspaceRoot, bridge: app.sessions.bridge.info(), staticAdapter: app.staticAdapter.info(),
        profileDirs: app.config.profileDirs, signatureDbPaths: app.config.signatureDbPaths,
        evidence: { queryLimit: app.config.eventLimit, maxEvents: app.config.maxEvidenceEvents, maxBytes: app.config.maxEvidenceBytes },
        protocolRecorder: { previewBytes: app.config.protocolPreviewBytes, maxArtifactBytes: app.config.maxProtocolArtifactBytes },
        startupRequiresTarget: false,
    })),

    entry('wxmp_list_targets', 'Discover PC WeChat WMPF processes and runtime metadata.', objectSchema({}), async () => result(await app.sessions.listTargets())),

    entry('wxmp_list_sessions', 'List all MCP-managed WMPF sessions.', objectSchema({}), async () => result(app.sessions.list().map((s) => app.sessions.publicStatus(s)))),

    entry('wxmp_attach', 'Attach Frida to a WMPF main process and wait for the local debug bridge.', objectSchema({
      pid: numberProp('Optional WeChatAppEx.exe PID; defaults to the main WMPF browser process.'),
      project_name: stringProp('Workspace project name used for evidence output.'),
      profile_path: stringProp('Optional explicit clean-room profile JSON path.'),
      connect_timeout_ms: numberProp('How long to wait for a WMPF debug WebSocket connection.'),
    }, ['project_name']), async (args) => {
      const session = await app.sessions.attach({
        pid: args.pid === undefined ? undefined : int(args, 'pid', undefined, 1),
        projectName: text(args, 'project_name'),
        profilePath: optionalText(args, 'profile_path'),
        connectTimeoutMs: args.connect_timeout_ms === undefined ? undefined : int(args, 'connect_timeout_ms', undefined, 1, 120_000),
      });
      return result(app.sessions.publicStatus(session));
    }),

    entry('wxmp_detach', 'Detach a WMPF session and release Frida, CDP, proxy, and bridge state.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => {
      await app.sessions.detach(text(args, 'session_id'));
      return result({ sessionId: text(args, 'session_id'), state: 'closed' });
    }),

    entry('wxmp_session_status', 'Read one session state, capabilities, contexts, and evidence path.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.publicStatus(app.sessions.get(text(args, 'session_id'))))),

    entry('wxmp_wait_for_runtime', 'Wait for an attached or disconnected WMPF session to connect again without reinjecting Frida.', objectSchema({ session_id: stringProp('Session identifier.'), timeout_ms: numberProp('Wait timeout in milliseconds.') }, ['session_id']), async (args) => result(await app.sessions.waitForRuntime(text(args, 'session_id'), int(args, 'timeout_ms', DEFAULT_RUNTIME_WAIT_MS, 1, 120_000)))),

    entry('wxmp_list_contexts', 'List JS contexts observed for a WMPF session.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => {
      const session = app.sessions.get(text(args, 'session_id'));
      return result({ selectedContextId: session.selectedContextId, contexts: [...session.contexts.values()] });
    }),

    entry('wxmp_select_context', 'Select the default JS context for subsequent tools.', objectSchema({
      session_id: stringProp('Session identifier.'), context_id: stringProp('WMPF JS context identifier.'),
    }, ['session_id', 'context_id']), async (args) => result(app.sessions.selectContext(text(args, 'session_id'), text(args, 'context_id')))),

    entry('wxmp_probe_contexts', 'Probe every observed runtime context and select the strongest AppService/wx-capable candidate.', objectSchema({
      session_id: stringProp('Session identifier.'),
    }, ['session_id']), async (args) => {
      const sessionId = text(args, 'session_id');
      const contexts = await app.sessions.probeContexts(sessionId);
      const session = app.sessions.get(sessionId);
      return result({ selectedContextId: session.selectedContextId, contexts });
    }),

    entry('wxmp_get_runtime_info', 'Return target, profile, bridge, context, and capability information.', objectSchema({ session_id: stringProp('Session identifier.') }, ['session_id']), async (args) => result(app.sessions.publicStatus(app.sessions.get(text(args, 'session_id'))))),
  ];
}
