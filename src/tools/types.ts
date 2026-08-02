import { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;
export type ToolVisibility = 'agent' | 'expert';

export interface ToolOptions {
  title?: string;
  annotations?: ToolAnnotations;
  outputSchema?: Tool['outputSchema'];
  visibility?: ToolVisibility;
}

export interface ToolEntry {
  tool: Tool;
  handler: ToolHandler;
  visibility: ToolVisibility;
}

export function jsonResult(data: unknown): CallToolResult {
  const structuredContent = { ok: true, data };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}
