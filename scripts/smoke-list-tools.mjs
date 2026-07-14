import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const serverPath = path.resolve('build/src/index.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, WXMP_WORKSPACE_ROOT: path.resolve('.wxmp-workspace') },
  stderr: 'pipe',
});
const client = new Client({ name: 'wxmp-smoke', version: '0.1.0' }, { capabilities: {} });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const health = await client.callTool({ name: 'wxmp_health', arguments: {} });
  if (listed.tools.length < 35 || !listed.tools.every((tool) => tool.name.startsWith('wxmp_')) || health.isError) {
    throw new Error(`Smoke contract failed: tools=${listed.tools.length} healthError=${Boolean(health.isError)}`);
  }
  console.log(JSON.stringify({ ok: true, tools: listed.tools.length }));
} finally {
  await client.close();
}
