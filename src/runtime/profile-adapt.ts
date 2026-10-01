import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OffsetProfile, TargetProcess } from '../types.js';
import { WxmpError } from '../errors.js';
import { OffsetExtractorAdapter, ExtractorRawResult } from './extractor.js';
import { ProfileManager } from './profile.js';
import { resolveInside, safeProjectName } from '../security.js';

const SCENE_WHITELIST = [1005, 1007, 1008, 1012, 1027, 1035, 1053, 1074, 1145, 1168, 1178, 1256, 1260, 1302, 1308];

export interface SmokeObservation {
  ready?: unknown;
  cdpFilterAttached?: unknown;
  loadStartAttached?: unknown;
  moduleName?: unknown;
}

export interface AobConfirmation {
  cdpFilterOffset: string;
  loadStartOffset: string;
  unique: boolean;
}

export function normalizeOffset(value: string | number): string {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), String(value).toLowerCase().startsWith('0x') ? 16 : 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WxmpError('INVALID_PROFILE', `Invalid offset: ${value}`);
  }
  return `0x${parsed.toString(16).toUpperCase()}`;
}

export function smokeReady(observation: SmokeObservation): boolean {
  const moduleName = typeof observation.moduleName === 'string' ? observation.moduleName.trim() : '';
  return moduleName.length > 0
    && observation.ready === true
    && observation.cdpFilterAttached === true
    && observation.loadStartAttached === true;
}

export function workspaceProfileDir(workspaceRoot: string, projectName: string): string {
  return resolveInside(workspaceRoot, safeProjectName(projectName), 'wechat-miniapp', 'profiles');
}

export function workspaceReviewedProfilePath(workspaceRoot: string, projectName: string, version: number): string {
  return resolveInside(workspaceProfileDir(workspaceRoot, projectName), `windows-${version}-reviewed.json`);
}

export function importExtractorOutput(input: {
  version: number;
  moduleName: string;
  moduleSha256: string;
  raw: ExtractorRawResult;
  extractorName?: string;
  extractorVersion?: string;
  outputPath: string;
}): OffsetProfile {
  if (input.raw.Version !== undefined && input.raw.Version !== input.version) {
    throw new WxmpError('PROFILE_VERSION_MISMATCH', `Extractor Version ${input.raw.Version} does not match target WMPF ${input.version}`, {
      expectedVersion: input.version,
      extractorVersion: input.raw.Version,
    });
  }
  if (!input.raw.CDPFilterHookOffset || !input.raw.LoadStartHookOffset || !Array.isArray(input.raw.SceneOffsets)) {
    throw new WxmpError('EXTRACTOR_OUTPUT_INVALID', 'Extractor output is missing hook offsets or SceneOffsets', { raw: input.raw });
  }
  if (input.raw.SceneOffsets.length < 6 || input.raw.SceneOffsets.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new WxmpError('EXTRACTOR_OUTPUT_INVALID', 'Extractor SceneOffsets must contain at least 6 non-negative integers', {
      sceneOffsets: input.raw.SceneOffsets,
    });
  }
  return {
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: input.version,
    moduleName: input.moduleName,
    moduleSha256: input.moduleSha256,
    cdpFilterOffset: normalizeOffset(input.raw.CDPFilterHookOffset),
    loadStartOffset: normalizeOffset(input.raw.LoadStartHookOffset),
    sceneOffsets: input.raw.SceneOffsets,
    sceneWhitelist: SCENE_WHITELIST,
    provenance: {
      source: 'generated',
      confidence: 'candidate',
      note: `extractor candidate from ${input.extractorName ?? 'wmpf-offset-adaptation'}; not injectable until smoke promotion`,
    },
    extractor: {
      name: input.extractorName ?? 'wmpf-offset-adaptation',
      version: input.extractorVersion ?? 'unknown',
      outputPath: input.outputPath,
    },
  };
}

