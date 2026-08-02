import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { AuditEvent, EvidenceFinding, JsonValue } from '../types.js';
import { resolveInside, safeProjectName, sanitize } from '../security.js';

export class EvidenceStore {
  readonly projectRoot: string;
  readonly sessionRoot: string;
  readonly eventsPath: string;
  private queue: Promise<void> = Promise.resolve();
  private eventCount = 0;
  private eventBytes = 0;
  private queuedEventCount = 0;
  private queuedEventBytes = 0;
  private droppedEventCount = 0;
  private droppedEventBytes = 0;
  private truncatedEventCount = 0;
  private readonly corruptLineNumbers = new Set<number>();
  private lastWriteError: string | null = null;

  constructor(
    workspaceRoot: string,
    projectName: string,
    public readonly sessionId: string,
    private readonly eventLimit = 5000,
    private readonly maxEvents = 100_000,
    private readonly maxBytes = 256 * 1024 * 1024,
    private readonly maxEventBytes = 1024 * 1024,
  ) {
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
    const event = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      contextId: meta.contextId,
      operation: meta.operation,
      type,
      data: sanitize(data) as JsonValue,
    } satisfies AuditEvent;
    const encoded = encodeEvent(event, this.maxEventBytes);
    if (this.queuedEventCount >= this.maxEvents || this.queuedEventBytes + encoded.bytes > this.maxBytes) {
      this.droppedEventCount += 1;
      this.droppedEventBytes += encoded.bytes;
      return Promise.resolve();
    }
    if (encoded.truncated) this.truncatedEventCount += 1;
    this.queuedEventCount += 1;
    this.queuedEventBytes += encoded.bytes;
    const write = this.queue.then(async () => {
      try {
        await fs.appendFile(this.eventsPath, encoded.line, { encoding: 'utf8' });
        this.eventCount += 1;
        this.eventBytes += encoded.bytes;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
      }
    });
    this.queue = write;
    return write;
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

  async writeBinary(name: string, content: Buffer, maxBytes = content.length): Promise<{
    path: string;
    originalBytes: number;
    writtenBytes: number;
    truncated: boolean;
  }> {
    const target = resolveInside(this.sessionRoot, 'artifacts', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const writtenBytes = Math.max(0, Math.min(content.length, Math.trunc(maxBytes)));
    await fs.writeFile(target, content.subarray(0, writtenBytes));
    return {
      path: target,
      originalBytes: content.length,
      writtenBytes,
      truncated: writtenBytes < content.length,
    };
  }

  async status(): Promise<Record<string, unknown>> {
    await this.queue;
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      sessionRoot: this.sessionRoot,
      eventsPath: this.eventsPath,
      eventCount: this.eventCount,
      eventBytes: this.eventBytes,
      queuedEventCount: this.queuedEventCount,
      queuedEventBytes: this.queuedEventBytes,
      droppedEventCount: this.droppedEventCount,
      droppedEventBytes: this.droppedEventBytes,
      truncatedEventCount: this.truncatedEventCount,
      corruptLineCount: this.corruptLineNumbers.size,
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
      maxEventBytes: this.maxEventBytes,
      lastWriteError: this.lastWriteError,
    };
  }

  async readEvents(offset = 0, limit = 100, type?: string): Promise<{ total: number; items: AuditEvent[] }> {
    await this.queue;
    const safeOffset = Math.max(0, Math.trunc(offset));
    const safeLimit = Math.min(this.eventLimit, Math.max(1, Math.trunc(limit)));
    let total = 0;
    const items: AuditEvent[] = [];
    for await (const event of this.iterateEvents()) {
      if (type && event.type !== type) continue;
      if (total >= safeOffset && items.length < safeLimit) items.push(event);
      total += 1;
    }
    return { total, items };
  }

