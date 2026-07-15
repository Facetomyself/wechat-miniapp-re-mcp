import { WxmpApp } from '../app.js';
import { buildSessionTools } from './session.js';
import { buildDynamicTools } from './dynamic.js';
import { buildStaticTools } from './static.js';
import { buildProfileTools } from './profile.js';
import { ToolEntry } from './types.js';

export function buildTools(app: WxmpApp): ToolEntry[] {
  return [
    ...buildSessionTools(app),
    ...buildDynamicTools(app),
    ...buildStaticTools(app),
    ...buildProfileTools(app),
  ];
}
