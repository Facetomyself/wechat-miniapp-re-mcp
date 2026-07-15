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
}
