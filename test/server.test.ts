import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WxmpApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { SERVER_INSTRUCTIONS } from '../src/mcp/catalog.js';
import { buildTools } from '../src/tools/registry.js';

test('server validates tool-specific JSON schemas before invoking handlers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wxmp-server-'));
  const app = new WxmpApp({
    toolset: 'agent',
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
    protocolPreviewBytes: 2048,
    maxProtocolArtifactBytes: 8 * 1024 * 1024,
  });
  const server = createServer(app);
  const client = new Client({ name: 'fixture-client', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const health = await client.callTool({ name: 'wxmp_doctor', arguments: {} });
    assert.equal(health.isError, undefined);
    assert.equal((health.structuredContent as Record<string, unknown>).ok, true);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 18);
    assert.ok(listed.tools.some((tool) => tool.name === 'wxmp_open'));
    assert.ok(listed.tools.some((tool) => tool.name === 'wxmp_evaluate'));
    assert.ok(listed.tools.some((tool) => tool.name === 'wxmp_list_scripts'));
    assert.ok(listed.tools.some((tool) => tool.name === 'wxmp_correlate'));
    assert.ok(!listed.tools.some((tool) => tool.name === 'wxmp_health'));
    assert.ok(!listed.tools.some((tool) => tool.name === 'wxmp_raw_cdp'));
    for (const listedTool of listed.tools) {
      assert.ok(listedTool.title);
      assert.ok(listedTool.outputSchema);
      assert.ok(listedTool.annotations);
    }
    const expertTools = buildTools(app, 'expert');
    assert.equal(expertTools.length, 70);
    assert.ok(expertTools.some((entry) => entry.tool.name === 'wxmp_get_paused_state'));
    assert.ok(expertTools.some((entry) => entry.tool.name === 'wxmp_save_wasm'));
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_evaluate_on_call_frame')?.tool.annotations?.destructiveHint, true);
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_get_paused_state')?.tool.annotations?.readOnlyHint, true);
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_pause_info')?.tool.annotations?.destructiveHint, false);
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_trace_query')?.tool.annotations?.readOnlyHint, true);
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_evaluate')?.tool.annotations?.destructiveHint, true);
    assert.equal(expertTools.find((entry) => entry.tool.name === 'wxmp_replay_request')?.tool.annotations?.destructiveHint, true);
    assert.ok(SERVER_INSTRUCTIONS.includes('wxmp_open'));
    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), [
      'wxmp-protocol-recovery',
      'wxmp-recon',
      'wxmp-static-runtime-correlation',
    ]);
    const prompt = await client.getPrompt({ name: 'wxmp-recon', arguments: { project_name: 'fixture' } });
    assert.match((prompt.messages[0].content as { type: 'text'; text: string }).text, /wxmp_open/);
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), ['wxmp://server/status', 'wxmp://session/active']);
    const resourceTemplates = await client.listResourceTemplates();
    assert.equal(resourceTemplates.resourceTemplates.length, 3);
    const serverStatus = await client.readResource({ uri: 'wxmp://server/status' });
    assert.match((serverStatus.contents[0] as { text: string }).text, /"toolset": "agent"/);
    const invalid = await client.callTool({
      name: 'wxmp_scan_packages',
      arguments: { limit: '2' } as unknown as Record<string, unknown>,
    });
    assert.equal(invalid.isError, true);
    assert.equal((invalid.structuredContent as Record<string, unknown>).retryable, false);
    const content = invalid.content as Array<{ type: string; text?: string }>;
    assert.match(String(content[0].text), /INVALID_ARGUMENT/);
    const unknown = await client.callTool({ name: 'wxmp_not_real', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(((unknown.structuredContent as Record<string, unknown>).error as Record<string, unknown>).code, 'TOOL_NOT_FOUND');
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
