import { EvidenceStore } from '../evidence/store.js';
import { FridaHandle } from '../runtime/frida-adapter.js';
import { CdpChannel } from '../transport/cdp-channel.js';
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
  networkContextIds: Set<string>;
  runtimeGeneration: number;
}

export interface AttachOptions {
  pid?: number;
  projectName: string;
  profilePath?: string;
  connectTimeoutMs?: number;
  allowCandidateSmoke?: boolean;
}
