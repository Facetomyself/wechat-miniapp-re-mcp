import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppConfig, defaultPackageRoots } from '../config.js';
import { WxmpError } from '../errors.js';
import { resolveInside, safeProjectName } from '../security.js';

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.wxml', '.wxss', '.wxs', '.html', '.css', '.ts', '.txt', '.md']);

export interface PackageRecord {
  appId: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export class StaticAdapter {
  constructor(private readonly config: AppConfig) {}

  info(): Record<string, unknown> {
    return {
      backend: 'Gwxapkg',
      executable: this.config.gwxapkgPath,
      available: Boolean(this.config.gwxapkgPath && existsSync(this.config.gwxapkgPath)),
      defaultRoots: defaultPackageRoots(),
    };
  }

  async scan(roots?: string[], limit = 1000): Promise<PackageRecord[]> {
    const output: PackageRecord[] = [];
    for (const root of roots?.length ? roots : defaultPackageRoots()) {
      if (!existsSync(root)) continue;
      await walk(root, async (filePath, stat) => {
        if (output.length >= limit || path.extname(filePath).toLowerCase() !== '.wxapkg') return;
        const relative = path.relative(root, filePath).split(path.sep);
        const appId = relative.find((segment) => /^wx[a-zA-Z0-9_-]+$/.test(segment)) ?? relative[0] ?? 'unknown';
        output.push({
          appId,
          path: filePath,
          name: path.basename(filePath),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }, 8, () => output.length >= limit);
    }
    return output.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async decompile(options: {
    inputPath: string;
    projectName: string;
    appId?: string;
    outputName?: string;
    extraArgs?: string[];
  }): Promise<Record<string, unknown>> {
    const executable = this.requireBackend();
    rejectReservedArgs(options.extraArgs ?? [], ['-in', '-out', '-id']);
    const project = safeProjectName(options.projectName);
    const outputRoot = resolveInside(this.config.workspaceRoot, project, 'wechat-miniapp', 'static');
    const outputPath = resolveInside(outputRoot, options.outputName ?? `decompile-${Date.now()}`);
    await fs.mkdir(outputPath, { recursive: true });
    const appId = options.appId ?? extractAppId(options.inputPath);
    const args = [
      ...(appId ? [`-id=${appId}`] : []),
      `-in=${path.resolve(options.inputPath)}`,
      `-out=${outputPath}`,
      ...(options.extraArgs ?? []),
    ];
    const result = await this.run(executable, args);
    const generated = await fs.readdir(outputPath).catch(() => []);
    if (generated.length === 0) {
      throw new WxmpError('STATIC_ADAPTER_NO_OUTPUT', 'Gwxapkg exited without producing files', {
        inputPath: path.resolve(options.inputPath),
        outputPath,
        appId,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return { ...result, outputPath, args, appId };
  }

  async repack(options: { inputPath: string; projectName: string; outputName?: string }): Promise<Record<string, unknown>> {
    const executable = this.requireBackend();
    const project = safeProjectName(options.projectName);
    const outputRoot = resolveInside(this.config.workspaceRoot, project, 'wechat-miniapp', 'static', 'repacked');
    await fs.mkdir(outputRoot, { recursive: true });
    const outputPath = resolveInside(outputRoot, options.outputName ?? `repacked-${Date.now()}.wxapkg`);
    const result = await this.run(executable, ['repack', `-in=${path.resolve(options.inputPath)}`, `-out=${outputPath}`]);
    return { ...result, outputPath };
  }

  async raw(args: string[], projectName: string, outputName?: string): Promise<Record<string, unknown>> {
    const executable = this.requireBackend();
    rejectReservedArgs(args, ['-out']);
    const project = safeProjectName(projectName);
    const outputRoot = resolveInside(this.config.workspaceRoot, project, 'wechat-miniapp', 'static', 'raw');
    await fs.mkdir(outputRoot, { recursive: true });
    const isRepack = args.some((arg) => arg.toLowerCase() === 'repack');
    const defaultName = isRepack ? `raw-${Date.now()}.wxapkg` : `raw-${Date.now()}`;
    const outputPath = resolveInside(outputRoot, outputName ?? defaultName);
    const result = await this.run(executable, [...args, `-out=${outputPath}`]);
    return { ...result, outputPath };
  }

  async search(root: string, query: string, options: { regex?: boolean; caseSensitive?: boolean; limit?: number } = {}): Promise<Record<string, unknown>> {
    const base = path.resolve(root);
    if (!existsSync(base)) throw new WxmpError('STATIC_ROOT_NOT_FOUND', `Static output path does not exist: ${base}`);
    const flags = options.caseSensitive ? 'g' : 'gi';
    const expression = options.regex ? new RegExp(query, flags) : new RegExp(escapeRegExp(query), flags);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const limit = Math.min(5000, Math.max(1, options.limit ?? 200));
    await walk(base, async (filePath, stat) => {
      if (matches.length >= limit || stat.size > 8 * 1024 * 1024 || !TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        expression.lastIndex = 0;
        if (expression.test(lines[index])) matches.push({ path: filePath, line: index + 1, text: lines[index].slice(0, 1000) });
      }
    }, 20, () => matches.length >= limit);
    return { root: base, query, count: matches.length, matches };
  }

  async buildIndex(root: string, projectName: string): Promise<Record<string, unknown>> {
    const base = path.resolve(root);
    const urls = new Set<string>();
    const wxApis = new Set<string>();
    const routes = new Set<string>();
    const files: Array<{ path: string; size: number }> = [];
    await walk(base, async (filePath, stat) => {
      files.push({ path: filePath, size: stat.size });
      if (stat.size > 8 * 1024 * 1024 || !TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
      const content = await fs.readFile(filePath, 'utf8').catch(() => '');
      for (const match of content.matchAll(/https?:\/\/[^\s"'`<>]+/g)) urls.add(match[0]);
      for (const match of content.matchAll(/\bwx\.([A-Za-z_$][\w$]*)/g)) wxApis.add(match[1]);
      for (const match of content.matchAll(/(?:navigateTo|redirectTo|reLaunch|switchTab)\s*\(\s*\{[^}]*?url\s*:\s*["'`]([^"'`]+)["'`]/g)) routes.add(match[1]);
    }, 30);
    const project = safeProjectName(projectName);
    const artifactDir = resolveInside(this.config.workspaceRoot, project, 'wechat-miniapp', 'static', 'indexes');
    await fs.mkdir(artifactDir, { recursive: true });
    const outputPath = resolveInside(artifactDir, `index-${Date.now()}.json`);
    const index = {
      schemaVersion: 1,
      root: base,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      urls: [...urls].sort(),
      wxApis: [...wxApis].sort(),
      routes: [...routes].sort(),
    };
    await fs.writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return { ...index, outputPath };
  }

  private requireBackend(): string {
    const executable = this.config.gwxapkgPath;
    if (!executable || !existsSync(executable)) {
      throw new WxmpError('STATIC_ADAPTER_UNAVAILABLE', 'Gwxapkg executable is not configured', {
        configuredPath: executable,
        env: 'WXMP_GWXAPKG',
      });
    }
    return executable;
  }

  private async run(executable: string, args: string[]): Promise<Record<string, unknown>> {
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      return { ok: true, exitCode: 0, stdout: stdout.slice(-64_000), stderr: stderr.slice(-64_000) };
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
      throw new WxmpError('STATIC_ADAPTER_FAILED', 'Gwxapkg command failed', {
        executable,
        args,
        code: value.code,
        message: value.message,
        stdout: value.stdout?.slice(-64_000),
        stderr: value.stderr?.slice(-64_000),
      });
    }
  }
}

async function walk(
  root: string,
  onFile: (filePath: string, stat: Stats) => Promise<void>,
  maxDepth: number,
  stop: () => boolean = () => false,
): Promise<void> {
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > maxDepth || stop()) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (stop()) return;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile()) await onFile(target, await fs.stat(target));
    }
  }
  await visit(root, 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAppId(value: string): string | undefined {
  return path.resolve(value).split(path.sep).find((segment) => /^wx[a-zA-Z0-9_-]{6,}$/.test(segment));
}

function rejectReservedArgs(args: string[], reserved: string[]): void {
  const invalid = args.filter((arg) => reserved.some((name) => {
    const lower = arg.toLowerCase();
    return lower === name || lower.startsWith(`${name}=`);
  }));
  if (invalid.length) {
    throw new WxmpError('STATIC_RESERVED_ARGUMENT', 'Static adapter arguments cannot override controlled input, output, or app-id fields', {
      invalid,
      reserved,
    });
  }
}
