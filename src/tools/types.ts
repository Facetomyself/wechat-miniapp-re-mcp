import { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;
export interface ToolEntry { tool: Tool; handler: ToolHandler }

export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }],
  };
}
