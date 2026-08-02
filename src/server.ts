import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { WxmpApp } from './app.js';
import { errorPayload, WxmpError } from './errors.js';
import { buildTools } from './tools/registry.js';
import { VERSION } from './version.js';
import { getPrompt, listPrompts, listResources, listResourceTemplates, readResource, SERVER_INSTRUCTIONS } from './mcp/catalog.js';

export function createServer(app: WxmpApp): Server {
  const entries = buildTools(app);
  const handlers = new Map(entries.map((entry) => [entry.tool.name, entry]));
  const schemaValidator = new AjvJsonSchemaValidator();
  const validators = new Map(entries.map((entry) => [entry.tool.name, schemaValidator.getValidator(entry.tool.inputSchema)]));
  const server = new Server(
    { name: 'wechat-miniapp-re-mcp', version: VERSION },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entries.map((entry) => entry.tool) }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => getPrompt(request.params.name, request.params.arguments ?? {}));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: listResources(app) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: listResourceTemplates() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readResource(app, request.params.uri));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = handlers.get(request.params.name);
    if (!entry) {
      const payload = errorPayload(new WxmpError('TOOL_NOT_FOUND', `Unknown tool: ${request.params.name}`, { name: request.params.name }));
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
    }
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
      const payload = errorPayload(error);
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: true };
    }
  });
  server.onclose = async () => app.shutdown();
  return server;
}
