import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppConfig } from '../config.js';
import { WxmpError } from '../errors.js';
import { resolveInside, safeProjectName } from '../security.js';

const execFileAsync = promisify(execFile);
const NODE_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

export interface ExtractorInfo {
  available: boolean;
  pythonPath: string | null;
  scriptPath: string | null;
  name: 'wmpf-offset-adaptation';
}

export interface ExtractorRawResult {
  Version?: number;
  LoadStartHookOffset?: string;
  CDPFilterHookOffset?: string;
  SceneOffsets?: number[];
}

export interface ExtractorRunResult {
  raw: ExtractorRawResult;
  outputPath: string;
  stdout: string;
  stderr: string;
  pythonPath: string | null;
  scriptPath: string;
}

export class OffsetExtractorAdapter {
  constructor(private readonly config: AppConfig) {}

  info(): ExtractorInfo {
    const pythonPath = this.config.offsetExtractorPython ?? null;
    const scriptPath = this.config.offsetExtractorScript ?? null;
    return {
      name: 'wmpf-offset-adaptation',
      pythonPath,
      scriptPath,
      available: Boolean(scriptPath && existsSync(scriptPath) && (this.isNodeScript(scriptPath) || (pythonPath && existsSync(pythonPath)))),
    };
  }

  async archiveModule(sourcePath: string, projectName: string, version: number): Promise<{ path: string; sha256: string }> {
    const resolved = path.resolve(sourcePath);
    if (!existsSync(resolved)) {
      throw new WxmpError('EXTRACTOR_MODULE_NOT_FOUND', `WMPF module does not exist: ${resolved}`, { sourcePath: resolved });
    }
    const project = safeProjectName(projectName);
    const destDir = resolveInside(this.config.workspaceRoot, project, 'wechat-miniapp', 'modules');
    await fs.mkdir(destDir, { recursive: true });
    const dest = resolveInside(destDir, `${path.parse(resolved).name}-${version}${path.extname(resolved)}`);
    await fs.copyFile(resolved, dest);
    const hash = createHash('sha256');
    hash.update(await fs.readFile(dest));
    return { path: dest, sha256: hash.digest('hex') };
  }

  async extract(options: { version: number; dllPath: string; outputPath: string }): Promise<ExtractorRunResult> {
    const info = this.info();
    if (!info.scriptPath || !existsSync(info.scriptPath)) {
      throw unavailable(info);
    }
    const nodeScript = this.isNodeScript(info.scriptPath);
    if (!nodeScript && (!info.pythonPath || !existsSync(info.pythonPath))) {
      throw unavailable(info);
    }
    const outputPath = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const args = [
      `--version`, String(options.version),
      `--dll`, path.resolve(options.dllPath),
      `--output`, outputPath,
    ];
    const command = nodeScript ? process.execPath : info.pythonPath!;
    const commandArgs = [info.scriptPath, ...args];
    try {
      const { stdout, stderr } = await execFileAsync(command, commandArgs, {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      });
      const raw = parseExtractorJson(stdout, outputPath);
      return {
        raw,
        outputPath,
        stdout: stdout.slice(-64_000),
        stderr: stderr.slice(-64_000),
        pythonPath: nodeScript ? process.execPath : info.pythonPath,
        scriptPath: info.scriptPath,
      };
    } catch (error) {
      if (error instanceof WxmpError) throw error;
      const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
      throw new WxmpError('EXTRACTOR_FAILED', 'Offset extractor command failed', {
        command,
        args: commandArgs,
        code: value.code,
        message: value.message,
        stdout: value.stdout?.slice(-64_000),
        stderr: value.stderr?.slice(-64_000),
        pythonPath: info.pythonPath,
        scriptPath: info.scriptPath,
      }, {
        retryable: false,
        needsUserAction: true,
        missingCapability: 'runtimeProfile',
        userAction: `Offset extractor failed. Inspect ${info.scriptPath} output; do not reuse offsets from another WMPF version.`,
        nextActions: ['wxmp_doctor'],
      });
    }
  }

  private isNodeScript(scriptPath: string): boolean {
    return NODE_SCRIPT_EXTENSIONS.has(path.extname(scriptPath).toLowerCase());
  }
}

export function parseExtractorJson(stdout: string, outputPath: string): ExtractorRawResult {
  try {
    if (existsSync(outputPath)) {
      const fromFile = JSON.parse(readFileSync(outputPath, 'utf8')) as ExtractorRawResult;
      if (fromFile && typeof fromFile === 'object') return fromFile;
    }
    const trimmed = stdout.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new WxmpError('EXTRACTOR_OUTPUT_INVALID', 'Extractor did not return JSON object output', { outputPath });
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as ExtractorRawResult;
  } catch (error) {
    if (error instanceof WxmpError) throw error;
    throw new WxmpError('EXTRACTOR_OUTPUT_INVALID', 'Extractor output is not valid JSON', {
      outputPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function unavailable(info: ExtractorInfo): WxmpError {
  return new WxmpError('EXTRACTOR_UNAVAILABLE', 'wmpf-offset-adaptation extractor is not configured or not installed', {
    pythonPath: info.pythonPath,
    scriptPath: info.scriptPath,
    install: [
      info.pythonPath ?? '<python>',
      info.scriptPath ?? '<extract_wmpf_offsets.py>',
    ].join(' '),
  }, {
    retryable: false,
    needsUserAction: true,
    missingCapability: 'runtimeProfile',
    userAction: `Install or configure the extractor: python="${info.pythonPath ?? ''}" script="${info.scriptPath ?? ''}". Set WXMP_OFFSET_EXTRACTOR and WXMP_OFFSET_EXTRACTOR_PYTHON.`,
    nextActions: ['wxmp_doctor'],
  });
}
