/**
 * The CLI has a gh transport, not access to its parent agent's MCP connection.
 * An observation of that connection must never authorize a different transport.
 */
export function assertGhAllowed(cfg, operation) {
  if (cfg.tools?.githubMcp === 'require') {
    throw new Error(`GitHub MCP required for ${operation}; the standalone CLI cannot call the active client's MCP tools. No gh fallback was attempted. Use an MCP-capable agent for GitHub operations after drydock mcp doctor, or ask the policy owner to select prefer/off. Do not hand-write gate receipts or bypass drydock land.`);
  }
  if (cfg.tools?.githubMcp !== 'off') {
    console.error(`GitHub MCP prefer: ${operation} uses the CLI's gh fallback; parent-client MCP tools are not available to this process.`);
  }
}

export function githubPreflightText(cfg) {
  return `Before any GitHub-dependent work, inspect the active client's actual MCP
tool inventory and connection state, not just configuration. Run \`drydock mcp
doctor --client <vscode|cli|app> --client-version <version> --workflow issue\`.
Supply fresh current-session observations via --observations-stdin --session
<session-id> when available (see docs/MCP.md). Issue work requires issue_read,
issue_write, and add_issue_comment; repository/code tools alone are insufficient.
Check authorization for the actual repository/operation without test mutations.
Unknown, expired, disabled, untrusted, filtered or denied is NOT MCP readiness.
GitHub policy is ${cfg.tools?.githubMcp ?? 'prefer'}:
${cfg.tools?.githubMcp === 'require'
    ? 'STOP before dependent work if any required capability is unavailable or unobserved. Never fall back to gh. The standalone CLI has no MCP transport; its GitHub-dependent commands will refuse. Escalate, do not bypass gates or hand-create a receipt.'
    : cfg.tools?.githubMcp === 'off'
      ? 'Do not enable or use GitHub MCP. Use gh with the user-authorized identity.'
      : 'Use available authorized MCP tools first; explicitly explain a missing capability before using the documented gh fallback.'}
Client trust, sign-in, tool permissions and organization policy remain the user's
decisions. Never install software or grant consent as a readiness test. Optional
Learn, Azure and Playwright integrations do not block unrelated issue work.`;
}
