import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AppConfig } from '../config.js';
import { EvidenceStore } from '../evidence/store.js';
import { WxmpError } from '../errors.js';
import { FridaHandle, FridaRuntimeAdapter } from '../runtime/frida-adapter.js';
import { ProfileManager } from '../runtime/profile.js';
import { discoverTargets, resolveTarget } from '../runtime/target-discovery.js';
import { CdpChannel } from '../transport/cdp-channel.js';
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
}

export interface AttachOptions {
  pid?: number;
  projectName: string;
  profilePath?: string;
  connectTimeoutMs?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, WxmpSession>();
  private readonly proxies = new Map<string, DevToolsProxy>();
  private readonly profiles: ProfileManager;
  private readonly frida = new FridaRuntimeAdapter();
  readonly bridge: WmpfBridgeServer;

  constructor(private readonly config: AppConfig) {
    this.profiles = new ProfileManager(config.profileDirs, config.legacyProfileDirs);
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
    const evidence = new EvidenceStore(this.config.workspaceRoot, options.projectName, id, this.config.eventLimit);
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
        staticAdapter: Boolean(this.config.gwxapkgPath && existsSync(this.config.gwxapkgPath)),
        minigameDynamic: 'unknown',
      },
      evidence,
      channel,
      frida: null,
      findings: [],
    };
    this.sessions.set(id, session);
    await evidence.append('session.created', { target, profilePath: loaded.path, probe });
    if (probe.hashValidated !== true) {
      this.upsertFinding(session, {
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
      session.frida = await this.frida.attach(target, loaded.profile, (event) => {
        void evidence.append('frida.message', event);
      });
      session.capabilities.frida = true;
      this.updateState(session, 'waiting_for_runtime');
      const connected = await this.bridge.waitForConnection(id, options.connectTimeoutMs ?? 3000);
      if (connected && session.state !== 'connected') this.handleConnected(id);
      if (!connected) {
        this.upsertFinding(session, {
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
      this.upsertFinding(session, {
        id: 'attach-failed',
        title: 'Runtime attach failed',
        severity: 'high',
        summary: error instanceof Error ? error.message : String(error),
        evidenceTypes: ['session.attach_failed'],
      });
      await session.frida?.detach().catch(() => undefined);
      session.frida = null;
      this.bridge.release(id);
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
    if (!connected) this.upsertFinding(session, {
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
    const result = await proxy.start(session.channel, port);
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
    if (!session) return;
    session.capabilities.cdp = true;
    session.capabilities.debugger = true;
    session.capabilities.network = true;
    session.capabilities.wxTrace = true;
    this.updateState(session, 'connected');
    this.resolveFinding(session, 'runtime-not-ready');
    this.resolveFinding(session, 'runtime-disconnected');
    void session.evidence.append('runtime.connected', {});
    void session.channel.send('Runtime.enable').catch(() => undefined);
    void session.channel.send('Debugger.enable').catch(() => undefined);
  }

  private handleDisconnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'closed' || session.state === 'detaching') return;
    session.capabilities.cdp = false;
    session.capabilities.debugger = false;
    session.capabilities.network = false;
    session.capabilities.wxTrace = false;
    this.updateState(session, 'disconnected');
    session.channel.disconnect('WMPF runtime disconnected');
    this.upsertFinding(session, {
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
      if (session.selectedContextId === value.id) session.selectedContextId = '';
      void session.evidence.append('context.removed', value, { contextId: value.id });
      return;
    }
    const name = value.name ?? '';
    const context: WmpfContext = {
      id: value.id,
      name,
      kind: (value.kind as WmpfContext['kind']) ?? (name.toLowerCase().includes('game') ? 'minigame' : name.toLowerCase().includes('app') || name.toLowerCase().includes('service') ? 'miniapp' : 'unknown'),
      connectedAt: new Date().toISOString(),
      capabilities: name.toLowerCase().includes('game') ? ['evaluate', 'network', 'capability-probe'] : ['evaluate', 'debugger', 'network', 'wx-trace'],
    };
    session.contexts.set(value.id, context);
    if (!session.selectedContextId) session.selectedContextId = value.id;
    if (context.kind === 'minigame') session.capabilities.minigameDynamic = 'partial';
    if (context.kind === 'minigame') this.upsertFinding(session, {
      id: 'minigame-dynamic-partial',
      title: 'Mini-game dynamic capability is partial',
      severity: 'medium',
      summary: 'The runtime context was classified as a mini-game; evaluate/network are available while debugger and wx tracing require capability validation.',
      evidenceTypes: ['context.added'],
    });
    void session.evidence.append('context.added', context, { contextId: value.id });
  }

  private handleContext(sessionId: string, action: 'add' | 'remove', value: { id: string; name?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || !value.id) return;
    if (action === 'remove') {
      session.contexts.delete(value.id);
      if (session.selectedContextId === value.id) session.selectedContextId = '';
      void session.evidence.append('context.removed', value, { contextId: value.id });
      return;
    }
    const name = value.name ?? '';
    const lower = name.toLowerCase();
    const kind = lower.includes('game') ? 'minigame' : lower.includes('app') || lower.includes('service') ? 'miniapp' : 'unknown';
    const context: WmpfContext = {
      id: value.id,
      name,
      kind,
      connectedAt: new Date().toISOString(),
      capabilities: kind === 'minigame' ? ['evaluate', 'network', 'capability-probe'] : ['evaluate', 'debugger', 'network', 'wx-trace'],
    };
    session.contexts.set(value.id, context);
    if (!session.selectedContextId) session.selectedContextId = value.id;
    if (kind === 'minigame') session.capabilities.minigameDynamic = 'partial';
    if (kind === 'minigame') this.upsertFinding(session, {
      id: 'minigame-dynamic-partial',
      title: 'Mini-game dynamic capability is partial',
      severity: 'medium',
      summary: 'The runtime context was classified as a mini-game; evaluate/network are available while debugger and wx tracing require capability validation.',
      evidenceTypes: ['context.added'],
    });
    void session.evidence.append('context.added', context, { contextId: value.id });
  }

  private updateState(session: WxmpSession, state: SessionState): void {
    session.state = state;
    session.updatedAt = new Date().toISOString();
  }

  private upsertFinding(session: WxmpSession, input: Pick<EvidenceFinding, 'id' | 'title' | 'severity' | 'summary' | 'evidenceTypes'>): void {
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

  private resolveFinding(session: WxmpSession, id: string): void {
    const finding = session.findings.find((entry) => entry.id === id);
    if (!finding) return;
    finding.status = 'resolved';
    finding.lastObservedAt = new Date().toISOString();
  }
}
