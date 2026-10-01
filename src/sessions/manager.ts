import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppConfig } from '../config.js';
import { EvidenceStore } from '../evidence/store.js';
import { WxmpError } from '../errors.js';
import { FridaRuntimeAdapter } from '../runtime/frida-adapter.js';
import { ProfileManager } from '../runtime/profile.js';
import { buildWxRuntimeProbeExpression } from '../runtime/wx-runtime.js';
import { CdpChannel, extractRemoteValue } from '../transport/cdp-channel.js';
import { DevToolsProxy } from '../transport/devtools-proxy.js';
import { BridgeEnvelopeObservation, WmpfBridgeServer } from '../transport/bridge-server.js';
import { protocolArtifactName } from '../transport/protocol-registry.js';
import { CdpExecutionContext, EvidenceFinding, SessionState, TargetProcess, WmpfContext } from '../types.js';
import { applyTrackedCapability, refreshContextCapabilities, TrackedCapability } from './capabilities.js';
import { classifyContextKind, contextScore, inferContextRole, mergeExecutionContext, selectBestContextId } from './contexts.js';
import { defaultBridgeFactory, defaultClock, defaultSessionRuntimeDeps, SessionRuntimeDeps } from './deps.js';
import { smokeReady } from '../runtime/profile-adapt.js';
import { isWaitableState, resolveRuntimeWaitMs, transitionSessionState } from './machine.js';
import { AttachOptions, WxmpSession } from './session.js';

export type { AttachOptions, WxmpSession } from './session.js';

const CONTEXT_PROBE_EXPRESSION = buildWxRuntimeProbeExpression();

function hookCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

export class SessionManager {
  private readonly sessions = new Map<string, WxmpSession>();
  private readonly proxies = new Map<string, DevToolsProxy>();
  private readonly profiles: ProfileManager;
  private readonly frida: FridaRuntimeAdapter;
  private readonly activationPromises = new Map<string, Promise<void>>();
  private readonly now: NonNullable<SessionRuntimeDeps['now']>;
  private readonly discoverTargetsImpl: NonNullable<SessionRuntimeDeps['discoverTargets']>;
  private readonly resolveTargetImpl: NonNullable<SessionRuntimeDeps['resolveTarget']>;
  readonly bridge: WmpfBridgeServer;

  constructor(private readonly config: AppConfig, deps: SessionRuntimeDeps = {}) {
    this.now = deps.now ?? defaultClock;
    this.discoverTargetsImpl = deps.discoverTargets ?? defaultSessionRuntimeDeps.discoverTargets;
    this.resolveTargetImpl = deps.resolveTarget ?? defaultSessionRuntimeDeps.resolveTarget;
    this.frida = deps.frida ?? new FridaRuntimeAdapter();
    this.profiles = new ProfileManager(config.profileDirs, config.legacyProfileDirs, config.signatureDbPaths);
    const createBridge = deps.createBridge ?? defaultBridgeFactory;
    this.bridge = createBridge(config.debugHost, config.debugPort, {
      onCdp: (sessionId, payload, contextId) => this.sessions.get(sessionId)?.channel.handlePayload(payload, contextId),
      onContext: (sessionId, action, context) => this.handleContext(sessionId, action, context),
      onEnvelope: (sessionId, observation) => { void this.recordProtocolEnvelope(sessionId, observation); },
      onConnected: (sessionId) => this.handleConnected(sessionId),
      onDisconnected: (sessionId) => this.handleDisconnected(sessionId),
    });
  }

  async listTargets(): Promise<TargetProcess[]> {
    return this.discoverTargetsImpl();
  }

