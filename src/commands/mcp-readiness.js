import path from 'node:path';

export const WORKFLOWS = {
  issue: { github: ['issue_read', 'issue_write', 'add_issue_comment'] },
  'pull-request': { github: ['pull_request_read'] },
  docs: { learn: ['microsoft_docs_search', 'microsoft_docs_fetch'] },
  browser: { playwright: ['browser_navigate', 'browser_snapshot'] },
};

const ACTIONS = {
  'missing-configuration': 'Run drydock mcp setup, review the plan, then approve with --apply and install the generated plugin in this client.',
  disabled: 'Enable the existing integration only with user approval; setup preserves disabled definitions.',
  untrusted: 'Review and approve the client trust prompt yourself.',
  'not-loaded': 'Install/enable the generated plugin in this client, then reload the session.',
  'missing-runtime': 'Install the documented runtime yourself, then restart this client.',
  'missing-package': 'Review the pinned package command in docs/MCP.md and approve installation yourself.',
  'connection-failure': 'Inspect the client MCP server status/logs locally; verify endpoint, proxy and runtime. Do not paste credentials or raw logs.',
  authentication: 'Sign in or renew authentication in this client; never copy tokens from another client.',
  authorization: 'Ask the repository/cloud owner for the specific permission; do not test access by making mutations.',
  'missing-toolsets': 'Expose only the required tools in this session. For Copilot CLI GitHub use --add-github-mcp-toolset issues or --add-github-mcp-tool <name>.',
  'organization-policy': 'Ask the organization administrator whether this integration and capability are permitted. Do not bypass policy.',
  'unsupported-client': 'Use a documented supported client version; see docs/MCP.md.',
  unknown: 'Inspect the active client and provide fresh scoped observations; configuration alone cannot prove runtime readiness.',
};

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);

/** A transient assertion by the invoking agent, never a cached readiness receipt. */
export function parseObservations(text, scope, now = Date.now()) {
  const invalid = () => { throw new Error('Invalid MCP observations. Use the non-secret, current-session schema in docs/MCP.md; no input values were logged.'); };
  if (Buffer.byteLength(text) > 128 * 1024) invalid();
  let value;
  try { value = JSON.parse(text); } catch { invalid(); }
  if (!object(value)) invalid();
  const keys = ['client', 'clientVersion', 'workspace', 'workflow', 'session', 'observedAt', 'servers', 'portablePlugins'];
  if (Object.keys(value).some((k) => !keys.includes(k))) invalid();
  if (!safeId(scope.session) || value.session !== scope.session
      || value.client !== scope.client || value.clientVersion !== scope.clientVersion
      || value.workflow !== scope.workflow || typeof value.workspace !== 'string'
      || path.resolve(value.workspace) !== path.resolve(scope.workspace)) invalid();
  const at = Date.parse(value.observedAt);
  if (!Number.isFinite(at) || now - at > 5 * 60 * 1000 || at > now + 5000) invalid();
  if (!object(value.servers)) invalid();
  if (value.portablePlugins !== undefined && typeof value.portablePlugins !== 'boolean') invalid();
  for (const [name, server] of Object.entries(value.servers)) {
    if (!safeId(name) || !object(server)) invalid();
    if (Object.keys(server).some((k) => !['source', 'configured', 'enabled', 'trusted', 'loaded', 'connected', 'authenticated', 'tools', 'authorization', 'failure'].includes(k))) invalid();
    if (!['builtin', 'client'].includes(server.source)) invalid();
    for (const key of ['configured', 'enabled', 'trusted', 'loaded', 'connected', 'authenticated']) {
      if (server[key] !== undefined && typeof server[key] !== 'boolean') invalid();
    }
    if (server.failure !== undefined && !Object.hasOwn(ACTIONS, server.failure)) invalid();
    if (server.tools !== undefined && (!Array.isArray(server.tools) || !server.tools.every(safeId))) invalid();
    if (server.authorization !== undefined && (!object(server.authorization)
      || Object.entries(server.authorization).some(([tool, status]) => !safeId(tool) || !['allowed', 'denied', 'unknown'].includes(status)))) invalid();
  }
  return value;
}

export function diagnose({ name, definition, observed, tools = [], prerequisites = [], supported = true, authenticationRequired = true }) {
  const findings = [];
  const add = (state, capability) => findings.push({ state, capability, action: ACTIONS[state] });
  const declared = !!definition || observed?.configured === true;
  if (supported === false) add('unsupported-client', 'portable configuration');
  else if (supported !== true) add('unknown', 'canonical Agent Plugins 1.0 support in this client/version');
  if (!declared) add('missing-configuration', 'server definition');
  if (definition?.enabled === false || observed?.enabled === false) add('disabled', 'enabled integration');
  for (const missing of prerequisites) {
    findings.push({ state: 'missing-runtime', capability: missing.name, action: missing.action });
  }
  if (observed?.failure) add(observed.failure, 'client connection');
  const states = [
    ['enabled', 'disabled'], ['trusted', 'untrusted'], ['loaded', 'not-loaded'],
    ['connected', 'connection-failure'],
    ...(authenticationRequired ? [['authenticated', 'authentication']] : []),
  ];
  for (const [key, failure] of states) {
    if (observed?.[key] !== true) add(observed?.[key] === false ? failure : 'unknown', key);
  }
  const missingTools = tools.filter((tool) => !observed?.tools?.includes(tool));
  if (missingTools.length) add('missing-toolsets', missingTools.join(', '));
  if (!tools.length && !observed?.tools?.length) add('unknown', 'tool inventory');
  for (const tool of tools.length ? tools : (observed?.tools ?? [])) {
    if (observed?.authorization?.[tool] !== 'allowed') {
      add(observed?.authorization?.[tool] === 'denied' ? 'authorization' : 'unknown', `authorization:${tool}`);
    }
  }
  return {
    integration: name,
    declared,
    loaded: observed?.loaded ?? 'unknown',
    connected: observed?.connected ?? 'unknown',
    authenticated: authenticationRequired ? observed?.authenticated ?? 'unknown' : 'not-required',
    exposedTools: observed?.tools ?? [],
    authorization: observed?.authorization ?? 'unknown',
    source: observed ? 'current-session agent observation (not independently verified)' : 'configuration only',
    ready: findings.length === 0,
    findings,
  };
}
