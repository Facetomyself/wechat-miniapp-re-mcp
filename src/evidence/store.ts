import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AuditEvent, JsonValue } from '../types.js';
import { resolveInside, safeProjectName, sanitize } from '../security.js';

export class EvidenceStore {
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly eventsPath: string;
  private queue: Promise<void> = Promise.resolve();
  private eventCount = 0;

  constructor(workspaceRoot: string, projectName: string, public readonly sessionId: string) {
    const project = safeProjectName(projectName);
    this.projectRoot = resolveInside(workspaceRoot, project, 'wechat-miniapp');
    this.sessionRoot = resolveInside(this.projectRoot, 'sessions', sessionId);
    this.eventsPath = resolveInside(this.sessionRoot, 'events.ndjson');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionRoot, { recursive: true });
    await fs.mkdir(resolveInside(this.sessionRoot, 'artifacts'), { recursive: true });
  }

  append(type: string, data: unknown, meta: { contextId?: string; operation?: string } = {}): Promise<void> {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      contextId: meta.contextId,
      operation: meta.operation,
      type,
      data: sanitize(data) as JsonValue,
    };
    const line = `${JSON.stringify(event)}\n`;
    this.eventCount += 1;
    this.queue = this.queue.then(() => fs.appendFile(this.eventsPath, line, { encoding: 'utf8' }));
    return this.queue;
  }

  async writeJson(name: string, data: unknown): Promise<string> {
    const target = resolveInside(this.sessionRoot, 'artifacts', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(sanitize(data), null, 2)}\n`, { encoding: 'utf8' });
    return target;
  }

  async writeText(name: string, content: string): Promise<string> {
    const target = resolveInside(this.sessionRoot, 'artifacts', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content.endsWith('\n') ? content : `${content}\n`, { encoding: 'utf8' });
    return target;
  }

  async readEvents(offset = 0, limit = 100, type?: string): Promise<{ total: number; items: AuditEvent[] }> {
    await this.queue;
    let text = '';
    try {
      text = await fs.readFile(this.eventsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const items = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
      .filter((event) => !type || event.type === type);
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  async exportBundle(summary: Record<string, unknown>, findings: unknown[]): Promise<Record<string, string>> {
    await this.queue;
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      eventCount: this.eventCount,
      events: this.eventsPath,
      summary: sanitize(summary),
    };
    const manifestPath = await this.writeJson('evidence-manifest.json', manifest);
    const findingsPath = await this.writeJson('findings.json', findings);
    const reportPath = await this.writeText(
      'report.md',
      `# WeChat Miniapp Reverse Session\n\n- Session: \`${this.sessionId}\`\n- Generated: ${manifest.generatedAt}\n- Events: ${this.eventCount}\n\n## Summary\n\n\`\`\`json\n${JSON.stringify(sanitize(summary), null, 2)}\n\`\`\`\n`,
    );
    const triagePath = await this.writeText(
      'triage.md',
      '# Triage\n\n未验证或受运行时能力限制的项目必须以 session capability 和事件证据为准。\n',
    );
    return { manifestPath, findingsPath, reportPath, triagePath, eventsPath: this.eventsPath };
  }
}
