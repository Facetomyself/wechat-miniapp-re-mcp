import { createHash } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { OffsetProfile, TargetProcess } from '../types.js';
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

function parseOffset(value: string): number {
  const parsed = Number.parseInt(value, value.toLowerCase().startsWith('0x') ? 16 : 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WxmpError('INVALID_PROFILE', `Invalid offset: ${value}`);
  }
  return parsed;
}

function validateProfile(value: unknown): OffsetProfile {
  const profile = value as Partial<OffsetProfile>;
  if (
    profile.schemaVersion !== 1 ||
    !profile.wmpfVersion ||
    !profile.moduleName ||
    !profile.cdpFilterOffset ||
    !profile.loadStartOffset ||
    !Array.isArray(profile.sceneOffsets) ||
    profile.sceneOffsets.length < 2 ||
    !profile.provenance
  ) {
    throw new WxmpError('INVALID_PROFILE', 'Profile does not satisfy schema version 1');
  }
  parseOffset(profile.cdpFilterOffset);
  parseOffset(profile.loadStartOffset);
  return profile as OffsetProfile;
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
      return {
        profile: candidate.legacy ? legacyToProfile(value as LegacyProfile, candidate.path) : validateProfile(value),
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

  async probe(target: TargetProcess, profile: OffsetProfile): Promise<Record<string, unknown>> {
    const modulePath = this.modulePath(target, profile);
    const stat = await fs.stat(modulePath);
    const offsets = {
      cdpFilter: parseOffset(profile.cdpFilterOffset),
      loadStart: parseOffset(profile.loadStartOffset),
    };
    const checks = Object.entries(offsets).map(([name, offset]) => ({ name, offset, inBounds: offset < stat.size }));
    return {
      modulePath,
      moduleSize: stat.size,
      sha256: await sha256File(modulePath),
      checks,
      valid: checks.every((check) => check.inBounds),
      profile,
    };
  }

  async generate(target: TargetProcess, signatures: SignatureSpec[], sceneOffsets: number[]): Promise<OffsetProfile> {
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
    return {
      schemaVersion: 1,
      platform: 'windows',
      wmpfVersion: target.version ?? 0,
      moduleName: path.basename(modulePath),
      cdpFilterOffset: `0x${cdp[0].toString(16).toUpperCase()}`,
      loadStartOffset: `0x${load[0].toString(16).toUpperCase()}`,
      sceneOffsets,
      sceneWhitelist: [1005, 1007, 1008, 1012, 1027, 1035, 1053, 1074, 1145, 1168, 1178, 1256, 1260, 1302, 1308],
      provenance: {
        source: 'generated',
        confidence: 'candidate',
        note: 'Signature candidates require wxmp_profile_validate and runtime verification before persistent use.',
      },
    };
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
