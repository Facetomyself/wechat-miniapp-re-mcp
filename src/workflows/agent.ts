import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { buildWxRequestHookSource } from '../runtime/wx-request-hook.js';
import { buildWxAppSnapshotExpression } from '../runtime/wx-runtime.js';
import { extractRemoteValue } from '../transport/cdp-channel.js';
import { TargetProcess } from '../types.js';
import { WxmpSession } from '../sessions/manager.js';

export interface OpenWorkflowOptions {
  sessionId?: string;
  pid?: number;
  projectName?: string;
  profilePath?: string;
  connectTimeoutMs?: number;
  correlatePackages?: boolean;
}

export class AgentWorkflow {
  constructor(private readonly app: WxmpApp) {}

  async doctor(): Promise<Record<string, unknown>> {
    let targets: TargetProcess[] = [];
    let discoveryError: string | undefined;
    try {
      targets = await this.app.sessions.listTargets();
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : String(error);
    }
    const profiles: Array<Record<string, unknown>> = [];
    for (const target of targets.filter((item) => item.version)) {
      try {
        const loaded = await this.app.sessions.profileManager().load(target.version!);
        const probe = await this.app.sessions.profileManager().probe(target, loaded.profile);
        let injectable = true;
        let injectionBlock: string | undefined;
        try {
          this.app.sessions.profileManager().assertInjectable(loaded.profile);
        } catch (error) {
          injectable = false;
          injectionBlock = error instanceof Error ? error.message : String(error);
        }
        profiles.push({ pid: target.pid, version: target.version, path: loaded.path, injectable, injectionBlock, probe });
      } catch (error) {
        profiles.push({
          pid: target.pid,
          version: target.version,
          available: false,
          error: error instanceof WxmpError
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'PROFILE_PROBE_FAILED', message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    const targetReady = targets.length > 0;
    const profileReady = profiles.some((profile) => profile.injectable === true && (profile.probe as Record<string, unknown> | undefined)?.valid === true);
    const profileAction = 'Generate and review a hash-bound Profile for the detected WMPF version, install it in a configured profile directory, then rerun wxmp_doctor.';
    const state = !targetReady ? 'needs_user_action' : profileReady ? 'ready_to_open' : 'degraded';
    return {
      state,
      retryable: !targetReady,
      needsUserAction: !targetReady || !profileReady,
      missingCapability: !targetReady ? 'wmpfTarget' : !profileReady ? 'runtimeProfile' : undefined,
      userAction: !targetReady ? 'Open or foreground the target mini-program in PC WeChat.' : !profileReady ? profileAction : undefined,
      nextActions: targetReady && profileReady ? ['wxmp_open'] : ['wxmp_doctor'],
      targetCount: targets.length,
      targets,
      profiles,
      discoveryError,
      bridge: this.app.sessions.bridge.info(),
      staticAdapter: this.app.staticAdapter.info(),
      sessions: this.app.sessions.list().map((session) => this.app.sessions.publicStatus(session)),
    };
  }

  async open(options: OpenWorkflowOptions): Promise<Record<string, unknown>> {
    let session: WxmpSession | undefined;
    let selectedTarget: TargetProcess | undefined;
    let attachedThisCall = false;
    if (options.sessionId) {
      session = this.app.sessions.get(options.sessionId);
    } else {
      const targets = await this.app.sessions.listTargets();
      selectedTarget = options.pid
        ? targets.find((target) => target.pid === options.pid)
        : targets.find((target) => target.isMain) ?? targets[0];
      if (!selectedTarget) {
        return {
          state: 'needs_user_action',
          retryable: true,
          needsUserAction: true,
          missingCapability: 'wmpfTarget',
          userAction: 'Open or foreground the target mini-program in PC WeChat, then retry wxmp_open.',
          nextActions: ['wxmp_doctor', 'wxmp_open'],
        };
      }
      session = [...this.app.sessions.list()].reverse().find((candidate) => (
        candidate.target.pid === selectedTarget!.pid && !['closed', 'failed'].includes(candidate.state)
      ));
      if (!session) {
        const inferredProject = selectedTarget.appId || `wxmp-${selectedTarget.pid}`;
        session = await this.app.sessions.attach({
          pid: selectedTarget.pid,
          projectName: options.projectName?.trim() || inferredProject,
          profilePath: options.profilePath,
          connectTimeoutMs: options.connectTimeoutMs ?? 5000,
        });
        attachedThisCall = true;
      }
    }

    if (!attachedThisCall && ['waiting_for_runtime', 'disconnected'].includes(session.state)) {
      await this.app.sessions.waitForRuntime(session.id, options.connectTimeoutMs ?? 5000);
    }
    if (session.state !== 'connected' || !this.app.sessions.bridge.isConnected(session.id)) {
      return {
        ...workflowState(session),
        sessionId: session.id,
        status: this.app.sessions.publicStatus(session),
        contextGraph: this.app.sessions.contextGraph(session.id),
      };
    }

    await this.app.sessions.probeContexts(session.id).catch(async (error) => {
      await session!.evidence.append('agent.open_context_probe_gap', { error: error instanceof Error ? error.message : String(error) });
    });
    const hook = await this.ensureRequestHook(session);
    const snapshotResult = session.selectedContextId
      ? await this.snapshot(session.id, session.selectedContextId, { includePageData: true, dataDepth: 2, maxDataBytes: 64 * 1024 }).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      : null;
    let packageCorrelation: Record<string, unknown> | null = null;
    if (options.correlatePackages !== false) {
      const appId = snapshotAppId(snapshotResult) || session.target.appId;
      if (appId) {
        try {
          const packages = await this.app.staticAdapter.scan([], 500);
          const matches = packages.filter((item) => item.appId.toLowerCase() === appId.toLowerCase());
          packageCorrelation = { appId, matches, scanned: packages.length, confidence: matches.length ? 'high' : 'none' };
        } catch (error) {
          packageCorrelation = { appId, matches: [], error: error instanceof Error ? error.message : String(error), confidence: 'none' };
        }
      }
    }
    const state = workflowState(session);
    await session.evidence.append('agent.open_completed', {
      state: state.state,
      selectedContextId: session.selectedContextId,
      hook,
      packageCorrelation,
    }, { contextId: session.selectedContextId, operation: 'wxmp_open' });
    return {
      ...state,
      sessionId: session.id,
      status: this.app.sessions.publicStatus(session),
      contextGraph: this.app.sessions.contextGraph(session.id),
      requestObservation: hook,
      snapshot: snapshotResult,
      packageCorrelation,
    };
  }

  async status(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.app.sessions.get(sessionId);
    return {
      ...workflowState(session),
      status: this.app.sessions.publicStatus(session),
      contextGraph: this.app.sessions.contextGraph(sessionId),
      evidence: await session.evidence.status(),
    };
  }

  async snapshot(
    sessionId: string,
    requestedContextId: string | undefined,
    options: { includePageData?: boolean; dataDepth?: number; maxDataBytes?: number },
  ): Promise<Record<string, unknown>> {
    const session = this.app.sessions.get(sessionId);
    const contextId = requestedContextId || session.selectedContextId;
    if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'No AppService context is available for the application snapshot', { sessionId });
    const response = await session.channel.send('Runtime.evaluate', {
      expression: buildWxAppSnapshotExpression(options),
      awaitPromise: true,
      returnByValue: true,
    }, contextId, 15_000);
    const value = checkedRuntimeValue(response, 'application snapshot');
    await session.evidence.append('app.snapshot', value, { contextId, operation: 'wxmp_app_snapshot' });
    return { sessionId, contextId, snapshot: value };
  }

  async observeWindow(options: {
    sessionId: string;
    contextId?: string;
    durationMs: number;
    cursor?: number;
    limit: number;
    includeSnapshot: boolean;
  }): Promise<Record<string, unknown>> {
    const session = this.app.sessions.get(options.sessionId);
    const contextId = options.contextId || session.selectedContextId;
    if (!contextId) throw new WxmpError('CONTEXT_NOT_SELECTED', 'No AppService context is available for observation', { sessionId: options.sessionId });
    await this.ensureRequestHook(session, contextId);
    const beforeKeys = new Set(session.channel.requests.keys());
    const statusResponse = await session.channel.send('Runtime.evaluate', {
      expression: 'globalThis.__wxmpRequestHook?.status?.() ?? {active:false,latestCursor:0,dropped:0}',
      returnByValue: true,
    }, contextId);
    const hookStatus = checkedRuntimeValue(statusResponse, 'request hook status') as Record<string, unknown> | undefined;
    const cursor = options.cursor ?? Number(hookStatus?.latestCursor ?? 0);
    const startedAt = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, options.durationMs));
    const expression = `globalThis.__wxmpRequestHook ? globalThis.__wxmpRequestHook.peek(${cursor},${options.limit}) : {records:[],nextCursor:${cursor},oldestCursor:0,latestCursor:0,dropped:0,active:false}`;
    const captureResponse = await session.channel.send('Runtime.evaluate', { expression, returnByValue: true }, contextId);
    const captureValue = checkedRuntimeValue(captureResponse, 'request hook observation');
    const capture = captureValue && typeof captureValue === 'object' ? captureValue as Record<string, unknown> : { records: [] };
    const records = Array.isArray(capture.records) ? capture.records as Array<Record<string, unknown>> : [];
    session.channel.indexHookRecords(records, contextId);
    const cdpRequests = [...session.channel.requests.entries()]
      .filter(([key, request]) => !beforeKeys.has(key) && request.transport === 'cdp')
      .map(([, request]) => request);
    const snapshot = options.includeSnapshot
      ? await this.snapshot(options.sessionId, contextId, { includePageData: true, dataDepth: 2, maxDataBytes: 64 * 1024 }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
      : null;
    const output = {
      sessionId: options.sessionId,
      contextId,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: options.durationMs,
      hook: { ...capture, count: records.length },
      cdp: { count: cdpRequests.length, requests: cdpRequests.slice(0, options.limit) },
      snapshot,
    };
    await session.evidence.append('agent.observe_window', output, { contextId, operation: 'wxmp_observe_window' });
    return output;
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.app.sessions.get(sessionId);
    const contextId = session.selectedContextId;
    if (contextId && this.app.sessions.bridge.isConnected(sessionId)) {
      if (session.capabilities.requestHook) {
        await session.channel.send('Runtime.evaluate', {
          expression: 'globalThis.__wxmpRequestHook?.stop?.() ?? {restored:false}',
          returnByValue: true,
        }, contextId, 5000).catch(() => undefined);
      }
      if (session.capabilities.wxTrace) {
        await session.channel.send('Runtime.evaluate', {
          expression: 'globalThis.__wxmpTrace?.stop?.() ?? {restored:false}',
          returnByValue: true,
        }, contextId, 5000).catch(() => undefined);
      }
    }
    await this.app.sessions.detach(sessionId);
    const status = this.app.sessions.publicStatus(session);
    const evidence = await session.evidence.exportBundle(status, session.findings);
    return { sessionId, state: 'closed', status, evidence };
  }

  private async ensureRequestHook(session: WxmpSession, requestedContextId?: string): Promise<Record<string, unknown>> {
    const contextId = requestedContextId || session.selectedContextId;
    if (!contextId) return { active: false, missingCapability: 'appContext', reason: 'No selected WMPF context.' };
    try {
      const response = await session.channel.send('Runtime.evaluate', {
        expression: buildWxRequestHookSource(),
        awaitPromise: true,
        returnByValue: true,
      }, contextId, 10_000);
      const value = checkedRuntimeValue(response, 'request hook bootstrap');
      const status = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const installed = Array.isArray(status.installed) ? status.installed : [];
      const reusedActive = status.reused === true && (status.status as Record<string, unknown> | undefined)?.active !== false;
      const active = installed.length > 0 || reusedActive;
      this.app.sessions.setCapability(session.id, 'requestHook', active, contextId);
      await session.evidence.append('agent.request_hook_bootstrap', { active, value }, { contextId, operation: 'wxmp_open' });
      return { active, contextId, value, missingCapability: active ? undefined : 'requestHook' };
    } catch (error) {
      this.app.sessions.setCapability(session.id, 'requestHook', false, contextId);
      const reason = error instanceof Error ? error.message : String(error);
      await session.evidence.append('agent.request_hook_gap', { reason }, { contextId, operation: 'wxmp_open' });
      return { active: false, contextId, missingCapability: 'requestHook', reason };
    }
  }
}

function checkedRuntimeValue(response: Record<string, unknown>, operation: string): unknown {
  const result = response.result;
  if (result && typeof result === 'object' && (result as Record<string, unknown>).exceptionDetails) {
    throw new WxmpError('RUNTIME_EVALUATION_FAILED', `${operation} raised a runtime exception`, {
      exceptionDetails: (result as Record<string, unknown>).exceptionDetails,
    });
  }
  return extractRemoteValue(response);
}

function workflowState(session: WxmpSession): Record<string, unknown> {
  if (['waiting_for_runtime', 'disconnected'].includes(session.state)) {
    return {
      state: 'needs_user_action',
      retryable: true,
      needsUserAction: true,
      missingCapability: 'runtimeBridge',
      userAction: 'Foreground or reload the target mini-program once, then call wxmp_open with this session_id.',
      nextActions: ['wxmp_open'],
      resumeTool: 'wxmp_open',
      resumeArguments: { session_id: session.id },
    };
  }
  if (session.state === 'connected' && session.capabilities.cdp && session.selectedContextId) {
    return {
      state: 'ready',
      retryable: false,
      needsUserAction: false,
      nextActions: ['wxmp_app_snapshot', 'wxmp_observe_window', 'wxmp_get_api_inventory'],
    };
  }
  if (session.state === 'connected') {
    return {
      state: 'degraded',
      retryable: true,
      needsUserAction: false,
      missingCapability: session.capabilities.cdp ? 'appContext' : 'cdp',
      nextActions: ['wxmp_open', 'wxmp_status'],
    };
  }
  return {
    state: session.state,
    retryable: false,
    needsUserAction: false,
    nextActions: ['wxmp_doctor'],
  };
}

function snapshotAppId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = (value as Record<string, unknown>).snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const identity = (snapshot as Record<string, unknown>).identity;
  if (!identity || typeof identity !== 'object') return null;
  const appId = (identity as Record<string, unknown>).appId;
  return typeof appId === 'string' && appId ? appId : null;
}
