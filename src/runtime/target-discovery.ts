import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { TargetProcess } from '../types.js';
import { WxmpError } from '../errors.js';

const execFileAsync = promisify(execFile);

interface RawProcess {
  ProcessId?: number;
  ParentProcessId?: number;
  ExecutablePath?: string | null;
  CommandLine?: string | null;
}

export function parseTarget(raw: RawProcess): TargetProcess | null {
  const pid = Number(raw.ProcessId ?? 0);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const executablePath = raw.ExecutablePath ?? '';
  const commandLine = raw.CommandLine ?? '';
  const versionMatch = executablePath.match(/[\\/]RadiumWMPF[\\/](\d+)[\\/]/i);
  const typeMatch = commandLine.match(/--type=([^\s"]+)/i);
  const renderMatch = commandLine.match(/--wmpf-render-type=(\d+)/i);
  const appIdMatch = commandLine.match(/--wmpf-appid=([^\s"]+)/i);
  return {
    pid,
    ppid: Number(raw.ParentProcessId ?? 0),
    executablePath,
    commandLine,
    version: versionMatch ? Number(versionMatch[1]) : null,
    processType: typeMatch?.[1] ?? 'browser',
    renderType: renderMatch ? Number(renderMatch[1]) : null,
    appId: appIdMatch?.[1] ?? null,
    isMain: !typeMatch,
  };
}

export async function discoverTargets(): Promise<TargetProcess[]> {
  if (process.platform !== 'win32') {
    throw new WxmpError('PLATFORM_UNSUPPORTED', 'Target discovery is implemented for Windows in v0.1', {
      platform: process.platform,
    });
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process -Filter \"Name='WeChatAppEx.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)",
    'ConvertTo-Json -Compress -Depth 4 -InputObject $items',
  ].join('; ');
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = stdout.trim() ? (JSON.parse(stdout) as RawProcess[] | RawProcess) : [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(parseTarget).filter((entry): entry is TargetProcess => entry !== null).sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.pid - b.pid;
  });
}

export async function resolveTarget(pid?: number): Promise<TargetProcess> {
  const targets = await discoverTargets();
  const selected = pid ? targets.find((target) => target.pid === pid) : targets.find((target) => target.isMain);
  if (!selected) {
    throw new WxmpError('TARGET_NOT_FOUND', pid ? `WMPF process ${pid} was not found` : 'No main WeChatAppEx.exe process was found', {
      pid,
      discovered: targets.map((target) => ({ pid: target.pid, isMain: target.isMain, processType: target.processType })),
    });
  }
  return selected;
}
