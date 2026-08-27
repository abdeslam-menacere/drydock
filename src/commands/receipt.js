import { isAgent } from '../lib/actor.js';

// Plain bold text, not an HTML comment: the GitHub MCP server strips HTML
// comments from PR bodies, which silently destroyed the marker CI gates on.
// `.github/workflows/drydock-gates.yml` must detect exactly this line.
export const RECEIPT_MARKER = '**drydock-receipt:v1**';

// The route the CLI claims this change earned. CI re-derives the route itself
// from the BASE branch's policy and checks `claimed ⊇ derived` — this line is
// read, never trusted. An absent line is treated as "claims every gate".
export const ROUTE_MARKER = '**drydock-route:v1**';

/**
 * The gate receipt that goes in the pull request body.
 *
 * Rendered in both profiles, from the same data, and read by CI in both. In
 * flow mode some rows are pending when the PR opens and the receipt is
 * rewritten as verdicts arrive — a pending row is simply one CI will not
 * accept, which is what moving the binding point to the PR means.
 */
export function renderReceipt(dock, route, head, { profile = 'dock' } = {}) {
  const verdicts = route.gates.map((n) => {
    const g = dock.gates[n];
    return { name: n, g, agent: isAgent(g?.by) };
  });

  const rows = verdicts.map(({ name, g, agent }) => {
    if (!g || g.verdict !== 'pass') {
      const state = !g ? '⏳ pending' : '❌ fail';
      return `| ${name} | ${state} | — | ${g ? `${agent ? '🤖' : '👤'} ${g.by}` : '—'} | ${g?.note || 'not recorded yet'} |`;
    }
    // A human-only gate is bound to what the preview was serving, not to
    // whatever HEAD happened to be. Those are the same commit at record time
    // — `gate` refuses otherwise — but the receipt has to say which question
    // was answered, because "someone looked at this running" and "someone read
    // this diff" are not the same evidence.
    const commit = `\`${g.sha.slice(0, 8)}\`${g.via === 'preview' ? ' (preview)' : ''}`;
    return `| ${name} | ✅ ${g.verdict} | ${commit} | ${agent ? '🤖' : '👤'} ${g.by} | ${g.note || '—'} |`;
  }).join('\n');

  // Who recorded a verdict changes what it is worth, so the receipt has to say
  // so at a glance. Kept out of the first three columns, which CI parses.
  const recorded = verdicts.filter((v) => v.g);
  const legend = recorded.length === 0
    ? 'No verdict recorded yet.'
    : recorded.some((v) => v.agent)
      ? '🤖 recorded by an agent · 👤 recorded by a human'
      : '👤 every verdict recorded by a human';
  const previewed = recorded.some((v) => v.g.via === 'preview');

  const out = [
    RECEIPT_MARKER,
    '',
    '### Drydock gate receipt',
    '',
    '| Gate | Verdict | Commit | By | Note |',
    '|---|---|---|---|---|',
    rows || '| — | — | — | — | no gates required |',
    '',
    legend,
    '',
    `${ROUTE_MARKER} \`${route.gates.join(',')}\``,
    '',
    `Route: ${route.reason}`,
  ];

  // Naming the exemption is what separates routing from a bypass: the record
  // says what was not run and which rule decided that. SPEC §11.2.
  if (route.exemption) {
    out.push(
      '',
      `Exemption used: \`${route.exemption.name}\` — matched the entire diff (${route.exemption.files.length} file${route.exemption.files.length === 1 ? '' : 's'}) against \`${route.exemption.paths.join('`, `')}\`.`,
    );
  }
  if (route.maxPath) out.push('', 'Routing failed closed: maximum path.');

  // The ceiling, stated separately from the floor. CI re-derives only the
  // deterministic route and checks the claim contains it, so these rows are
  // invisible to enforcement — which is exactly why they have to be visible
  // here. An addition nobody can see is an addition somebody can quietly drop.
  const sc = route.scored;
  if (sc?.state === 'fresh' && sc.add?.length) {
    out.push(
      '',
      `Added by the risk scorer${sc.model ? ` (\`${sc.model}\`)` : ''}:`,
      '',
      ...sc.add.map((a) => `- **${a.gate}** — \`${a.evidence.file}:${a.evidence.lines.join('-')}\` — ${a.why}`),
    );
  }
  if (sc?.unavailable) {
    out.push(
      '',
      `The risk scorer was unavailable (${sc.unavailable}), so this route is the deterministic one only.`,
      'That is a safe failure — the scorer can only ever add — but it means no',
      'judgement was applied beyond the path rules.',
    );
  }

  if (previewed) {
    out.push(
      '',
      '`(preview)` marks a verdict recorded against what a running preview was',
      'serving — someone looked at the feature, not at the diff. It binds to that',
      'commit and goes stale with it like any other gate.',
    );
  }

  if (profile === 'flow') {
    out.push(
      '',
      'Profile: **flow** — gates bind to this pull request, not to every commit.',
      'Nothing about that is a relaxation: each verdict still names the commit it',
      'examined, gates still run in order, and CI still refuses any gate whose SHA',
      'is not this PR head. Push again and every verdict above goes stale again.',
    );
  }

  out.push(
    '',
    `Head at land time: \`${head}\``,
    '',
    '<sub>Generated by Drydock. CI re-derives this route from the base branch and verifies these gates match the PR head SHA.</sub>',
  );

  return out.join('\n');
}