export function attestedPromote(input: {
  candidate: OffsetProfile;
  hashValidated: boolean;
  boundsValid: boolean;
  moduleSha256: string;
  aob?: AobConfirmation | null;
  extractor?: { cdpFilterOffset: string; loadStartOffset: string; sceneOffsets: number[]; outputPath: string } | null;
  smoke: SmokeObservation;
  now?: () => string;
}): OffsetProfile {
  if (input.candidate.provenance.source !== 'generated' || input.candidate.provenance.confidence !== 'candidate') {
    throw new WxmpError('PROFILE_NOT_PROMOTABLE', 'Only generated candidate profiles can be attested', {
      provenance: input.candidate.provenance,
    });
  }
  if (!input.hashValidated) {
    throw new WxmpError('PROFILE_HASH_MISMATCH', 'Candidate module hash does not match the archived target module');
  }
  if (!input.boundsValid) {
    throw new WxmpError('PROFILE_OUT_OF_BOUNDS', 'Candidate hook offsets are outside the target module');
  }
  if (!smokeReady(input.smoke)) {
    throw new WxmpError('PROFILE_SMOKE_FAILED', 'Frida smoke did not report module/cdp_filter_attached/load_start_attached/ready', {
      smoke: input.smoke,
    });
  }
  const extractor = input.extractor;
  const aob = input.aob;
  const extractorStructured = Boolean(
    extractor
    && extractor.sceneOffsets.length >= 6
    && extractor.cdpFilterOffset
    && extractor.loadStartOffset,
  );
  if (aob && extractor) {
    if (normalizeOffset(aob.cdpFilterOffset) !== normalizeOffset(extractor.cdpFilterOffset)
      || normalizeOffset(aob.loadStartOffset) !== normalizeOffset(extractor.loadStartOffset)) {
      throw new WxmpError('PROFILE_OFFSET_CONFLICT', 'AOB unique matches disagree with extractor offsets; historical RVAs are not a fallback', {
        aob,
        extractor,
      });
    }
  }
  if (!(aob?.unique === true || extractorStructured)) {
    throw new WxmpError('PROFILE_EVIDENCE_INSUFFICIENT', 'Attested promotion requires unique AOB matches or extractor structure evidence', {
      aob: aob ?? null,
      extractorStructured,
    });
  }

  const manager = new ProfileManager([], []);
  return manager.promote(input.candidate, {
    confidence: 'medium',
    reviewer: 'extractor-runtime-smoke',
    evidence: [
      `module-sha256:${input.moduleSha256}`,
      aob?.unique ? 'aob-unique:cdpFilter+loadStart' : 'aob:not-unique-or-unavailable',
      extractorStructured ? `extractor-structure:${extractor!.outputPath}` : 'extractor-structure:missing',
      'frida-smoke:module+cdp_filter_attached+load_start_attached+ready',
      'provenance:extractor+runtime-smoke',
    ],
    note: 'extractor+runtime-smoke',
  });
}

export async function prepareCandidateProfile(input: {
  target: TargetProcess;
  projectName: string;
  extractor: OffsetExtractorAdapter;
  profiles: ProfileManager;
  workspaceRoot: string;
}): Promise<{
  candidate: OffsetProfile;
  candidatePath: string;
  archived: { path: string; sha256: string };
  probe: Record<string, unknown>;
  aob: AobConfirmation | null;
  extractorEvidence: { cdpFilterOffset: string; loadStartOffset: string; sceneOffsets: number[]; outputPath: string };
}> {
  if (!input.target.version) throw new WxmpError('WMPF_VERSION_UNKNOWN', 'Cannot adapt a profile without a WMPF version');
  const version = input.target.version;
  const modulePath = input.profiles.modulePath(input.target);
  const archived = await input.extractor.archiveModule(modulePath, input.projectName, version);
  const profileDir = workspaceProfileDir(input.workspaceRoot, input.projectName);
  await fs.mkdir(profileDir, { recursive: true });
  const extractorOutput = resolveInside(profileDir, `extractor-${version}.json`);
  const extracted = await input.extractor.extract({
    version,
    dllPath: archived.path,
    outputPath: extractorOutput,
  });
  const candidate = importExtractorOutput({
    version,
    moduleName: path.basename(modulePath),
    moduleSha256: archived.sha256,
    raw: extracted.raw,
    extractorName: 'wmpf-offset-adaptation',
    outputPath: extracted.outputPath,
  });
  const extractorEvidence = {
    cdpFilterOffset: candidate.cdpFilterOffset,
    loadStartOffset: candidate.loadStartOffset,
    sceneOffsets: candidate.sceneOffsets,
    outputPath: extracted.outputPath,
  };
  let aob: AobConfirmation | null = null;
  try {
    const signatures = await input.profiles.signaturesForVersion(version);
    const generated = await input.profiles.generate(input.target, signatures, candidate.sceneOffsets);
    aob = {
      cdpFilterOffset: generated.cdpFilterOffset,
      loadStartOffset: generated.loadStartOffset,
      unique: true,
    };
    if (normalizeOffset(aob.cdpFilterOffset) !== extractorEvidence.cdpFilterOffset
      || normalizeOffset(aob.loadStartOffset) !== extractorEvidence.loadStartOffset) {
      throw new WxmpError('PROFILE_OFFSET_CONFLICT', 'AOB unique matches disagree with extractor offsets; historical RVAs are not a fallback', {
        aob,
        extractor: extractorEvidence,
      });
    }
  } catch (error) {
    if (error instanceof WxmpError && error.code === 'PROFILE_OFFSET_CONFLICT') throw error;
    aob = null;
  }
  const probe = await input.profiles.probe(input.target, candidate);
  if (probe.hashValidated !== true || probe.valid !== true) {
    throw new WxmpError('PROFILE_REVIEW_FAILED', 'Extractor candidate failed hash or bounds validation', probe);
  }
  const candidatePath = resolveInside(profileDir, `windows-${version}-candidate.json`);
  await fs.writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  return { candidate, candidatePath, archived, probe, aob, extractorEvidence };
}
