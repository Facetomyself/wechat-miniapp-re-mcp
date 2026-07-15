import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppConfig } from '../config.js';
import { EvidenceStore } from '../evidence/store.js';
import { WxmpError } from '../errors.js';
import { FridaHandle, FridaRuntimeAdapter } from '../runtime/frida-adapter.js';
import { ProfileManager } from '../runtime/profile.js';
import { discoverTargets, resolveTarget } from '../runtime/target-discovery.js';
import { buildWxRuntimeProbeExpression } from '../runtime/wx-runtime.js';
import { CdpChannel, extractRemoteValue } from '../transport/cdp-channel.js';
import { DevToolsProxy } from '../transport/devtools-proxy.js';
import { WmpfBridgeServer } from '../transport/bridge-server.js';
import { EvidenceFinding, OffsetProfile, RuntimeCapabilities, SessionState, TargetProcess, WmpfContext } from '../types.js';

export interface WxmpSession {
  id: string;
  projectName: string;
  target: TargetProcess;
  profile: OffsetProfile;
  profilePath: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  contexts: Map<string, WmpfContext>;
  selectedContextId: string;
  capabilities: RuntimeCapabilities;
  evidence: EvidenceStore;
  channel: CdpChannel;
  frida: FridaHandle | null;
  findings: EvidenceFinding[];
  traceContextIds: Set<string>;
  requestHookContextIds: Set<string>;
  runtimeGeneration: number;
}

export interface AttachOptions {
  pid?: number;
  projectName: string;
  profilePath?: string;
  connectTimeoutMs?: number;
}

const CONTEXT_PROBE_EXPRESSION = buildWxRuntimeProbeExpression();

export class SessionManager {
  private readonly sessions = new Map<string, WxmpSession>();
  private readonly proxies = new Map<string, DevToolsProxy>();
  private readonly profiles: ProfileManager;
  private readonly frida = new FridaRuntimeAdapter();
  private readonly activationPromises = new Map<string, Promise<void>>();
  readonly bridge: WmpfBridgeServer;

  constructor(private readonly config: AppConfig) {
    this.profiles = new ProfileManager(config.profileDirs, config.legacyProfileDirs, config.signatureDbPaths);
    this.bridge = new WmpfBridgeServer(config.debugHost, config.debugPort, {
      onCdp: (sessionId, payload, contextId) => this.sessions.get(sessionId)?.channel.handlePayload(payload, contextId),
      onContext: (sessionId, action, context) => this.handleContext(sessionId, action, context),
      onEnvelope: (sessionId, category, data) => {
        const session = this.sessions.get(sessionId);
        if (session) void session.evidence.append(`wmpf.${category}`, data);
      },
      onConnected: (sessionId) => this.handleConnected(sessionId),
      onDisconnected: (sessionId) => this.handleDisconnected(sessionId),
    });
  }

  async listTargets(): Promise<TargetProcess[]> {
    return discoverTargets();
  }

  async attach(options: AttachOptions): Promise<WxmpSession> {
    const target = await resolveTarget(options.pid);
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
    this.profiles.assertInjectable(loaded.profile);
    const probe = await this.profiles.probe(target, loaded.profile);
    if (probe.hashMatches === false) throw new WxmpError('PROFILE_HASH_MISMATCH', 'Profile module hash does not match the target module', probe);
    if (!probe.valid) throw new WxmpError('PROFILE_OUT_OF_BOUNDS', 'Profile offsets are outside the target module', probe);

    const channel = new CdpChannel(id, evidence, (payload, contextId) => this.bridge.sendCdp(id, payload, contextId));
    channel.onContext((action, value) => this.handleCdpContext(id, action, value));
    const now = new Date().toISOString();
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
      const connected = await this.bridge.waitForConnection(id, options.connectTimeoutMs ?? 3000);
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
    session.updatedAt = new Date().toISOString();
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
    session.runtimeGeneration += 1;
    this.updateState(session, 'closed');
    await session.evidence.append('session.detached', {});
  }

  async waitForRuntime(sessionId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const session = this.get(sessionId);
    if (['closed', 'detaching', 'failed'].includes(session.state)) {
      throw new WxmpError('SESSION_NOT_WAITABLE', `Session ${sessionId} is in state ${session.state}`, { sessionId, state: session.state });
    }
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
    for (const contextId of [...session.contexts.keys()]) await this.probeContext(session, contextId);
    return [...session.contexts.values()];
  }

