import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { buildWxRequestHookSource } from '../runtime/wx-request-hook.js';
import { attestedPromote, prepareCandidateProfile, workspaceReviewedProfilePath } from '../runtime/profile-adapt.js';
import { buildWxAppSnapshotExpression } from '../runtime/wx-runtime.js';
import { extractRemoteValue } from '../transport/cdp-channel.js';
import { TargetProcess } from '../types.js';
import { WxmpSession } from '../sessions/manager.js';
import { isParkedState, resolveRuntimeWaitMs } from '../sessions/machine.js';
import { IndexedHit } from '../static/index-v2.js';
import { correlateRuntimeStatic } from './correlate.js';

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
        const inferredProject = target.appId || `wxmp-${target.pid}`;
        const loaded = await this.loadProfilePreferringWorkspace(target.version!, inferredProject);
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
    const extractor = this.app.extractor.info();
    const canAdapt = extractor.available;
    const profileAction = canAdapt
      ? 'No injectable Profile is installed. wxmp_open will copy flue.dll, run wmpf-offset-adaptation, smoke-attest Frida hooks, and promote a medium Profile.'
      : `Install the offset extractor, then retry. python="${extractor.pythonPath ?? ''}" script="${extractor.scriptPath ?? ''}".`;
    const state = !targetReady ? 'needs_user_action' : profileReady || canAdapt ? 'ready_to_open' : 'degraded';
    return {
      state,
      retryable: !targetReady,
      needsUserAction: !targetReady || (!profileReady && !canAdapt),
      missingCapability: !targetReady ? 'wmpfTarget' : !profileReady ? 'runtimeProfile' : undefined,
      userAction: !targetReady ? 'Open or foreground the target mini-program in PC WeChat.' : !profileReady ? profileAction : undefined,
      nextActions: targetReady && (profileReady || canAdapt) ? ['wxmp_open'] : ['wxmp_doctor'],
      targetCount: targets.length,
      targets,
      profiles,
      extractor,
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
        const projectName = options.projectName?.trim() || inferredProject;
        const resolved = await this.resolveOpenProfile(selectedTarget, projectName, options.profilePath);
        session = await this.app.sessions.attach({
          pid: selectedTarget.pid,
          projectName,
          profilePath: resolved.profilePath,
          connectTimeoutMs: resolveRuntimeWaitMs(options.connectTimeoutMs),
          allowCandidateSmoke: resolved.allowCandidateSmoke,
        });
        if (resolved.allowCandidateSmoke && resolved.prepared) {
          await this.promoteSmokeAttested(session, resolved.prepared);
        }
        attachedThisCall = true;
      }
    }

    if (!attachedThisCall && isParkedState(session.state)) {
      await this.app.sessions.waitForRuntime(session.id, resolveRuntimeWaitMs(options.connectTimeoutMs));
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

  async correlate(sessionId: string, options: { sourceRoot?: string; appId?: string } = {}): Promise<Record<string, unknown>> {
    const session = this.app.sessions.get(sessionId);
    const appId = options.appId?.trim() || session.target.appId || null;
    let packages: Array<{ appId: string; path: string }> = [];
    try {
      packages = (await this.app.staticAdapter.scan([], 500)).map((item) => ({ appId: item.appId, path: item.path }));
    } catch (error) {
      packages = [];
      await session.evidence.append('agent.correlate_package_scan_gap', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let index: Parameters<typeof correlateRuntimeStatic>[0]['index'] = null;
    if (options.sourceRoot) {
      const built = await this.app.staticAdapter.buildIndex(options.sourceRoot, session.projectName);
      index = {
        root: String(built.root),
        urls: Array.isArray(built.urls) ? built.urls as string[] : [],
        routes: Array.isArray(built.routes) ? built.routes as string[] : [],
        files: Array.isArray(built.files) ? built.files as string[] : [],
        urlHits: Array.isArray(built.urlHits) ? built.urlHits as IndexedHit[] : undefined,
        routeHits: Array.isArray(built.routeHits) ? built.routeHits as IndexedHit[] : undefined,
        pages: Array.isArray((built.manifest as { pages?: IndexedHit[] } | undefined)?.pages)
          ? (built.manifest as { pages: IndexedHit[] }).pages
          : undefined,
        kind: typeof built.kind === 'string' ? built.kind : undefined,
      };
    }
    const correlated = correlateRuntimeStatic({
      appId,
      scripts: [...session.channel.scripts.values()].map((script) => ({ scriptId: script.scriptId, url: script.url })),
      requests: [...session.channel.requests.values()].map((request) => ({
        requestId: request.requestId,
        url: request.url,
        initiator: request.initiator,
        hookCallStack: request.transportOptions?.callStack,
      })),
      packages,
      index,
    });
    await session.evidence.append('agent.correlate', correlated, { operation: 'wxmp_correlate' });
    return { sessionId, appId, sourceRoot: options.sourceRoot ?? null, ...correlated };
  }

  private async resolveOpenProfile(
    target: TargetProcess,
    projectName: string,
    explicitPath?: string,
  ): Promise<{
    profilePath?: string;
    allowCandidateSmoke: boolean;
    prepared?: Awaited<ReturnType<typeof prepareCandidateProfile>>;
  }> {
    const profiles = this.app.sessions.profileManager();
    try {
      const loaded = await this.loadProfilePreferringWorkspace(target.version ?? 0, projectName, explicitPath);
      profiles.assertInjectable(loaded.profile);
      return { profilePath: loaded.path, allowCandidateSmoke: false };
    } catch (error) {
      if (explicitPath) throw error;
      if (!(error instanceof WxmpError) || !['PROFILE_NOT_FOUND', 'PROFILE_REVIEW_REQUIRED'].includes(error.code)) {
        throw error;
      }
      if (target.version) {
        const reviewedPath = workspaceReviewedProfilePath(this.app.config.workspaceRoot, projectName, target.version);
        if (existsSync(reviewedPath)) {
          const reviewed = await profiles.load(target.version, reviewedPath);
          profiles.assertInjectable(reviewed.profile);
          return { profilePath: reviewed.path, allowCandidateSmoke: false };
        }
      }
      const prepared = await prepareCandidateProfile({
        target,
        projectName,
        extractor: this.app.extractor,
        profiles,
        workspaceRoot: this.app.config.workspaceRoot,
      });
      return { profilePath: prepared.candidatePath, allowCandidateSmoke: true, prepared };
    }
  }

  private async loadProfilePreferringWorkspace(version: number, projectName: string, explicitPath?: string) {
    const profiles = this.app.sessions.profileManager();
    try {
      return await profiles.load(version, explicitPath);
    } catch (error) {
      if (explicitPath || !version) throw error;
      if (!(error instanceof WxmpError) || error.code !== 'PROFILE_NOT_FOUND') throw error;
      const reviewedPath = workspaceReviewedProfilePath(this.app.config.workspaceRoot, projectName, version);
      if (!existsSync(reviewedPath)) throw error;
      return profiles.load(version, reviewedPath);
    }
  }

  private async promoteSmokeAttested(
    session: WxmpSession,
    prepared: Awaited<ReturnType<typeof prepareCandidateProfile>>,
  ): Promise<void> {
    const smoke = await session.frida?.status() ?? {};
    const promoted = attestedPromote({
      candidate: prepared.candidate,
      hashValidated: prepared.probe.hashValidated === true,
      boundsValid: prepared.probe.valid === true,
      moduleSha256: prepared.archived.sha256,
      aob: prepared.aob,
      extractor: prepared.extractorEvidence,
      smoke,
    });
    const outputPath = workspaceReviewedProfilePath(this.app.config.workspaceRoot, session.projectName, promoted.wmpfVersion);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
    session.profile = promoted;
    session.profilePath = outputPath;
    await session.evidence.append('profile.smoke_promoted', { outputPath, provenance: promoted.provenance, review: promoted.review });
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
  if (isParkedState(session.state)) {
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
      nextActions: ['wxmp_evaluate', 'wxmp_app_snapshot', 'wxmp_list_scripts', 'wxmp_get_api_inventory', 'wxmp_correlate'],
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
