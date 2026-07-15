import { createHash } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { OffsetProfile, ProfileReview, TargetProcess } from '../types.js';
import { WxmpError } from '../errors.js';

interface LegacyProfile {
  Version?: number;
  LoadStartHookOffset?: string;
  CDPFilterHookOffset?: string;
  SceneOffsets?: number[];
}

export interface SignatureSpec {
  name: 'cdpFilter' | 'loadStart';
  pattern: string;
  adjustment?: number;
}

export interface ProfilePromotion {
  confidence: 'medium' | 'high';
  reviewer: string;
  evidence: string[];
  note?: string;
}

function parseOffset(value: string): number {
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WxmpError('INVALID_PROFILE', `Invalid offset: ${value}`);
  }
  return parsed;
}

function validateProfile(value: unknown): OffsetProfile {
  const profile = value as Partial<OffsetProfile>;
  const sources = new Set(['clean-room', 'generated', 'external-legacy']);
  const confidences = new Set(['high', 'medium', 'candidate', 'external']);
  if (
    profile.schemaVersion !== 1 ||
    !Number.isSafeInteger(profile.wmpfVersion) ||
    Number(profile.wmpfVersion) <= 0 ||
    !['windows', 'darwin'].includes(String(profile.platform)) ||
    !profile.moduleName ||
    path.basename(profile.moduleName) !== profile.moduleName ||
    !profile.cdpFilterOffset ||
    !profile.loadStartOffset ||
    !Array.isArray(profile.sceneOffsets) ||
    profile.sceneOffsets.length < 2 ||
    profile.sceneOffsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0) ||
    !Array.isArray(profile.sceneWhitelist) ||
    profile.sceneWhitelist.some((scene) => !Number.isSafeInteger(scene)) ||
    !profile.provenance ||
    !sources.has(String(profile.provenance.source)) ||
    !confidences.has(String(profile.provenance.confidence))
  ) {
    throw new WxmpError('INVALID_PROFILE', 'Profile does not satisfy schema version 1');
  }
  parseOffset(profile.cdpFilterOffset);
  parseOffset(profile.loadStartOffset);
  if (profile.moduleSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(profile.moduleSha256)) {
    throw new WxmpError('INVALID_PROFILE', 'moduleSha256 must be a 64-character hexadecimal SHA-256 digest');
  }
  if (profile.provenance.source !== 'external-legacy' && !profile.moduleSha256) {
    throw new WxmpError('INVALID_PROFILE', 'Clean-room and generated profiles must bind to moduleSha256');
  }
  if (profile.review !== undefined) validateReview(profile.review);
  if (
    profile.provenance.source === 'generated' &&
    profile.provenance.confidence !== 'candidate' &&
    profile.review?.decision !== 'promoted'
  ) {
    throw new WxmpError('INVALID_PROFILE', 'Promoted generated profiles must include review evidence');
  }
  return profile as OffsetProfile;
}

function validateReview(value: unknown): asserts value is ProfileReview {
  const review = value as Partial<ProfileReview>;
  const reviewedAt = Date.parse(String(review.reviewedAt ?? ''));
  if (
    !review.reviewer?.trim() ||
    !Number.isFinite(reviewedAt) ||
    !Array.isArray(review.evidence) ||
    review.evidence.length === 0 ||
    review.evidence.some((item) => typeof item !== 'string' || !item.trim()) ||
    !['promoted', 'rejected'].includes(String(review.decision))
  ) {
    throw new WxmpError('INVALID_PROFILE_REVIEW', 'Profile review must include reviewer, timestamp, decision, and evidence');
  }
}

function legacyToProfile(value: LegacyProfile, sourcePath: string): OffsetProfile {
  if (!value.Version || !value.LoadStartHookOffset || !value.CDPFilterHookOffset || !value.SceneOffsets) {
    throw new WxmpError('INVALID_LEGACY_PROFILE', `Legacy profile is incomplete: ${sourcePath}`);
  }
  return {
    schemaVersion: 1,
    platform: 'windows',
    wmpfVersion: value.Version,
    moduleName: value.Version >= 13331 ? 'flue.dll' : 'WeChatAppEx.exe',
    cdpFilterOffset: value.CDPFilterHookOffset,
    loadStartOffset: value.LoadStartHookOffset,
    sceneOffsets: value.SceneOffsets,
    sceneWhitelist: [1005, 1007, 1008, 1012, 1027, 1035, 1053, 1074, 1145, 1168, 1178, 1256, 1260, 1302, 1308],
    provenance: {
      source: 'external-legacy',
      confidence: 'external',
      note: `Loaded at runtime from ${sourcePath}; not copied into the repository`,
    },
  };
}

