import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AuditEvent, EvidenceFinding, JsonValue } from '../types.js';
import { resolveInside, safeProjectName, sanitize } from '../security.js';

export class EvidenceStore {
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly eventsPath: string;
  private queue: Promise<void> = Promise.resolve();
  private eventCount = 0;

  constructor(workspaceRoot: string, projectName: string, public readonly sessionId: string, private readonly eventLimit = 5000) {
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

  async flush(): Promise<void> {
    await this.queue;
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
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(this.eventLimit, Math.max(1, Math.trunc(limit)));
    return { total: items.length, items: items.slice(safeOffset, safeOffset + safeLimit) };
  }

  async exportBundle(summary: Record<string, unknown>, findings: EvidenceFinding[]): Promise<Record<string, string>> {
    await this.queue;
    const events = await this.readAllEvents();
    const eventTypeCounts = Object.fromEntries(
      [...events.reduce((counts, event) => counts.set(event.type, (counts.get(event.type) ?? 0) + 1), new Map<string, number>())]
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const normalizedFindings = deriveFindings(summary, findings);
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      eventCount: this.eventCount,
      events: this.eventsPath,
      eventTypeCounts,
      findingCount: normalizedFindings.length,
      summary: sanitize(summary),
    };
    const manifestPath = await this.writeJson('evidence-manifest.json', manifest);
    const findingsPath = await this.writeJson('findings.json', normalizedFindings);
    const openFindings = normalizedFindings.filter((finding) => finding.status === 'open');
    const findingLines = normalizedFindings.length
      ? normalizedFindings.map((finding) => `- **${finding.severity.toUpperCase()} / ${finding.status} / ${escapeMarkdown(finding.id)}**: ${escapeMarkdown(finding.title)} — ${escapeMarkdown(finding.summary)}`).join('\n')
      : '- No findings recorded.';
    const reportPath = await this.writeText(
      'report.md',
      `# WeChat Miniapp Reverse Session\n\n- Session: \`${this.sessionId}\`\n- Generated: ${manifest.generatedAt}\n- Events: ${this.eventCount}\n- Findings: ${normalizedFindings.length} total / ${openFindings.length} open\n\n## Findings\n\n${findingLines}\n\n## Event Type Summary\n\n\`\`\`json\n${JSON.stringify(eventTypeCounts, null, 2)}\n\`\`\`\n\n## Session Summary\n\n\`\`\`json\n${JSON.stringify(sanitize(summary), null, 2)}\n\`\`\`\n`,
    );
    const triageLines = openFindings.length
      ? openFindings.map((finding, index) => `${index + 1}. [${finding.severity.toUpperCase()}] ${escapeMarkdown(finding.title)}\n   - ${escapeMarkdown(finding.summary)}\n   - Evidence: ${finding.evidenceTypes.map((type) => `\`${escapeMarkdown(type)}\``).join(', ') || 'session status'}`).join('\n')
      : 'No open capability gaps were recorded for this session.';
    const triagePath = await this.writeText(
      'triage.md',
      `# Triage\n\n${triageLines}\n`,
    );
    return { manifestPath, findingsPath, reportPath, triagePath, eventsPath: this.eventsPath };
  }

  private async readAllEvents(): Promise<AuditEvent[]> {
    let text = '';
    try {
      text = await fs.readFile(this.eventsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
  }
}

function deriveFindings(summary: Record<string, unknown>, findings: EvidenceFinding[]): EvidenceFinding[] {
  const output = findings.map((finding) => ({ ...finding, evidenceTypes: [...finding.evidenceTypes] }));
  const state = String(summary.state ?? 'unknown');
  if (['waiting_for_runtime', 'disconnected', 'failed'].includes(state) && !output.some((finding) => finding.id === 'runtime-not-ready')) {
    const now = new Date().toISOString();
    output.push({
      id: 'runtime-not-ready',
      title: 'WMPF runtime channel is not ready',
      severity: 'high',
      status: 'open',
      summary: `Session exported in state ${state}; context-sensitive CDP capabilities remain gated.`,
      evidenceTypes: ['session.attach_result', 'runtime.disconnected', 'session.attach_failed'],
      firstObservedAt: now,
      lastObservedAt: now,
    });
  }
  return output.sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id));
}

function severityRank(value: EvidenceFinding['severity']): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
