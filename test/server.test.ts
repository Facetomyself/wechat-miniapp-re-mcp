import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WxmpApp } from '../src/app.js';
import { createServer } from '../src/server.js';

test('server validates tool-specific JSON schemas before invoking handlers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-server-'));
  const app = new WxmpApp({
    workspaceRoot: root,
    profileDirs: [],
    legacyProfileDirs: [],
    signatureDbPaths: [],
    gwxapkgPath: null,
    debugHost: '127.0.0.1',
    debugPort: 0,
    eventLimit: 5000,
    maxEvidenceEvents: 100_000,
    maxEvidenceBytes: 256 * 1024 * 1024,
  });
  const server = createServer(app);
  const client = new Client({ name: 'fixture-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const health = await client.callTool({ name: 'wxmp_health', arguments: {} });
    assert.equal(health.isError, undefined);
    const invalid = await client.callTool({
      name: 'wxmp_scan_packages',
      arguments: { limit: '2' } as unknown as Record<string, unknown>,
    });
    assert.equal(invalid.isError, true);
    const content = invalid.content as Array<{ type: string; text?: string }>;
    assert.match(String(content[0].text), /INVALID_ARGUMENT/);
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
