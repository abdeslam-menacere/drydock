/**
 * The setup interview, as data.
 *
 * Every question carries the `schemaVersion` that introduced it. A repo stores
 * the highest version it has been asked; when this file gains a question with a
 * higher version, `drydock config` asks that one and nothing else. Never
 * renumber an existing question — bump.
 *
 * `id` doubles as the dotted config path to write. Control questions steer the
 * interview rather than setting a value, and are marked `control: true`.
 */
export const QUESTIONS = [
  {
    id: 'preset',
    control: true,
    schemaVersion: 1,
    prompt: 'How much should Drydock do on its own?',
    default: 'full-autopilot',
    options: [
      { value: 'full-autopilot', label: 'Full autopilot — agents review, QA, land and merge; you read the trail' },
      { value: 'trust-but-verify', label: 'Trust but verify — agents do the work, a human approves the merge' },
      { value: 'manual', label: 'Manual — agents implement, every gate is yours' },
    ],
  },
  {
    id: 'customise',
    control: true,
    schemaVersion: 1,
    type: 'boolean',
    prompt: 'Customise the details? (most people say no)',
    default: false,
  },

  // --- Advanced. Only asked if the human opts in, or when newly introduced. ---
  {
    id: 'autonomy.level',
    schemaVersion: 1,
    advanced: true,
    prompt: 'Autonomy level',
    default: 'full',
    options: [
      { value: 'full', label: 'full — agents drive the whole loop' },
      { value: 'gated-merge', label: 'gated-merge — agents gate, a human merges' },
      { value: 'human-gates', label: 'human-gates — a human records every verdict' },
    ],
  },
  {
    id: 'autonomy.merge.enabled',
    schemaVersion: 1,
    advanced: true,
    type: 'boolean',
    prompt: 'Let Drydock arm auto-merge on the pull request?',
    default: true,
  },
  {
    id: 'autonomy.merge.method',
    schemaVersion: 1,
    advanced: true,
    prompt: 'Merge method',
    default: 'squash',
    options: [
      { value: 'squash', label: 'squash' },
      { value: 'merge', label: 'merge commit' },
      { value: 'rebase', label: 'rebase' },
    ],
  },
  {
    id: 'autonomy.merge.waitForChecks',
    schemaVersion: 1,
    advanced: true,
    type: 'boolean',
    prompt: 'Wait for CI to go green before merging? (turning this off removes your last backstop)',
    default: true,
  },
  {
    id: 'autonomy.retriesOnGateFail',
    schemaVersion: 1,
    advanced: true,
    type: 'number',
    prompt: 'How many times may a dock be re-spawned after a failed gate?',
    default: 2,
  },
  {
    id: 'escalation.bar',
    schemaVersion: 1,
    advanced: true,
    prompt: 'When should an agent stop and ask you?',
    default: 'any-ambiguity',
    options: [
      { value: 'any-ambiguity', label: 'any-ambiguity — anything the issue does not answer' },
      { value: 'irreversible-only', label: 'irreversible-only — only when a wrong guess is hard to undo' },
      { value: 'never', label: 'never — record the assumption and press on' },
    ],
  },
  {
    id: 'escalation.batchAtPlanTime',
    schemaVersion: 1,
    advanced: true,
    type: 'boolean',
    prompt: 'Batch all clarifications into one round before any code is written?',
    default: true,
  },
  {
    id: 'comments.verbosity',
    schemaVersion: 1,
    advanced: true,
    prompt: 'How much should Drydock narrate on the GitHub issue?',
    default: 'full',
    options: [
      { value: 'full', label: 'full — plan, assumptions, findings, test output, verdicts' },
      { value: 'milestones-findings', label: 'milestones-findings — checkpoints plus anything surprising' },
      { value: 'milestones', label: 'milestones — dock opened, gates, PR' },
      { value: 'off', label: 'off — say nothing' },
    ],
  },
  {
    id: 'tools.githubMcp',
    schemaVersion: 1,
    advanced: true,
    prompt: 'Use the GitHub MCP tools instead of shelling out to `gh`?',
    default: 'prefer',
    options: [
      { value: 'prefer', label: 'prefer — MCP first, fall back to gh' },
      { value: 'require', label: 'require — MCP only' },
      { value: 'off', label: 'off — gh only' },
    ],
  },
  {
    id: 'triggers.slashCommand',
    schemaVersion: 1,
    advanced: true,
    type: 'boolean',
    prompt: 'Enable the `/drydock <issue>` chat trigger?',
    default: true,
  },
  {
    id: 'triggers.cliRun',
    schemaVersion: 1,
    advanced: true,
    type: 'boolean',
    prompt: 'Enable the `drydock run <issue>` trigger?',
    default: true,
  },
];

/** What each preset writes. Keys are dotted config paths. */
export const PRESETS = {
  'full-autopilot': {
    'autonomy.level': 'full',
    'autonomy.merge.enabled': true,
    'autonomy.merge.waitForChecks': true,
    'autonomy.retriesOnGateFail': 2,
    'escalation.bar': 'any-ambiguity',
    'comments.verbosity': 'full',
    'tools.githubMcp': 'prefer',
  },
  'trust-but-verify': {
    'autonomy.level': 'gated-merge',
    'autonomy.merge.enabled': false,
    'autonomy.merge.waitForChecks': true,
    'autonomy.retriesOnGateFail': 1,
    'escalation.bar': 'any-ambiguity',
    'comments.verbosity': 'milestones-findings',
    'tools.githubMcp': 'prefer',
  },
  manual: {
    'autonomy.level': 'human-gates',
    'autonomy.merge.enabled': false,
    'autonomy.merge.waitForChecks': true,
    'autonomy.retriesOnGateFail': 0,
    'escalation.bar': 'any-ambiguity',
    'comments.verbosity': 'milestones',
    'tools.githubMcp': 'off',
  },
};

export const SCHEMA_VERSION = QUESTIONS.reduce((m, q) => Math.max(m, q.schemaVersion), 0);

export const questionById = (id) => QUESTIONS.find((q) => q.id === id) || null;
