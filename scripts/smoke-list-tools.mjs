import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const summaries = [];
for (const [toolset, expected] of [['agent', 16], ['expert', 59]]) {
  const serverPath = path.resolve('build/src/index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, WXMP_TOOLSET: toolset, WXMP_WORKSPACE_ROOT: path.resolve('.wxmp-workspace') },
    stderr: 'pipe',
  });
  const client = new Client({ name: `wxmp-smoke-${toolset}`, version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const health = await client.callTool({ name: 'wxmp_health', arguments: {} });
    const prompts = await client.listPrompts();
    const resources = await client.listResources();
    if (listed.tools.length !== expected
      || !listed.tools.every((tool) => tool.name.startsWith('wxmp_') && tool.title && tool.outputSchema && tool.annotations)
      || health.isError
      || health.structuredContent?.ok !== true
      || prompts.prompts.length !== 3
      || resources.resources.length < 2) {
      throw new Error(`Smoke contract failed: toolset=${toolset} tools=${listed.tools.length} healthError=${Boolean(health.isError)} prompts=${prompts.prompts.length} resources=${resources.resources.length}`);
    }
    summaries.push({ toolset, tools: listed.tools.length, prompts: prompts.prompts.length, resources: resources.resources.length });
  } finally {
    await client.close();
  }
}
console.log(JSON.stringify({ ok: true, summaries }));
