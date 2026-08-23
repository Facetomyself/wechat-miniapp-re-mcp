export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export interface TargetProcess {
  pid: number;
  ppid: number;
  executablePath: string;
  commandLine: string;
  version: number | null;
  processType: string;
  renderType: number | null;
  appId: string | null;
  isMain: boolean;
}

export interface WmpfContext {
  id: string;
  name: string;
  kind: 'miniapp' | 'minigame' | 'unknown';
  role: 'appservice' | 'webview' | 'minigame' | 'worker' | 'unknown';
  origin?: string;
  contextType?: string;
  envType?: string;
  href?: string;
  hasWx?: boolean;
  hasWxRequest?: boolean;
  hasWxConfig?: boolean;
  hasGetCurrentPages?: boolean;
  wxRuntimePath?: string;
  wxRuntimeHref?: string;
  probeConfidence: 'unprobed' | 'low' | 'medium' | 'high';
  probedAt?: string;
  connectedAt: string;
  capabilities: string[];
  provenance?: string[];
  runtimeGeneration?: number;
  active?: boolean;
}

export interface CdpExecutionContext {
  id: string;
  wmpfContextId?: string;
  uniqueId?: string;
  name: string;
  origin: string;
  kind: WmpfContext['kind'];
  role: WmpfContext['role'];
  auxData?: Record<string, unknown>;
  createdAt: string;
  provenance: 'cdp.Runtime.executionContextCreated';
}

export interface RuntimeCapabilities {
  frida: boolean;
  bridge: boolean;
  cdp: boolean;
  debugger: boolean;
  network: boolean;
  wxTrace: boolean;
  requestHook: boolean;
  staticAdapter: boolean;
  minigameDynamic: 'supported' | 'partial' | 'unavailable' | 'unknown';
}

export type SessionState =
  | 'created'
  | 'attaching'
  | 'waiting_for_runtime'
  | 'connected'
  | 'disconnected'
  | 'detaching'
  | 'closed'
  | 'failed';

export interface ProfileReview {
  reviewer: string;
  reviewedAt: string;
  evidence: string[];
  decision: 'promoted' | 'rejected';
  note?: string;
}

export interface OffsetProfile {
  schemaVersion: 1;
  platform: 'windows' | 'darwin';
  wmpfVersion: number;
  moduleName: string;
  moduleSha256?: string;
  cdpFilterOffset: string;
  loadStartOffset: string;
  sceneOffsets: number[];
  sceneWhitelist: number[];
  provenance: {
    source: 'clean-room' | 'generated' | 'external-legacy';
    confidence: 'high' | 'medium' | 'candidate' | 'external';
    note?: string;
  };
  extractor?: {
    name: string;
    version: string;
    outputPath?: string;
  };
  review?: ProfileReview;
}

export interface AuditEvent {
  timestamp: string;
  sessionId?: string;
  contextId?: string;
  type: string;
  operation?: string;
  data: JsonValue;
}

export interface EvidenceFinding {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'resolved' | 'accepted';
  summary: string;
  evidenceTypes: string[];
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface NetworkRecord {
  requestId: string;
  contextId?: string;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  resourceType?: string;
  timestamp?: number;
  transport: 'wx.request' | 'fetch' | 'xhr' | 'cdp';
  transportOptions?: Record<string, unknown>;
  initiator?: Record<string, unknown>;
  hookCursor?: number;
  response?: {
    status: number;
    statusText?: string;
    mimeType?: string;
    headers: Record<string, string>;
  };
}

export interface ScriptRecord {
  scriptId: string;
  contextId?: string;
  url: string;
  executionContextId?: number;
  hash?: string;
  length?: number;
  sourceMapURL?: string;
  scriptLanguage?: string;
}

export type DebuggerBreakpointStatus = 'bound' | 'pending' | 'stale';

export interface LogicalBreakpoint {
  logicalId: string;
  kind: 'script' | 'url' | 'urlRegex' | 'xhr';
  spec: {
    scriptId?: string;
    url?: string;
    urlRegex?: string;
    lineNumber?: number;
    columnNumber?: number;
    condition?: string;
  };
  cdpBreakpointId?: string;
  locations: unknown[];
  pending: boolean;
  status: DebuggerBreakpointStatus;
  staleReason?: string;
  generation: number;
  createdAt: string;
}

export interface PausedScope {
  type: string;
  name?: string;
  objectId?: string;
}

export interface PausedCallFrame {
  callFrameId: string;
  functionName: string;
  url?: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
  };
  scopeChain: PausedScope[];
}

export interface PausedState {
  paused: boolean;
  reason?: string;
  hitBreakpoints: string[];
  selectedFrameIndex: number;
  callFrames: PausedCallFrame[];
  selectedFrame?: PausedCallFrame;
  contextId?: string;
  data?: Record<string, unknown>;
  generation?: number;
}

export interface WebSocketFrame {
  direction: 'sent' | 'received';
  opcode?: number;
  payload: string;
  truncated: boolean;
  timestamp?: number;
}

export interface WebSocketRecord {
  requestId: string;
  contextId?: string;
  url: string;
  createdAt: string;
  closedAt?: string;
  stale?: boolean;
  handshake?: {
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    status?: number;
  };
  frames: WebSocketFrame[];
  droppedFrames: number;
  error?: string;
}
