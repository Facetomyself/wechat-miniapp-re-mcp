import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Toolset = 'agent' | 'expert';

export interface AppConfig {
  toolset: Toolset;
  workspaceRoot: string;
  profileDirs: string[];
  legacyProfileDirs: string[];
  signatureDbPaths: string[];
  gwxapkgPath: string | null;
  debugHost: string;
  debugPort: number;
  eventLimit: number;
  maxEvidenceEvents: number;
  maxEvidenceBytes: number;
  protocolPreviewBytes: number;
  maxProtocolArtifactBytes: number;
}

function splitPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function defaultWorkspaceRoot(): string {
  const cwdWorkspace = path.resolve(process.cwd(), 'workspace');
  if (existsSync(cwdWorkspace)) return cwdWorkspace;
  const envRoot = process.env.REVERSE_ENV_ROOT;
  if (envRoot && existsSync(path.resolve(envRoot, 'workspace'))) {
    return path.resolve(envRoot, 'workspace');
  }
  return path.resolve(process.cwd(), '.wxmp-workspace');
}

function defaultGwxapkg(): string | null {
  const explicit = process.env.WXMP_GWXAPKG;
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.resolve(process.cwd(), 'tools', 'Gwxapkg-runtime', 'gwxapkg.exe'),
    path.resolve(process.cwd(), '..', '..', 'tools', 'Gwxapkg-runtime', 'gwxapkg.exe'),
    ...(process.env.REVERSE_ENV_ROOT
      ? [path.resolve(process.env.REVERSE_ENV_ROOT, 'tools', 'Gwxapkg-runtime', 'gwxapkg.exe')]
      : []),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function packageCandidates(...parts: string[]): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(process.cwd(), ...parts),
    path.resolve(moduleDir, '..', ...parts),
    path.resolve(moduleDir, '..', '..', ...parts),
  ];
}

function defaultProfileDirs(): string[] {
  return packageCandidates('data', 'profiles', 'clean-room').filter((candidate, index, all) => (
    existsSync(candidate) && all.indexOf(candidate) === index
  ));
}

function defaultSignatureDbPaths(): string[] {
  return packageCandidates('data', 'profiles', 'aob-signatures.json').filter((candidate, index, all) => (
    existsSync(candidate) && all.indexOf(candidate) === index
  ));
}

export function loadConfig(): AppConfig {
  const debugPort = Number(process.env.WXMP_DEBUG_PORT ?? 9421);
  const configuredEventLimit = Number(process.env.WXMP_EVENT_LIMIT ?? 5000);
  const configuredMaxEvidenceEvents = Number(process.env.WXMP_MAX_EVIDENCE_EVENTS ?? 100_000);
  const configuredMaxEvidenceBytes = Number(process.env.WXMP_MAX_EVIDENCE_BYTES ?? 256 * 1024 * 1024);
  const configuredProtocolPreviewBytes = Number(process.env.WXMP_PROTOCOL_PREVIEW_BYTES ?? 2048);
  const configuredMaxProtocolArtifactBytes = Number(process.env.WXMP_MAX_PROTOCOL_ARTIFACT_BYTES ?? 8 * 1024 * 1024);
  const explicitProfiles = splitPaths(process.env.WXMP_PROFILE_DIR);
  const explicitSignatureDbs = splitPaths(process.env.WXMP_SIGNATURE_DB);
  return {
    toolset: process.env.WXMP_TOOLSET === 'expert' ? 'expert' : 'agent',
    workspaceRoot: path.resolve(process.env.WXMP_WORKSPACE_ROOT ?? defaultWorkspaceRoot()),
    profileDirs: [...explicitProfiles, ...defaultProfileDirs()].filter((candidate, index, all) => all.indexOf(candidate) === index),
    legacyProfileDirs: splitPaths(process.env.WXMP_LEGACY_PROFILE_DIR),
    signatureDbPaths: [...explicitSignatureDbs, ...defaultSignatureDbPaths()].filter((candidate, index, all) => all.indexOf(candidate) === index),
    gwxapkgPath: defaultGwxapkg(),
    debugHost: process.env.WXMP_DEBUG_HOST ?? '127.0.0.1',
    debugPort: Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536 ? debugPort : 9421,
    eventLimit: Number.isSafeInteger(configuredEventLimit) && configuredEventLimit >= 100 ? configuredEventLimit : 5000,
    maxEvidenceEvents: Number.isSafeInteger(configuredMaxEvidenceEvents) && configuredMaxEvidenceEvents >= 1000
      ? configuredMaxEvidenceEvents
      : 100_000,
    maxEvidenceBytes: Number.isSafeInteger(configuredMaxEvidenceBytes) && configuredMaxEvidenceBytes >= 1024 * 1024
      ? configuredMaxEvidenceBytes
      : 256 * 1024 * 1024,
    protocolPreviewBytes: Number.isSafeInteger(configuredProtocolPreviewBytes) && configuredProtocolPreviewBytes >= 64
      ? Math.min(configuredProtocolPreviewBytes, 64 * 1024)
      : 2048,
    maxProtocolArtifactBytes: Number.isSafeInteger(configuredMaxProtocolArtifactBytes) && configuredMaxProtocolArtifactBytes >= 64 * 1024
      ? Math.min(configuredMaxProtocolArtifactBytes, 64 * 1024 * 1024)
      : 8 * 1024 * 1024,
  };
}

export function windowsPackageRoots(home: string): string[] {
  const radiumRoot = path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium');
  const legacyRoot = path.join(radiumRoot, 'Applet', 'packages');
  const usersRoot = path.join(radiumRoot, 'users');
  const roots = [legacyRoot];
  try {
    const users = readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of users) {
      const packagesRoot = path.join(usersRoot, entry.name, 'applet', 'packages');
      if (existsSync(packagesRoot)) roots.push(packagesRoot);
    }
  } catch {
    // Current xwechat installs may not have created a per-user package tree yet.
  }
  return roots.filter((candidate, index, all) => all.indexOf(candidate) === index);
}

export function defaultPackageRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return windowsPackageRoots(home);
  }
  if (process.platform === 'darwin') {
    return [
      path.join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Documents',
        'app_data',
        'radium',
        'users',
      ),
    ];
  }
  return [];
}
