import { WxmpApp } from '../app.js';
import { AgentWorkflow } from '../workflows/agent.js';
import { bool, booleanProp, entry, int, numberProp, objectSchema, optionalText, result, stringProp } from './helpers.js';
import { ToolEntry } from './types.js';

export function buildAgentTools(app: WxmpApp): ToolEntry[] {
  const workflow = new AgentWorkflow(app);
  return [
    entry('wxmp_doctor', 'Inspect targets, runtime Profiles, bridge ownership, static backend, and existing sessions; returns concrete recovery actions.', objectSchema({}), async () => result(await workflow.doctor()), {
      annotations: { title: 'Diagnose WeChat Runtime', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }),
    entry('wxmp_open', 'Bootstrap or recover a complete mini-program reverse session: target, Profile, attach, runtime, context selection, request observation, snapshot, and package correlation.', objectSchema({
      session_id: stringProp('Existing session to recover after a runtime foreground/reload transition.'),
      pid: numberProp('Optional WMPF PID; defaults to the main process.'),
      project_name: stringProp('Optional evidence project name; defaults to AppID or PID.'),
      profile_path: stringProp('Optional explicit reviewed clean-room Profile.'),
      connect_timeout_ms: numberProp('Runtime bridge wait window.'),
      correlate_packages: booleanProp('Scan local wxapkg roots and correlate by AppID.'),
    }), async (args) => result(await workflow.open({
      sessionId: optionalText(args, 'session_id'),
      pid: args.pid === undefined ? undefined : int(args, 'pid', undefined, 1),
      projectName: optionalText(args, 'project_name'),
      profilePath: optionalText(args, 'profile_path'),
      connectTimeoutMs: int(args, 'connect_timeout_ms', 5000, 1, 120_000),
      correlatePackages: bool(args, 'correlate_packages', true),
    })), {
      annotations: { title: 'Open WeChat Miniapp Session', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }),
    entry('wxmp_status', 'Return workflow state, recovery actions, session capabilities, context graph, and evidence health.', objectSchema({
      session_id: stringProp('Session identifier.'),
    }, ['session_id']), async (args) => result(await workflow.status(String(args.session_id))), {
      annotations: { title: 'Read Session Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }),
    entry('wxmp_app_snapshot', 'Capture AppID/account/base-library/launch/page/storage/config state from the selected AppService context with bounded page data.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional expert WMPF logical context override.'),
      include_page_data: booleanProp('Include bounded page data.'),
      data_depth: numberProp('Maximum page/app data traversal depth.'),
      max_data_bytes: numberProp('Maximum serialized bytes per bounded data section.'),
    }, ['session_id']), async (args) => result(await workflow.snapshot(
      String(args.session_id),
      optionalText(args, 'context_id'),
      {
        includePageData: bool(args, 'include_page_data', true),
        dataDepth: int(args, 'data_depth', 2, 0, 5),
        maxDataBytes: int(args, 'max_data_bytes', 64 * 1024, 1024, 512 * 1024),
      },
    )), {
      annotations: { title: 'Capture Miniapp Snapshot', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }),
    entry('wxmp_observe_window', 'Observe a bounded interaction window and return non-destructive wx.request/fetch/XHR records, new CDP requests, cursor metadata, and an optional app snapshot.', objectSchema({
      session_id: stringProp('Session identifier.'),
      context_id: stringProp('Optional expert WMPF logical context override.'),
      duration_ms: numberProp('Observation duration.'),
      cursor: numberProp('Optional exclusive request-hook cursor.'),
      limit: numberProp('Maximum records per capture lane.'),
      include_snapshot: booleanProp('Capture app/page state at the end of the window.'),
    }, ['session_id']), async (args) => result(await workflow.observeWindow({
      sessionId: String(args.session_id),
      contextId: optionalText(args, 'context_id'),
      durationMs: int(args, 'duration_ms', 3000, 0, 30_000),
      cursor: args.cursor === undefined ? undefined : int(args, 'cursor', undefined, 0),
      limit: int(args, 'limit', 100, 1, 200),
      includeSnapshot: bool(args, 'include_snapshot', true),
    })), {
      annotations: { title: 'Observe Interaction Window', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }),
    entry('wxmp_close', 'Restore injected wrappers, detach the session, and export report/findings/triage plus the evidence manifest.', objectSchema({
      session_id: stringProp('Session identifier.'),
    }, ['session_id']), async (args) => result(await workflow.close(String(args.session_id))), {
      annotations: { title: 'Close and Export Session', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }),
  ];
}