  async attach(options: AttachOptions): Promise<WxmpSession> {
    const target = await this.resolveTargetImpl(options.pid);
    if (!target.version) throw new WxmpError('WMPF_VERSION_UNKNOWN', 'Unable to derive WMPF version from process path', { target });
    const existing = [...this.sessions.values()].find((session) => session.target.pid === target.pid && !['closed', 'failed'].includes(session.state));
    if (existing) throw new WxmpError('TARGET_ALREADY_ATTACHED', `WMPF process ${target.pid} already belongs to session ${existing.id}`);

    const id = `wxmp-${randomUUID()}`;
    const evidence = new EvidenceStore(
      this.config.workspaceRoot,
      options.projectName,
      id,
      this.config.eventLimit,
      this.config.maxEvidenceEvents,
      this.config.maxEvidenceBytes,
    );
    await evidence.init();
    const loaded = await this.profiles.load(target.version, options.profilePath);
    if (options.allowCandidateSmoke) {
      if (loaded.profile.provenance.confidence !== 'candidate') {
        throw new WxmpError('PROFILE_SMOKE_NOT_APPLICABLE', 'allowCandidateSmoke requires a generated candidate profile', {
          provenance: loaded.profile.provenance,
        });
      }
    } else {
      this.profiles.assertInjectable(loaded.profile);
    }
    const probe = await this.profiles.probe(target, loaded.profile);
    if (probe.hashMatches === false) throw new WxmpError('PROFILE_HASH_MISMATCH', 'Profile module hash does not match the target module', probe);
    if (!probe.valid) throw new WxmpError('PROFILE_OUT_OF_BOUNDS', 'Profile offsets are outside the target module', probe);

    const channel = new CdpChannel(id, evidence, (payload, contextId) => this.bridge.sendCdp(id, payload, contextId));
    channel.onExecutionContext((action, value) => this.handleCdpExecutionContext(id, action, value));
    const now = this.now().toISOString();
    const session: WxmpSession = {
      id,
      projectName: options.projectName,
      target,
      profile: loaded.profile,
      profilePath: loaded.path,
      state: 'created',
      createdAt: now,
      updatedAt: now,
      contexts: new Map(),
      selectedContextId: '',
      capabilities: {
        frida: false,
        bridge: false,
        cdp: false,
        debugger: false,
        network: false,
        wxTrace: false,
        requestHook: false,
        staticAdapter: Boolean(this.config.gwxapkgPath && existsSync(this.config.gwxapkgPath)),
        minigameDynamic: 'unknown',
      },
      evidence,
      channel,
      frida: null,
      findings: [],
      traceContextIds: new Set(),
      requestHookContextIds: new Set(),
      networkContextIds: new Set(),
      runtimeGeneration: 0,
    };
    this.sessions.set(id, session);
    await evidence.append('session.created', { target, profilePath: loaded.path, probe });
    if (probe.hashValidated !== true) {
      this.recordFinding(session, {
        id: 'profile-hash-unbound',
        title: 'Runtime profile is not bound to a verified module hash',
        severity: 'medium',
        summary: 'The external compatibility profile passed offset bounds but does not carry an expected module SHA-256.',
        evidenceTypes: ['session.created'],
      });
    }

    try {
      this.updateState(session, 'attaching');
      await this.bridge.start();
      session.capabilities.bridge = true;
      this.bridge.prepare(id);
      session.frida = await this.frida.attach(
        target,
        loaded.profile,
        (event) => { void evidence.append('frida.message', event); },
        (event) => this.handleFridaDetached(id, event),
      );
      session.capabilities.frida = true;
      this.updateState(session, 'waiting_for_runtime');
      if (options.allowCandidateSmoke) {
        const observation = await session.frida.status();
        await evidence.append('frida.smoke', observation);
        if (!smokeReady(observation)) {
          throw new WxmpError('PROFILE_SMOKE_FAILED', 'Frida smoke did not report module/cdp_filter_attached/load_start_attached/ready', {
            observation,
          });
        }
      }
      await this.observeForceDebug(session);
      const connected = await this.bridge.waitForConnection(id, resolveRuntimeWaitMs(options.connectTimeoutMs));
      if (connected && session.state !== 'connected') this.handleConnected(id);
      await this.activationPromises.get(id);
      if (!connected) {
        this.recordFinding(session, {
          id: 'runtime-not-ready',
          title: 'WMPF runtime did not connect within the attach window',
          severity: 'high',
          summary: 'Frida attach completed, but the WMPF debug WebSocket did not enter the bridge during the configured timeout.',
          evidenceTypes: ['session.attach_result'],
        });
      }
      await evidence.append('session.attach_result', { connected, state: session.state });
      return session;
    } catch (error) {
      this.updateState(session, 'failed');
      await evidence.append('session.attach_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      this.recordFinding(session, {
        id: 'attach-failed',
        title: 'Runtime attach failed',
        severity: 'high',
        summary: error instanceof Error ? error.message : String(error),
        evidenceTypes: ['session.attach_failed'],
      });
      const frida = session.frida;
      session.frida = null;
      session.runtimeGeneration += 1;
      this.activationPromises.delete(id);
      this.updateState(session, 'detaching');
      this.bridge.release(id);
      await frida?.detach().catch(() => undefined);
      session.capabilities.frida = false;
      session.capabilities.bridge = false;
      session.capabilities.cdp = false;
      session.capabilities.debugger = false;
      session.capabilities.network = false;
      session.capabilities.wxTrace = false;
      session.capabilities.requestHook = false;
      this.updateState(session, 'failed');
      throw error;
    }
  }

  get(sessionId: string): WxmpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new WxmpError('SESSION_NOT_FOUND', `Unknown session: ${sessionId}`);
    return session;
  }

  list(): WxmpSession[] {
    return [...this.sessions.values()];
  }

  selectContext(sessionId: string, contextId: string): WmpfContext {
    const session = this.get(sessionId);
    const context = session.contexts.get(contextId);
    if (!context) throw new WxmpError('CONTEXT_NOT_FOUND', `Unknown context ${contextId}`, { sessionId, contextId });
    session.selectedContextId = contextId;
    session.updatedAt = this.now().toISOString();
    void session.evidence.append('context.selected', context, { contextId });
    return context;
  }

  contextId(sessionId: string, requested?: string): string {
    const session = this.get(sessionId);
    return requested ?? session.selectedContextId;
  }

  async detach(sessionId: string): Promise<void> {
    const session = this.get(sessionId);
    if (session.state === 'closed') return;
    this.updateState(session, 'detaching');
    await this.stopProxy(sessionId);
    this.bridge.release(sessionId);
    session.channel.close('Session detached');
    await session.frida?.detach().catch(() => undefined);
    session.frida = null;
    session.capabilities.frida = false;
    session.capabilities.bridge = false;
    session.capabilities.cdp = false;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    session.capabilities.requestHook = false;
    session.traceContextIds.clear();
    session.requestHookContextIds.clear();
    session.networkContextIds.clear();
    session.runtimeGeneration += 1;
    this.updateState(session, 'closed');
    await session.evidence.append('session.detached', {});
  }

  async waitForRuntime(sessionId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const session = this.get(sessionId);
    if (!isWaitableState(session.state)) {
      throw new WxmpError('SESSION_NOT_WAITABLE', `Session ${sessionId} is in state ${session.state}`, { sessionId, state: session.state });
    }
    await this.observeForceDebug(session);
    const connected = await this.bridge.waitForConnection(sessionId, timeoutMs);
    if (connected && session.state !== 'connected') this.handleConnected(sessionId);
    await this.activationPromises.get(sessionId);
    if (!connected) this.recordFinding(session, {
      id: 'runtime-not-ready',
      title: 'WMPF runtime did not reconnect within the wait window',
      severity: 'high',
      summary: 'The session remains attached and reserved; retry after a mini-program foreground/reload transition.',
      evidenceTypes: ['runtime.wait_result'],
    });
    await session.evidence.append('runtime.wait_result', { connected, timeoutMs, state: session.state });
    return { connected, ...this.publicStatus(session) };
  }

  async startProxy(sessionId: string, port: number): Promise<Record<string, unknown>> {
    const session = this.get(sessionId);
    if (!this.bridge.isConnected(sessionId)) throw new WxmpError('RUNTIME_NOT_CONNECTED', 'Cannot start DevTools proxy before WMPF connects');
    if (this.proxies.has(sessionId)) throw new WxmpError('DEVTOOLS_PROXY_RUNNING', 'This session already has a DevTools proxy');
    const proxy = new DevToolsProxy();
    const result = await proxy.start(session.channel, port, session.selectedContextId);
    this.proxies.set(sessionId, proxy);
    await session.evidence.append('devtools_proxy.started', result);
    return result;
  }

  async stopProxy(sessionId: string): Promise<void> {
    const proxy = this.proxies.get(sessionId);
    if (!proxy) return;
    await proxy.stop();
    this.proxies.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) await session.evidence.append('devtools_proxy.stopped', {});
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) await this.detach(session.id).catch(() => undefined);
    await this.bridge.stop();
  }

  profileManager(): ProfileManager {
    return this.profiles;
  }

  async probeContexts(sessionId: string): Promise<WmpfContext[]> {
    const session = this.get(sessionId);
    if (!this.bridge.isConnected(sessionId)) throw new WxmpError('RUNTIME_NOT_CONNECTED', 'Context probing requires an active WMPF runtime');
    for (const context of [...session.contexts.values()].filter((item) => item.active !== false)) {
      await this.probeContext(session, context.id);
    }
    return [...session.contexts.values()];
  }

  setCapability(sessionId: string, capability: TrackedCapability, enabled: boolean, contextId = ''): void {
    const session = this.get(sessionId);
    applyTrackedCapability(session, capability, enabled, contextId);
    refreshContextCapabilities(session);
    void session.evidence.append('capability.updated', { capability, enabled, contextId: contextId || null });
  }

  publicStatus(session: WxmpSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      projectName: session.projectName,
      state: session.state,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      target: {
        pid: session.target.pid,
        version: session.target.version,
        executablePath: session.target.executablePath,
        appId: session.target.appId,
        processType: session.target.processType,
        renderType: session.target.renderType,
      },
      profile: {
        path: session.profilePath,
        version: session.profile.wmpfVersion,
        provenance: session.profile.provenance,
      },
      contexts: [...session.contexts.values()],
      selectedContextId: session.selectedContextId,
      capabilities: session.capabilities,
      evidenceRoot: session.evidence.sessionRoot,
      bridgeConnected: this.bridge.isConnected(session.id),
      contextGraph: {
        wmpfContexts: session.contexts.size,
        executionContexts: session.channel.executionContexts?.size ?? 0,
      },
    };
  }

  async hookSnapshot(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.get(sessionId);
    const empty = {
      available: false,
      ready: false,
      cdpFilterAttached: false,
      loadStartAttached: false,
      cdpFilterEntered: 0,
      loadStartEntered: 0,
      forceDebugTriggerCalls: 0,
    };
    if (!session.frida) return empty;
    try {
      const raw = await session.frida.status();
      return {
        available: true,
        ready: raw.ready === true,
        cdpFilterAttached: raw.cdpFilterAttached === true,
        loadStartAttached: raw.loadStartAttached === true,
        cdpFilterEntered: hookCount(raw.cdpFilterEntered),
        loadStartEntered: hookCount(raw.loadStartEntered),
        forceDebugTriggerCalls: hookCount(raw.forceDebugTriggerCalls),
      };
    } catch (error) {
      return {
        ...empty,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  contextGraph(sessionId: string): Record<string, unknown> {
    const session = this.get(sessionId);
    const processId = `process:${session.target.pid}`;
    const wmpfContexts = [...session.contexts.values()].map((context) => ({
      ...context,
      nodeId: `wmpf:${context.id}`,
      executionContextIds: [...session.channel.executionContexts.values()]
        .filter((execution) => execution.wmpfContextId === context.id)
        .map((execution) => execution.id),
    }));
    const executionContexts = [...session.channel.executionContexts.values()].map((context) => ({
      ...context,
      nodeId: `cdp:${context.wmpfContextId ?? 'unscoped'}:${context.id}`,
    }));
    return {
      schemaVersion: 1,
      sessionId,
      generatedAt: new Date().toISOString(),
      process: {
        nodeId: processId,
        pid: session.target.pid,
        appId: session.target.appId,
        version: session.target.version,
        processType: session.target.processType,
      },
      wmpfContexts,
      executionContexts,
      edges: [
        ...wmpfContexts.map((context) => ({
          from: processId,
          to: context.nodeId,
          relation: 'hosts-logical-context',
          provenance: context.provenance ?? ['wmpf.addJsContext'],
          confidence: context.provenance?.includes('wmpf.addJsContext') ? 'high' : 'medium',
        })),
        ...executionContexts.filter((context) => context.wmpfContextId).map((context) => ({
          from: `wmpf:${context.wmpfContextId}`,
          to: context.nodeId,
          relation: 'routes-cdp-execution-context',
          provenance: context.provenance,
          confidence: 'high',
        })),
      ],
      selectedWmpfContextId: session.selectedContextId,
    };
  }

  private handleConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || ['closed', 'detaching', 'failed'].includes(session.state)) return;
    session.capabilities.cdp = false;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    session.capabilities.requestHook = false;
    session.traceContextIds.clear();
    session.requestHookContextIds.clear();
    session.networkContextIds.clear();
    const generation = ++session.runtimeGeneration;
    this.updateState(session, 'connected');
    this.resolveFinding(session, 'runtime-not-ready');
    this.resolveFinding(session, 'runtime-disconnected');
    void session.evidence.append('runtime.connected', {});
    const activation = this.activateConnectedSession(session, generation);
    this.activationPromises.set(sessionId, activation);
    const cleanup = () => {
      if (this.activationPromises.get(sessionId) === activation) this.activationPromises.delete(sessionId);
    };
    void activation.then(cleanup, (error) => {
      cleanup();
      this.recordFinding(session, {
        id: 'runtime-activation-failed',
        title: 'Runtime capability activation failed',
        severity: 'high',
        summary: error instanceof Error ? error.message : String(error),
        evidenceTypes: ['runtime.activation_failed'],
      });
      void session.evidence.append('runtime.activation_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private handleDisconnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || ['closed', 'detaching', 'failed'].includes(session.state)) return;
    session.capabilities.cdp = false;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    session.capabilities.requestHook = false;
    session.traceContextIds.clear();
    session.requestHookContextIds.clear();
    session.networkContextIds.clear();
    session.runtimeGeneration += 1;
    session.selectedContextId = '';
    for (const context of session.contexts.values()) {
      context.active = false;
      context.capabilities = ['capability-probe'];
      context.provenance = [...new Set([...(context.provenance ?? []), 'runtime.disconnected'])];
    }
    this.updateState(session, 'disconnected');
    session.channel.disconnect('WMPF runtime disconnected');
    this.recordFinding(session, {
      id: 'runtime-disconnected',
      title: 'WMPF runtime channel disconnected',
      severity: 'high',
      summary: 'The bridge retained the MCP session and is waiting for the WMPF runtime to reconnect.',
      evidenceTypes: ['runtime.disconnected'],
    });
    void session.evidence.append('runtime.disconnected', {});
  }

  private handleCdpExecutionContext(sessionId: string, action: 'add' | 'remove', value: CdpExecutionContext): void {
    const session = this.sessions.get(sessionId);
    if (!session || !value.id) return;
    const contextId = value.wmpfContextId;
    if (action === 'remove') {
      void session.evidence.append('context.execution_removed', value, { contextId });
      return;
    }
    void session.evidence.append('context.execution_added', value, { contextId });
    if (!contextId) return;
    const existing = session.contexts.get(contextId);
    const context = mergeExecutionContext(existing, value, session.runtimeGeneration);
    if (!context.id) return;
    session.contexts.set(contextId, context);
    if (!session.selectedContextId) session.selectedContextId = contextId;
    if (context.kind === 'minigame') session.capabilities.minigameDynamic = 'partial';
    if (context.kind === 'minigame') this.recordFinding(session, {
      id: 'minigame-dynamic-partial',
      title: 'Mini-game dynamic capability is partial',
      severity: 'medium',
      summary: 'The runtime context was classified as a mini-game; evaluate/network are available while debugger and wx tracing require capability validation.',
      evidenceTypes: ['context.added'],
    });
    if (this.bridge.isConnected(sessionId)) void this.probeContext(session, contextId);
  }

  private handleContext(sessionId: string, action: 'add' | 'remove', value: { id: string; name?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || !value.id) return;
    if (action === 'remove') {
      session.contexts.delete(value.id);
      session.traceContextIds.delete(value.id);
      session.requestHookContextIds.delete(value.id);
      session.networkContextIds.delete(value.id);
      session.capabilities.wxTrace = session.traceContextIds.size > 0;
      session.capabilities.requestHook = session.requestHookContextIds.size > 0;
      session.capabilities.network = session.networkContextIds.size > 0;
      if (session.selectedContextId === value.id) this.selectBestContext(session);
      void session.evidence.append('context.removed', value, { contextId: value.id });
      return;
    }
    const name = value.name ?? '';
    const kind = classifyContextKind(name);
    const existing = session.contexts.get(value.id);
    const context: WmpfContext = {
      ...existing,
      id: value.id,
      name: name || existing?.name || '',
      kind: kind === 'unknown' ? existing?.kind ?? 'unknown' : kind,
      role: existing?.role && existing.role !== 'unknown' ? existing.role : kind === 'minigame' ? 'minigame' : 'unknown',
      probeConfidence: existing?.probeConfidence ?? 'unprobed',
      connectedAt: existing?.connectedAt ?? this.now().toISOString(),
      capabilities: existing?.capabilities ?? ['evaluate', 'capability-probe'],
      provenance: [...new Set([...(existing?.provenance ?? []), 'wmpf.addJsContext'])],
      runtimeGeneration: session.runtimeGeneration,
      active: true,
    };
    session.contexts.set(value.id, context);
    if (!session.selectedContextId) session.selectedContextId = value.id;
    if (kind === 'minigame') session.capabilities.minigameDynamic = 'partial';
    if (kind === 'minigame') this.recordFinding(session, {
      id: 'minigame-dynamic-partial',
      title: 'Mini-game dynamic capability is partial',
      severity: 'medium',
      summary: 'The runtime context was classified as a mini-game; evaluate/network are available while debugger and wx tracing require capability validation.',
      evidenceTypes: ['context.added'],
    });
    void session.evidence.append('context.added', context, { contextId: value.id });
    if (this.bridge.isConnected(sessionId)) void this.probeContext(session, value.id);
  }

  private async observeForceDebug(session: WxmpSession): Promise<void> {
    if (!session.frida?.forceDebugTrigger) return;
    try {
      const observation = await session.frida.forceDebugTrigger();
      await session.evidence.append('frida.force_debug_trigger', observation);
    } catch (error) {
      await session.evidence.append('frida.force_debug_trigger_gap', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updateState(session: WxmpSession, state: SessionState): void {
    session.state = transitionSessionState(session.state, state);
    session.updatedAt = this.now().toISOString();
  }

  private async recordProtocolEnvelope(sessionId: string, observation: BridgeEnvelopeObservation): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const { payload, ...metadata } = observation;
    const capturePayload = observation.decoder !== 'known';
    let artifact: Record<string, unknown> | undefined;
    if (capturePayload && payload.length > 0) {
      artifact = await session.evidence.writeBinary(
        protocolArtifactName(observation.seq, observation.category, observation.sha256),
        payload,
        this.config.maxProtocolArtifactBytes,
      );
    }
    const evidence = {
      ...metadata,
      previewBase64: capturePayload
        ? payload.subarray(0, this.config.protocolPreviewBytes).toString('base64')
        : undefined,
      previewBytes: capturePayload ? Math.min(payload.length, this.config.protocolPreviewBytes) : 0,
      artifact,
    };
    await session.evidence.append(`wmpf.${observation.category}`, evidence);
    if (observation.decoder === 'unknown') {
      this.recordFinding(session, {
        id: `unknown-protocol-${observation.category.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'empty'}`,
        title: `Unknown WMPF protocol category: ${observation.category || '(empty)'}`,
        severity: 'medium',
        summary: `The payload was preserved with SHA-256 ${observation.sha256} for clean-room decoding.`,
        evidenceTypes: [`wmpf.${observation.category}`],
      });
    }
  }

  recordFinding(session: WxmpSession, input: Pick<EvidenceFinding, 'id' | 'title' | 'severity' | 'summary' | 'evidenceTypes'>): void {
    const now = this.now().toISOString();
    const existing = session.findings.find((finding) => finding.id === input.id);
    if (existing) {
      existing.title = input.title;
      existing.severity = input.severity;
      existing.status = 'open';
      existing.summary = input.summary;
      existing.evidenceTypes = [...new Set([...existing.evidenceTypes, ...input.evidenceTypes])];
      existing.lastObservedAt = now;
      return;
    }
    session.findings.push({ ...input, status: 'open', firstObservedAt: now, lastObservedAt: now });
  }

  resolveFinding(session: WxmpSession, id: string): void {
    const finding = session.findings.find((entry) => entry.id === id);
    if (!finding) return;
    finding.status = 'resolved';
    finding.lastObservedAt = this.now().toISOString();
  }

  private async activateConnectedSession(session: WxmpSession, generation: number): Promise<void> {
    const probes: Array<{ method: string; capability: 'cdp' | 'debugger' | 'network'; params?: Record<string, unknown> }> = [
      { method: 'Runtime.enable', capability: 'cdp' },
      { method: 'Debugger.enable', capability: 'debugger' },
      { method: 'Network.enable', capability: 'network', params: { maxTotalBufferSize: 100_000_000 } },
    ];
    for (const probe of probes) {
      if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
      try {
        await session.channel.send(probe.method, probe.params ?? {}, '', 10_000);
        if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
        session.capabilities[probe.capability] = true;
        if (probe.capability === 'network') session.networkContextIds.add('*');
        this.resolveFinding(session, `capability-${probe.method}-failed`);
        await session.evidence.append('capability.probe', { method: probe.method, supported: true });
      } catch (error) {
        if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
        session.capabilities[probe.capability] = false;
        if (probe.capability === 'network') session.networkContextIds.clear();
        this.recordFinding(session, {
          id: `capability-${probe.method}-failed`,
          title: `${probe.method} capability probe failed`,
          severity: 'medium',
          summary: error instanceof Error ? error.message : String(error),
          evidenceTypes: ['capability.probe'],
        });
        await session.evidence.append('capability.probe', {
          method: probe.method,
          supported: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
    refreshContextCapabilities(session);
    await this.probeContexts(session.id).catch(() => undefined);
  }

  private async probeContext(session: WxmpSession, contextId: string): Promise<void> {
    const context = session.contexts.get(contextId);
    if (!context || !this.bridge.isConnected(session.id)) return;
    try {
      const response = await session.channel.send('Runtime.evaluate', {
        expression: CONTEXT_PROBE_EXPRESSION,
        returnByValue: true,
        awaitPromise: true,
      }, contextId, 5000);
      const value = extractRemoteValue(response);
      if (!value || typeof value !== 'object') throw new WxmpError('CONTEXT_PROBE_EMPTY', 'Context probe returned no serializable value');
      const probe = value as Record<string, unknown>;
      context.hasWx = probe.hasWx === true;
      context.hasWxRequest = probe.hasWxRequest === true;
      context.hasWxConfig = probe.hasWxConfig === true;
      context.hasGetCurrentPages = probe.hasGetCurrentPages === true;
      context.wxRuntimePath = typeof probe.wxRuntimePath === 'string' ? probe.wxRuntimePath : '';
      context.wxRuntimeHref = typeof probe.wxRuntimeHref === 'string' ? probe.wxRuntimeHref : '';
      context.contextType = typeof probe.contextType === 'string' ? probe.contextType : '';
      context.envType = typeof probe.envType === 'string' ? probe.envType : '';
      context.href = typeof probe.href === 'string' ? probe.href : '';
      context.role = inferContextRole(context);
      context.kind = context.role === 'minigame' ? 'minigame'
        : context.role === 'appservice' || context.role === 'webview' ? 'miniapp'
        : context.kind;
      context.probeConfidence = context.hasWx || context.contextType ? 'high' : context.origin?.includes('servicewechat') ? 'medium' : 'low';
      context.probedAt = this.now().toISOString();
      refreshContextCapabilities(session);
      const selected = session.contexts.get(session.selectedContextId);
      if (!selected || contextScore(context) > contextScore(selected)) session.selectedContextId = context.id;
      this.resolveFinding(session, `context-probe-${context.id}`);
      await session.evidence.append('context.probed', context, { contextId });
    } catch (error) {
      context.probeConfidence = 'low';
      context.probedAt = this.now().toISOString();
      this.recordFinding(session, {
        id: `context-probe-${context.id}`,
        title: `Context ${context.id} capability probe failed`,
        severity: 'medium',
        summary: error instanceof Error ? error.message : String(error),
        evidenceTypes: ['context.probe_failed'],
      });
      await session.evidence.append('context.probe_failed', {
        error: error instanceof Error ? error.message : String(error),
      }, { contextId });
    }
  }

  private selectBestContext(session: WxmpSession): void {
    session.selectedContextId = selectBestContextId(session.contexts.values());
  }

  private handleFridaDetached(sessionId: string, event: { reason: string; crash: unknown }): void {
    const session = this.sessions.get(sessionId);
    if (!session || ['closed', 'detaching', 'failed'].includes(session.state)) return;
    session.frida = null;
    session.capabilities.frida = false;
    session.capabilities.bridge = false;
    session.capabilities.cdp = false;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    session.capabilities.requestHook = false;
    session.traceContextIds.clear();
    session.requestHookContextIds.clear();
    session.networkContextIds.clear();
    session.runtimeGeneration += 1;
    this.activationPromises.delete(sessionId);
    this.updateState(session, 'failed');
    session.channel.disconnect(`Frida session detached: ${event.reason}`);
    this.bridge.release(sessionId);
    this.recordFinding(session, {
      id: 'frida-detached',
      title: 'Frida session detached unexpectedly',
      severity: 'high',
      summary: `Reason: ${event.reason}`,
      evidenceTypes: ['frida.detached'],
    });
    void session.evidence.append('frida.detached', event);
    void this.stopProxy(sessionId).catch((error) => {
      this.recordFinding(session, {
        id: 'devtools-proxy-cleanup-failed',
        title: 'DevTools proxy cleanup failed',
        severity: 'high',
        summary: error instanceof Error ? error.message : String(error),
        evidenceTypes: ['devtools_proxy.cleanup_failed'],
      });
      void session.evidence.append('devtools_proxy.cleanup_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