export class ProfileManager {
  constructor(
    private readonly profileDirs: string[],
    private readonly legacyProfileDirs: string[],
  ) {}

  async load(version: number, explicitPath?: string): Promise<{ profile: OffsetProfile; path: string }> {
    const candidates: Array<{ path: string; legacy: boolean }> = [];
    if (explicitPath) candidates.push({ path: path.resolve(explicitPath), legacy: false });
    for (const dir of this.profileDirs) {
      candidates.push({ path: path.join(dir, `windows-${version}.json`), legacy: false });
      candidates.push({ path: path.join(dir, `profile.${version}.json`), legacy: false });
    }
    for (const dir of this.legacyProfileDirs) {
      candidates.push({ path: path.join(dir, `addresses.${version}.json`), legacy: true });
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate.path)) continue;
      const value = JSON.parse(await fs.readFile(candidate.path, 'utf8')) as unknown;
      const profile = candidate.legacy ? legacyToProfile(value as LegacyProfile, candidate.path) : validateProfile(value);
      if (profile.wmpfVersion !== version) {
        throw new WxmpError('PROFILE_VERSION_MISMATCH', `Profile WMPF ${profile.wmpfVersion} does not match target WMPF ${version}`, {
          expectedVersion: version,
          profileVersion: profile.wmpfVersion,
          profilePath: candidate.path,
        });
      }
      return {
        profile,
        path: candidate.path,
      };
    }
    throw new WxmpError('PROFILE_NOT_FOUND', `No offset profile is available for WMPF ${version}`, {
      version,
      searched: candidates.map((candidate) => candidate.path),
      next: 'Use wxmp_profile_generate or configure WXMP_LEGACY_PROFILE_DIR for local compatibility testing.',
    });
  }

  modulePath(target: TargetProcess, profile?: OffsetProfile): string {
    const moduleName = profile?.moduleName ?? (target.version && target.version >= 13331 ? 'flue.dll' : 'WeChatAppEx.exe');
    return path.join(path.dirname(target.executablePath), moduleName);
  }

  assertInjectable(profile: OffsetProfile): void {
    if (profile.provenance.confidence === 'candidate') {
      throw new WxmpError('PROFILE_REVIEW_REQUIRED', 'Candidate profiles require review before runtime injection', {
        version: profile.wmpfVersion,
        provenance: profile.provenance,
        next: 'Validate the module hash and offsets, then promote confidence to medium or high with review evidence.',
      });
    }
    if (profile.provenance.source === 'generated' && profile.review?.decision !== 'promoted') {
      throw new WxmpError('PROFILE_REVIEW_REQUIRED', 'Generated profiles require recorded promotion evidence before runtime injection', {
        version: profile.wmpfVersion,
        provenance: profile.provenance,
      });
    }
  }

  promote(profile: OffsetProfile, promotion: ProfilePromotion): OffsetProfile {
    const candidate = validateProfile(profile);
    if (candidate.provenance.source !== 'generated' || candidate.provenance.confidence !== 'candidate') {
      throw new WxmpError('PROFILE_NOT_PROMOTABLE', 'Only generated candidate profiles can be promoted', {
        provenance: candidate.provenance,
      });
    }
    const reviewer = promotion.reviewer.trim();
    const evidence = [...new Set(promotion.evidence.map((item) => item.trim()).filter(Boolean))];
    if (!reviewer || evidence.length === 0) {
      throw new WxmpError('PROFILE_REVIEW_REQUIRED', 'Profile promotion requires a reviewer and at least one evidence reference');
    }
    return validateProfile({
      ...candidate,
      provenance: {
        ...candidate.provenance,
        confidence: promotion.confidence,
        note: promotion.note?.trim() || candidate.provenance.note,
      },
      review: {
        reviewer,
        reviewedAt: new Date().toISOString(),
        evidence,
        decision: 'promoted',
        ...(promotion.note?.trim() ? { note: promotion.note.trim() } : {}),
      },
    });
  }

  async probe(target: TargetProcess, profile: OffsetProfile): Promise<Record<string, unknown>> {
    const modulePath = this.modulePath(target, profile);
    const stat = await fs.stat(modulePath);
    const offsets = {
      cdpFilter: parseOffset(profile.cdpFilterOffset),
      loadStart: parseOffset(profile.loadStartOffset),
    };
    const checks = Object.entries(offsets).map(([name, offset]) => ({ name, offset, inBounds: offset < stat.size }));
    const sha256 = await sha256File(modulePath);
    const expectedSha256 = profile.moduleSha256?.toLowerCase() ?? null;
    const hashMatches = expectedSha256 ? sha256.toLowerCase() === expectedSha256 : null;
    return {
      modulePath,
      moduleSize: stat.size,
      sha256,
      expectedSha256,
      hashMatches,
      hashValidated: hashMatches === true,
      checks,
      valid: checks.every((check) => check.inBounds) && hashMatches !== false,
      profile,
    };
  }

  async generate(target: TargetProcess, signatures: SignatureSpec[], sceneOffsets: number[]): Promise<OffsetProfile> {
    if (!target.version) throw new WxmpError('WMPF_VERSION_UNKNOWN', 'Cannot generate a profile for a target with no WMPF version');
    const signatureNames = signatures.map((signature) => signature.name);
    if (signatures.length !== 2 || new Set(signatureNames).size !== 2 || !signatureNames.includes('cdpFilter') || !signatureNames.includes('loadStart')) {
      throw new WxmpError('INVALID_SIGNATURE_SET', 'Profile generation requires exactly one cdpFilter and one loadStart signature');
    }
    const modulePath = this.modulePath(target);
    const buffer = await fs.readFile(modulePath);
    const matches: Partial<Record<SignatureSpec['name'], number[]>> = {};
    for (const signature of signatures) {
      const found = findPattern(buffer, signature.pattern).map((offset) => offset + (signature.adjustment ?? 0));
      matches[signature.name] = found;
    }
    const cdp = matches.cdpFilter ?? [];
    const load = matches.loadStart ?? [];
    if (cdp.length !== 1 || load.length !== 1) {
      throw new WxmpError('PROFILE_CANDIDATE_AMBIGUOUS', 'Signature scan did not produce one unique candidate per hook', {
        modulePath,
        matches,
      });
    }
    if (cdp[0] < 0 || cdp[0] >= buffer.length || load[0] < 0 || load[0] >= buffer.length) {
      throw new WxmpError('PROFILE_CANDIDATE_OUT_OF_BOUNDS', 'Adjusted signature candidates are outside the target module', {
        modulePath,
        moduleSize: buffer.length,
        matches,
      });
    }
    const moduleSha256 = await sha256File(modulePath);
    return validateProfile({
      schemaVersion: 1,
      platform: 'windows',
      wmpfVersion: target.version,
      moduleName: path.basename(modulePath),
      moduleSha256,
      cdpFilterOffset: `0x${cdp[0].toString(16).toUpperCase()}`,
      loadStartOffset: `0x${load[0].toString(16).toUpperCase()}`,
      sceneOffsets,
      sceneWhitelist: [1005, 1007, 1008, 1012, 1027, 1035, 1053, 1074, 1145, 1168, 1178, 1256, 1260, 1302, 1308],
      provenance: {
        source: 'generated',
        confidence: 'candidate',
        note: 'Signature candidates require wxmp_profile_validate and runtime verification before persistent use.',
      },
    });
  }
}

export function findPattern(buffer: Buffer, pattern: string): number[] {
  const tokens = pattern.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new WxmpError('INVALID_SIGNATURE', 'Signature pattern is empty');
  const bytes = tokens.map((token) => (token === '?' || token === '??' ? null : Number.parseInt(token, 16)));
  if (bytes.some((byte) => byte !== null && (!Number.isInteger(byte) || byte < 0 || byte > 255))) {
    throw new WxmpError('INVALID_SIGNATURE', `Invalid byte signature: ${pattern}`);
  }
  const matches: number[] = [];
  outer: for (let offset = 0; offset <= buffer.length - bytes.length; offset += 1) {
    for (let index = 0; index < bytes.length; index += 1) {
      const expected = bytes[index];
      if (expected !== null && buffer[offset + index] !== expected) continue outer;
    }
    matches.push(offset);
    if (matches.length >= 1000) break;
  }
  return matches;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