  async exportBundle(summary: Record<string, unknown>, findings: EvidenceFinding[]): Promise<Record<string, string>> {
    await this.queue;
    const eventTypeCounts = await this.eventTypeCounts();
    const normalizedFindings = deriveFindings(summary, findings, {
      droppedEventCount: this.droppedEventCount,
      droppedEventBytes: this.droppedEventBytes,
      truncatedEventCount: this.truncatedEventCount,
      corruptLineCount: this.corruptLineNumbers.size,
      lastWriteError: this.lastWriteError,
    });
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      eventCount: this.eventCount,
      eventBytes: this.eventBytes,
      droppedEventCount: this.droppedEventCount,
      droppedEventBytes: this.droppedEventBytes,
      truncatedEventCount: this.truncatedEventCount,
      corruptLineCount: this.corruptLineNumbers.size,
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
      maxEventBytes: this.maxEventBytes,
      lastWriteError: this.lastWriteError,
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

  private async *iterateEvents(): AsyncGenerator<AuditEvent> {
    try {
      const stream = createReadStream(this.eventsPath, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as AuditEvent;
        } catch {
          this.corruptLineNumbers.add(lineNumber);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async eventTypeCounts(): Promise<Record<string, number>> {
    const counts = new Map<string, number>();
    for await (const event of this.iterateEvents()) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
  }
}

function deriveFindings(
  summary: Record<string, unknown>,
  findings: EvidenceFinding[],
  evidenceHealth: {
    droppedEventCount: number;
    droppedEventBytes: number;
    truncatedEventCount: number;
    corruptLineCount: number;
    lastWriteError: string | null;
  },
): EvidenceFinding[] {
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
  if (evidenceHealth.droppedEventCount > 0 && !output.some((finding) => finding.id === 'evidence-overflow')) {
    output.push(derivedFinding({
      id: 'evidence-overflow',
      title: 'Evidence event limit was reached',
      severity: 'high',
      summary: `${evidenceHealth.droppedEventCount} events (${evidenceHealth.droppedEventBytes} bytes) were dropped after the configured evidence cap was reached.`,
      evidenceTypes: ['evidence.overflow'],
    }));
  }
  if (evidenceHealth.truncatedEventCount > 0 && !output.some((finding) => finding.id === 'evidence-event-truncated')) {
    output.push(derivedFinding({
      id: 'evidence-event-truncated',
      title: 'Oversized evidence events were truncated',
      severity: 'medium',
      summary: `${evidenceHealth.truncatedEventCount} events exceeded the per-event byte limit and were persisted as bounded previews.`,
      evidenceTypes: ['evidence.event_truncated'],
    }));
  }
  if (evidenceHealth.corruptLineCount > 0 && !output.some((finding) => finding.id === 'evidence-corrupt-lines')) {
    output.push(derivedFinding({
      id: 'evidence-corrupt-lines',
      title: 'Evidence stream contains malformed lines',
      severity: 'high',
      summary: `${evidenceHealth.corruptLineCount} malformed NDJSON lines were skipped while exporting evidence.`,
      evidenceTypes: ['evidence.corrupt_line'],
    }));
  }
  if (evidenceHealth.lastWriteError && !output.some((finding) => finding.id === 'evidence-write-error')) {
    output.push(derivedFinding({
      id: 'evidence-write-error',
      title: 'Evidence persistence reported a write error',
      severity: 'critical',
      summary: evidenceHealth.lastWriteError,
      evidenceTypes: ['evidence.write_error'],
    }));
  }
  return output.sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id));
}

function encodeEvent(event: AuditEvent, maxEventBytes: number): { line: string; bytes: number; truncated: boolean } {
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes <= maxEventBytes) return { line, bytes, truncated: false };
  const preview = JSON.stringify(event.data).slice(0, Math.min(16_000, Math.max(256, Math.floor(maxEventBytes / 2))));
  const truncatedEvent: AuditEvent = {
    ...event,
    data: {
      truncated: true,
      reason: 'event-byte-limit',
      originalBytes: bytes,
      preview,
    },
  };
  const truncatedLine = `${JSON.stringify(truncatedEvent)}\n`;
  return { line: truncatedLine, bytes: Buffer.byteLength(truncatedLine, 'utf8'), truncated: true };
}

function derivedFinding(input: Pick<EvidenceFinding, 'id' | 'title' | 'severity' | 'summary' | 'evidenceTypes'>): EvidenceFinding {
  const now = new Date().toISOString();
  return {
    ...input,
    status: 'open',
    firstObservedAt: now,
    lastObservedAt: now,
  };
}

function severityRank(value: EvidenceFinding['severity']): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}
