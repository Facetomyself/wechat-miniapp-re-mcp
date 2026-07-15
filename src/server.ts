import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { WxmpApp } from './app.js';
import { errorPayload, WxmpError } from './errors.js';
import { buildTools } from './tools/registry.js';
import { VERSION } from './version.js';

export function createServer(app: WxmpApp): Server {
  const entries = buildTools(app);
  const handlers = new Map(entries.map((entry) => [entry.tool.name, entry]));
  const schemaValidator = new AjvJsonSchemaValidator();
  const validators = new Map(entries.map((entry) => [entry.tool.name, schemaValidator.getValidator(entry.tool.inputSchema)]));
  const server = new Server(
    { name: 'wechat-miniapp-re-mcp', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entries.map((entry) => entry.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = handlers.get(request.params.name);
    if (!entry) return { content: [{ type: 'text', text: JSON.stringify(errorPayload(new Error(`Unknown tool: ${request.params.name}`)), null, 2) }], isError: true };
    try {
      const args = request.params.arguments ?? {};
      const validation = validators.get(request.params.name)!(args);
      if (!validation.valid) {
        throw new WxmpError('INVALID_ARGUMENT', `Arguments for ${request.params.name} do not match the tool schema`, {
          validation: validation.errorMessage,
        });
      }
      return await entry.handler(validation.data as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof WxmpError)) console.error(`[wxmp] tool ${request.params.name} failed:`, error);
      return { content: [{ type: 'text', text: JSON.stringify(errorPayload(error), null, 2) }], isError: true };
    }
  });
  server.onclose = async () => app.shutdown();
  return server;
}
