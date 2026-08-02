import { WxmpApp } from '../app.js';
import { buildSessionTools } from './session.js';
import { buildDynamicTools } from './dynamic.js';
import { buildStaticTools } from './static.js';
import { buildProfileTools } from './profile.js';
import { buildAgentTools } from './agent.js';
import { ToolEntry } from './types.js';
import { Toolset } from '../config.js';

export const AGENT_TOOL_NAMES = new Set([
  'wxmp_health',
  'wxmp_doctor',
  'wxmp_open',
  'wxmp_status',
  'wxmp_app_snapshot',
  'wxmp_observe_window',
  'wxmp_list_requests',
  'wxmp_get_request',
  'wxmp_get_api_inventory',
  'wxmp_replay_request',
  'wxmp_search_sources',
  'wxmp_static_search',
  'wxmp_scan_packages',
  'wxmp_decompile',
  'wxmp_export_evidence',
  'wxmp_close',
]);

export function buildAllTools(app: WxmpApp): ToolEntry[] {
  return [
    ...buildAgentTools(app),
    ...buildSessionTools(app),
    ...buildDynamicTools(app),
    ...buildStaticTools(app),
    ...buildProfileTools(app),
  ].map((entry) => AGENT_TOOL_NAMES.has(entry.tool.name) ? { ...entry, visibility: 'agent' as const } : entry);
}

export function buildTools(app: WxmpApp, toolset: Toolset = app.config.toolset): ToolEntry[] {
  const all = buildAllTools(app);
  return toolset === 'expert' ? all : all.filter((entry) => entry.visibility === 'agent');
}
