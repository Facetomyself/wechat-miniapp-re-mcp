import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
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
  const explicitProfiles = splitPaths(process.env.WXMP_PROFILE_DIR);
  const explicitSignatureDbs = splitPaths(process.env.WXMP_SIGNATURE_DB);
  return {
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
  };
}

export function defaultPackageRoots(): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(home, 'AppData', 'Roaming', 'Tencent', 'xwechat', 'radium', 'Applet', 'packages')];
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
