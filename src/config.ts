import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

export interface AppConfig {
  workspaceRoot: string;
  profileDirs: string[];
  legacyProfileDirs: string[];
  gwxapkgPath: string | null;
  debugHost: string;
  debugPort: number;
  eventLimit: number;
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

export function loadConfig(): AppConfig {
  const debugPort = Number(process.env.WXMP_DEBUG_PORT ?? 9421);
  return {
    workspaceRoot: path.resolve(process.env.WXMP_WORKSPACE_ROOT ?? defaultWorkspaceRoot()),
    profileDirs: splitPaths(process.env.WXMP_PROFILE_DIR),
    legacyProfileDirs: splitPaths(process.env.WXMP_LEGACY_PROFILE_DIR),
    gwxapkgPath: defaultGwxapkg(),
    debugHost: process.env.WXMP_DEBUG_HOST ?? '127.0.0.1',
    debugPort: Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536 ? debugPort : 9421,
    eventLimit: Math.max(100, Number(process.env.WXMP_EVENT_LIMIT ?? 5000)),
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
