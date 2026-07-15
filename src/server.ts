import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WxmpApp } from './app.js';
import { errorPayload } from './errors.js';
import { buildTools } from './tools/registry.js';
import { VERSION } from './version.js';

export function createServer(app: WxmpApp): Server {
  const entries = buildTools(app);
  const handlers = new Map(entries.map((entry) => [entry.tool.name, entry]));
  const server = new Server(
    { name: 'wechat-miniapp-re-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entries.map((entry) => entry.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = handlers.get(request.params.name);
    if (!entry) return { content: [{ type: 'text', text: JSON.stringify(errorPayload(new Error(`Unknown tool: ${request.params.name}`)), null, 2) }], isError: true };
    try {
      return await entry.handler((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      console.error(`[wxmp] tool ${request.params.name} failed:`, error);
      return { content: [{ type: 'text', text: JSON.stringify(errorPayload(error), null, 2) }], isError: true };
    }
  });
  server.onclose = async () => app.shutdown();
  return server;
}