  setCapability(sessionId: string, capability: 'network' | 'wxTrace' | 'requestHook', enabled: boolean, contextId = ''): void {
    const session = this.get(sessionId);
    if (capability === 'wxTrace') {
      if (enabled && contextId) session.traceContextIds.add(contextId);
      else if (contextId) session.traceContextIds.delete(contextId);
      else if (!enabled) session.traceContextIds.clear();
      session.capabilities.wxTrace = session.traceContextIds.size > 0;
    } else if (capability === 'requestHook') {
      if (enabled && contextId) session.requestHookContextIds.add(contextId);
      else if (contextId) session.requestHookContextIds.delete(contextId);
      else if (!enabled) session.requestHookContextIds.clear();
      session.capabilities.requestHook = session.requestHookContextIds.size > 0;
    } else {
      session.capabilities.network = enabled;
    }
    this.refreshContextCapabilities(session);
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
    };
  }

  private handleConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || ['closed', 'detaching', 'failed'].includes(session.state)) return;
    session.capabilities.cdp = true;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    session.capabilities.requestHook = false;
    session.traceContextIds.clear();
    session.requestHookContextIds.clear();
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
    session.runtimeGeneration += 1;
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

  private handleCdpContext(sessionId: string, action: 'add' | 'remove', value: { id: string; name?: string; origin?: string; kind?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || !value.id) return;
    if (action === 'remove') {
      session.contexts.delete(value.id);
      session.traceContextIds.delete(value.id);
      session.requestHookContextIds.delete(value.id);
      session.capabilities.wxTrace = session.traceContextIds.size > 0;
      session.capabilities.requestHook = session.requestHookContextIds.size > 0;
      if (session.selectedContextId === value.id) this.selectBestContext(session);
      void session.evidence.append('context.removed', value, { contextId: value.id });
      return;
    }
    const name = value.name ?? '';
    const existing = session.contexts.get(value.id);
    const inferredKind = (value.kind as WmpfContext['kind']) ?? (name.toLowerCase().includes('game') ? 'minigame' : name.toLowerCase().includes('app') || name.toLowerCase().includes('service') ? 'miniapp' : 'unknown');
    const context: WmpfContext = {
      ...existing,
      id: value.id,
      name: name || existing?.name || '',
      kind: inferredKind === 'unknown' ? existing?.kind ?? 'unknown' : inferredKind,
      role: existing?.role && existing.role !== 'unknown' ? existing.role : inferredKind === 'minigame' ? 'minigame' : 'unknown',
      origin: value.origin ?? existing?.origin,
      probeConfidence: existing?.probeConfidence ?? 'unprobed',
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      capabilities: existing?.capabilities ?? ['evaluate', 'capability-probe'],
    };
    session.contexts.set(value.id, context);
    if (!session.selectedContextId) session.selectedContextId = value.id;
    if (context.kind === 'minigame') session.capabilities.minigameDynamic = 'partial';
    if (context.kind === 'minigame') this.recordFinding(session, {
      id: 'minigame-dynamic-partial',
      title: 'Mini-game dynamic capability is partial',
      severity: 'medium',
      summary: 'The runtime context was classified as a mini-game; evaluate/network are available while debugger and wx tracing require capability validation.',
      evidenceTypes: ['context.added'],
    });
    void session.evidence.append('context.added', context, { contextId: value.id });
    if (this.bridge.isConnected(sessionId)) void this.probeContext(session, value.id);
  }

  private handleContext(sessionId: string, action: 'add' | 'remove', value: { id: string; name?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || !value.id) return;
    if (action === 'remove') {
      session.contexts.delete(value.id);
      session.traceContextIds.delete(value.id);
      session.requestHookContextIds.delete(value.id);
      session.capabilities.wxTrace = session.traceContextIds.size > 0;
      session.capabilities.requestHook = session.requestHookContextIds.size > 0;
      if (session.selectedContextId === value.id) this.selectBestContext(session);
      void session.evidence.append('context.removed', value, { contextId: value.id });
      return;
    }
    const name = value.name ?? '';
    const lower = name.toLowerCase();
    const kind = lower.includes('game') ? 'minigame' : lower.includes('app') || lower.includes('service') ? 'miniapp' : 'unknown';
    const existing = session.contexts.get(value.id);
    const context: WmpfContext = {
      ...existing,
      id: value.id,
      name: name || existing?.name || '',
      kind: kind === 'unknown' ? existing?.kind ?? 'unknown' : kind,
      role: existing?.role && existing.role !== 'unknown' ? existing.role : kind === 'minigame' ? 'minigame' : 'unknown',
      probeConfidence: existing?.probeConfidence ?? 'unprobed',
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      capabilities: existing?.capabilities ?? ['evaluate', 'capability-probe'],
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

  private updateState(session: WxmpSession, state: SessionState): void {
    session.state = state;
    session.updatedAt = new Date().toISOString();
  }

  recordFinding(session: WxmpSession, input: Pick<EvidenceFinding, 'id' | 'title' | 'severity' | 'summary' | 'evidenceTypes'>): void {
    const now = new Date().toISOString();
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
    finding.lastObservedAt = new Date().toISOString();
  }

  private async activateConnectedSession(session: WxmpSession, generation: number): Promise<void> {
    const probes: Array<{ method: string; capability?: 'debugger' | 'network'; params?: Record<string, unknown> }> = [
      { method: 'Runtime.enable' },
      { method: 'Debugger.enable', capability: 'debugger' },
      { method: 'Network.enable', capability: 'network', params: { maxTotalBufferSize: 100_000_000 } },
    ];
    for (const probe of probes) {
      if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
      try {
        await session.channel.send(probe.method, probe.params ?? {}, '', 10_000);
        if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
        if (probe.capability) session.capabilities[probe.capability] = true;
        this.resolveFinding(session, `capability-${probe.method}-failed`);
        await session.evidence.append('capability.probe', { method: probe.method, supported: true });
      } catch (error) {
        if (session.runtimeGeneration !== generation || !this.bridge.isConnected(session.id)) return;
        if (probe.capability) session.capabilities[probe.capability] = false;
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
    this.refreshContextCapabilities(session);
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
      context.probedAt = new Date().toISOString();
      this.refreshContextCapabilities(session);
      const selected = session.contexts.get(session.selectedContextId);
      if (!selected || contextScore(context) > contextScore(selected)) session.selectedContextId = context.id;
      this.resolveFinding(session, `context-probe-${context.id}`);
      await session.evidence.append('context.probed', context, { contextId });
    } catch (error) {
      context.probeConfidence = 'low';
      context.probedAt = new Date().toISOString();
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

  private refreshContextCapabilities(session: WxmpSession): void {
    for (const context of session.contexts.values()) {
      const capabilities = new Set(['evaluate', 'capability-probe']);
      if (session.capabilities.debugger) capabilities.add('debugger');
      if (session.capabilities.network) capabilities.add('network');
      if (context.hasWx) capabilities.add('wx-api');
      if (session.traceContextIds.has(context.id) && context.hasWx) capabilities.add('wx-trace');
      if (session.requestHookContextIds.has(context.id)) capabilities.add('request-hook');
      context.capabilities = [...capabilities];
    }
  }

  private selectBestContext(session: WxmpSession): void {
    const next = [...session.contexts.values()].sort((left, right) => contextScore(right) - contextScore(left))[0];
    session.selectedContextId = next?.id ?? '';
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
  }
}

function inferContextRole(context: WmpfContext): WmpfContext['role'] {
  const marker = `${context.contextType ?? ''} ${context.envType ?? ''} ${context.name}`.toLowerCase();
  if (marker.includes('game')) return 'minigame';
  if (marker.includes('service') || marker.includes('maincontext') || marker.includes('subcontext') || context.hasWx) return 'appservice';
  if (marker.includes('webview') || marker.includes('render')) return 'webview';
  if (marker.includes('worker')) return 'worker';
  return 'unknown';
}

function contextScore(context: WmpfContext): number {
  if (context.hasWx) return 100;
  if (context.role === 'appservice') return 80;
  if (context.hasWxConfig) return 60;
  if (context.role === 'minigame') return 50;
  if (context.role === 'webview') return 30;
  return 0;
}
