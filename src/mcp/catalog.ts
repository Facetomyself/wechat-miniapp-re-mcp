import { WxmpApp } from '../app.js';
import { WxmpError } from '../errors.js';
import { VERSION } from '../version.js';

export const SERVER_INSTRUCTIONS = `Follow wxmp_doctor -> wxmp_open -> inspect -> wxmp_close. wxmp_open discovers the WMPF target, validates the runtime profile, attaches, waits or resumes a parked session, selects AppService, and returns resumeTool/resumeArguments when a foreground/reload is required. After open, use wxmp_evaluate, wxmp_list_scripts, wxmp_search_sources, wxmp_get_api_inventory, wxmp_observe_window, and wxmp_correlate. Always pass session_id; do not invent context_id. Request-hook reads are non-destructive. Set WXMP_TOOLSET=expert only for raw CDP, breakpoints, Profile internals, or adapter escape hatches.`;

interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  render: (args: Record<string, string>) => string;
}

const PROMPTS: PromptDefinition[] = [
  {
    name: 'wxmp-recon',
    title: 'WeChat Miniapp Recon',
    description: 'Bootstrap a mini-program session and collect a bounded runtime/API reconnaissance snapshot.',
    arguments: [{ name: 'project_name', description: 'Evidence workspace project name.' }],
    render: (args) => `Perform bounded WeChat mini-program reconnaissance${args.project_name ? ` for project ${args.project_name}` : ''}. Start with wxmp_doctor, call wxmp_open once, follow its nextActions without inventing context IDs, then use wxmp_evaluate, wxmp_list_scripts, wxmp_app_snapshot, wxmp_get_api_inventory, wxmp_correlate, and wxmp_export_evidence. Distinguish verified runtime facts from pending capabilities.`,
  },
  {
    name: 'wxmp-protocol-recovery',
    title: 'WMPF Protocol Recovery',
    description: 'Collect evidence for unknown WMPF envelopes before proposing clean-room decoders.',
    arguments: [{ name: 'session_id', description: 'Existing wxmp session identifier.' }],
    render: (args) => `Recover WMPF protocol behavior${args.session_id ? ` for session ${args.session_id}` : ''}. Read the session context graph and evidence manifest, correlate unknown envelope category/sequence/hash/artifact metadata with runtime actions, and do not infer protobuf fields without repeated evidence. Export evidence before reporting a decoder hypothesis.`,
  },
  {
    name: 'wxmp-static-runtime-correlation',
    title: 'Static and Runtime Correlation',
    description: 'Correlate wxapkg sources with live scripts, routes, requests, and page state.',
    arguments: [
      { name: 'session_id', description: 'Existing wxmp session identifier.' },
      { name: 'source_root', description: 'Optional restored wxapkg source root.' },
    ],
    render: (args) => `Correlate static wxapkg evidence with the live mini-program${args.session_id ? ` in session ${args.session_id}` : ''}${args.source_root ? ` using source root ${args.source_root}` : ''}. Use snapshot routes/AppID as join keys, then compare runtime scripts and requests with static search results. Record provenance and confidence for every correlation; do not equate matching numeric WMPF and CDP context IDs.`,
  },
];

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: promptArguments }) => ({
    name,
    title,
    description,
    arguments: promptArguments,
  }));
}

export function getPrompt(name: string, args: Record<string, string> = {}) {
  const prompt = PROMPTS.find((item) => item.name === name);
  if (!prompt) throw new WxmpError('PROMPT_NOT_FOUND', `Unknown prompt: ${name}`, { name });
  return {
    description: prompt.description,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(args) } }],
  };
}

export function listResources(app: WxmpApp) {
  const resources = [
    resource('wxmp://server/status', 'wxmp-server-status', 'Server, toolset, bridge, and cold-start status.'),
    resource('wxmp://session/active', 'wxmp-active-session', 'Most recent active session status, if any.'),
  ];
  for (const session of app.sessions.list()) {
    resources.push(resource(`wxmp://session/${encodeURIComponent(session.id)}/status`, `${session.id}-status`, 'Session lifecycle and capabilities.'));
    resources.push(resource(`wxmp://session/${encodeURIComponent(session.id)}/context-graph`, `${session.id}-context-graph`, 'WMPF logical and CDP execution context graph.'));
    resources.push(resource(`wxmp://session/${encodeURIComponent(session.id)}/evidence/manifest`, `${session.id}-evidence`, 'Current bounded evidence manifest summary.'));
  }
  return resources;
}

export function listResourceTemplates() {
  return [
    template('wxmp://session/{id}/status', 'wxmp-session-status', 'Session lifecycle and capability status.'),
    template('wxmp://session/{id}/context-graph', 'wxmp-context-graph', 'WMPF logical to CDP execution context graph.'),
    template('wxmp://session/{id}/evidence/manifest', 'wxmp-evidence-manifest', 'Bounded evidence counters and artifact root.'),
  ];
}

export async function readResource(app: WxmpApp, uri: string) {
  let value: unknown;
  if (uri === 'wxmp://server/status') {
    value = {
      name: 'wechat-miniapp-re-mcp',
      version: VERSION,
      toolset: app.config.toolset,
      sessions: app.sessions.list().length,
      bridge: app.sessions.bridge.info(),
      staticAdapter: app.staticAdapter.info(),
      startupRequiresTarget: false,
    };
  } else if (uri === 'wxmp://session/active') {
    const active = [...app.sessions.list()].reverse().find((session) => !['closed', 'failed'].includes(session.state));
    value = active ? app.sessions.publicStatus(active) : null;
  } else {
    const match = uri.match(/^wxmp:\/\/session\/([^/]+)\/(status|context-graph|evidence\/manifest)$/);
    if (!match) throw new WxmpError('RESOURCE_NOT_FOUND', `Unknown resource: ${uri}`, { uri });
    const sessionId = decodeURIComponent(match[1]);
    const session = app.sessions.get(sessionId);
    value = match[2] === 'status'
      ? app.sessions.publicStatus(session)
      : match[2] === 'context-graph'
        ? app.sessions.contextGraph(sessionId)
        : await session.evidence.status();
  }
  return { contents: [{ uri, mimeType: 'application/json', text: `${JSON.stringify(value, null, 2)}\n` }] };
}

function resource(uri: string, name: string, description: string) {
  return { uri, name, title: name, description, mimeType: 'application/json', annotations: { audience: ['assistant' as const], priority: 0.8 } };
}

function template(uriTemplate: string, name: string, description: string) {
  return { uriTemplate, name, title: name, description, mimeType: 'application/json', annotations: { audience: ['assistant' as const], priority: 0.8 } };
}
