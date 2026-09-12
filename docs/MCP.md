# Portable MCP setup

Drydock manages approved **definitions**, not a new MCP runtime. The original
root plugin remains skills-only. `integrations/catalog.json` is an inert,
distributed baseline for GitHub, Microsoft Learn, Azure and Playwright. Nothing
starts simply because you installed Drydock.

## Supported formats and client versions

The generated files use **Agent Plugins 1.0.0**: canonical `$schema` identifiers
on both `plugin.json` and `mcp.json`, fixed-location discovery of `mcp.json` and
`skills/`, and `stdio`/`streamable-http`/`sse` transports. There is no legacy
`mcpServers` manifest field. VS Code/native CLI `http`/`local` definitions are
normalized only when explicitly adopted. The root skills-only legacy plugin is
unchanged.

| Client | Documented version information | What it does not establish |
| --- | --- | --- |
| VS Code | 1.110 introduced experimental generic plugins. Current docs support portable plugins. | A verified numeric minimum for every canonical 1.0 feature is not published. |
| Copilot CLI | 1.0.74 introduced Open Plugin Spec v1 manifests and `mcp.json`. Current docs describe canonical Agent Plugins 1.0. | This milestone is not a verified minimum for all current canonical semantics. |
| Copilot app | Current docs describe plugins and automatically available CLI-configured MCP servers. | No numeric minimum version is published. |

The catalog records actual canonical minima as `null`, not invented version
numbers. Historical milestones are lower bounds, not a guarantee that a later
build loaded this plugin. Inspect the installed client and its actual loaded
tools; configuration cannot establish client compatibility or runtime readiness.
Setup refuses versions below known plugin milestones or an explicitly observed
unsupported client. With unpublished/unknown compatibility it can generate
configuration with a warning, so you can inspect and try loading it; it does
not claim client readiness. `doctor` requires a fresh scoped
`portablePlugins: true` observation before reporting MCP ready. A version
number above a milestone alone is never sufficient.

Sources: [canonical plugin authoring](https://github.com/github/docs/blob/main/content/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating.md),
[manifest schema](https://github.com/agentplugins/agent-plugins-spec/blob/main/schemas/1.0.0/plugin.schema.json),
[MCP schema](https://github.com/agentplugins/agent-plugins-spec/blob/main/schemas/1.0.0/mcp.schema.json),
[VS Code plugin documentation](https://github.com/microsoft/vscode-docs/blob/main/docs/agent-customization/agent-plugins.md),
[VS Code 1.110](https://github.com/microsoft/vscode-docs/blob/main/release-notes/v1_110.md),
[CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md),
[app customization](https://github.com/github/docs/blob/main/content/copilot/how-tos/github-copilot-app/customize-github-copilot-app.md).

### Client installation

**CLI:** after reviewing installation/trust permissions, run
`copilot plugin install ./.drydock/mcp-plugins/cli`. This installs
`drydock-workspace-cli` and caches its content; reinstall that variant after
generation changes.

**VS Code:** register only `.drydock/mcp-plugins/vscode` using the documented
`chat.pluginLocations` setting, then inspect/enable `drydock-workspace-vscode`
in the Plugins UI. Do not register the parent folder or another client's variant.
This is not the obsolete `chat.plugins.paths` setting. Drydock does not edit
user/global settings or answer Workspace Trust.

**App:** the documentation says CLI-configured MCP servers are automatically
available. Install the app variant with
`copilot plugin install ./.drydock/mcp-plugins/app`,
then inspect **Customize > MCP > Installed** in the app and confirm its actual
tools. Native app plugin installation uses **Customize > Plugins** and a
configured marketplace; no local-folder picker is assumed or automated.
Configuration sharing does not authorize copying authentication material.
CLI and app may share installed plugins: distinct manifest names prevent one
variant's installation from overwriting the other, but do not imply isolated
client activation. Activate only the intended variant in the current client
and inspect its tools; never enable both copies in one session. If the installed
clients cannot isolate activation, explicitly switch the active variant when
switching clients rather than claiming simultaneous independent registrations.

## Pinned packages, runtimes and sign-in

| Integration | Definition and prerequisites |
| --- | --- |
| GitHub | Hosted `https://api.githubcopilot.com/mcp/`; client-managed sign-in and repository/organization permission. Only issue read/write, comments and PR read tools are requested. Prefer a compatible existing/built-in connection. |
| Microsoft Learn | Hosted `https://learn.microsoft.com/api/mcp`; no service authentication. Client trust and tool permissions still apply. |
| Azure | `@azure/mcp@2.0.5`, Node LTS/npm/npx; Drydock's runtime floor is Node 20.12. `--read-only` plus only subscription/group-list tools, never all cloud management operations. Sign in using a user-authorized Azure identity; user-run `az login` is one supported route, not an automatic setup action. |
| Playwright | `@playwright/mcp@0.0.80`, Node 18+ upstream (20.12+ for Drydock), a supported browser; headless and isolated browser profile by default. This optional integration does not attach to your personal authenticated browser profile. |

**Upstream Playwright caveat:** MCP 0.0.80 is a non-prerelease package but
pins `playwright` and `playwright-core` to `1.63.0-alpha-2026-08-31`. Its entire
dependency tree is not stable. Several preceding MCP releases also depend on
alphas; downgrading merely pins an older alpha. Review that upstream constraint
before approving installation. Drydock does not silently replace dependencies.

Launchers use `npx --no`, so a missing package fails rather than automatically
approving installation. After separate explicit software-installation approval,
the user can populate the exact package's npm execution cache:

```text
npm exec --yes --package=@azure/mcp@2.0.5 -- azmcp --version
npm exec --yes --package=@playwright/mcp@0.0.80 -- playwright-mcp --version
```

These are **user-run installation commands**, not diagnostic probes run by
Drydock. A browser missing at runtime is reported from the active client's
package/connection status; install a supported browser using the vendor's
instructions. Read-only diagnostics cannot infer a usable browser from Node
being present.

Azure also publishes the **`Azure.Mcp` 2.0.5** .NET package. The vendor documents
`dnx` with .NET 10 Preview 6 or later; use **stable .NET 10**, not that historical
preview, if choosing this alternative:
`dnx Azure.Mcp@2.0.5 -- server start --read-only --tool azmcp_subscription_list --tool azmcp_group_list`.
Approve any package installation prompt yourself. This is an alternative
approved canonical `command: "dnx"` definition, not a second concurrent Azure
server. The npm default does not require a separate .NET installation.

Portable local commands default to the **plugin root**, not the active checkout.
`${workspaceFolder}` is not portable. Use explicit tool arguments for any
workspace paths and do not assume a copied/cached plugin runs in a dock.
No environment variables or credentials are copied between clients.

Sources: [GitHub remote headers](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md),
[Learn endpoint and authentication](https://github.com/MicrosoftDocs/mcp/blob/main/README.md),
[Azure stable 2.x source](https://github.com/microsoft/mcp/tree/024d316e913bc026bd08f4a34e34d07d2c568d00/servers/Azure.Mcp.Server),
[Playwright package/engines/dependencies](https://github.com/microsoft/playwright-mcp/blob/v0.0.80/package.json),
[Playwright launch options](https://github.com/microsoft/playwright-mcp/blob/v0.0.80/README.md),
[portable path and authentication boundaries](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md).

## Approval and first use

From the checkout you intend to configure:

```text
drydock mcp setup --client cli --client-version <version> --servers github,learn,azure,playwright
```

Review the integration decisions, changed file list, package pins in the
catalog, and prerequisite warnings. Only then repeat with `--apply`.
Approval covers the displayed configuration changes, **not** downloading
software, installing a plugin in a client, signing in, enabling tools, or
accepting trust prompts. Drydock never performs those actions for you.

Setup writes `.drydock/mcp.json`, the authoritative approved definition set,
and derives `.drydock/mcp-plugins/<client>/plugin.json`, `mcp.json`, and existing
Drydock skills. Each client has a distinct `drydock-workspace-<client>` manifest
name and its own `managed.json`, which records generated-file hashes so an upgrade cannot
silently overwrite hand edits. These are non-secret, versionable configuration,
not authentication or runtime state. Preview without `--apply` writes nothing.
These client directories are derived artifacts, not independently maintained
definition sets. Setup only writes the selected client's directory and the
single canonical registry; it never rewrites another client's registered files.

`--servers` adds named integrations from the shipped catalog to the approved
set; it does not remove previously approved servers. Subsequent setup can omit
`--servers`. To disable one, set its `enabled` to `false` in `.drydock/mcp.json`
and rerun setup with approval. Setup never turns that flag back on.
`tools.githubMcp=off` always excludes GitHub from generated MCP configuration,
even if it was previously approved. It does not silently change a client's own
built-in/global connection; agents must respect `off` independently.

Install **one** Drydock plugin copy in the target client. If the original
skills-only plugin is installed, disable/remove that copy before installing the
generated workspace plugin to avoid duplicate skills. Client trust and
authentication prompts remain visible and require your own decisions.

## Existing connections and migration

For VS Code, setup inspects the current checkout's `.vscode/mcp.json` (JSONC,
including comments/trailing commas). It preserves the file byte-for-byte:
unrelated definitions, credentials, input prompts, filters and intentional
overrides are not rewritten or copied. Matching endpoints or command/argument
pairs are reused even under another name. Disabled connections stay disabled.
Duplicate matches and same-name conflicts stop setup before any write.

For a connection declared elsewhere, supply `--existing <workspace-file>` with
a reviewed, non-secret configuration snapshot. This is an explicit declaration
of an existing connection, **not proof the active client loaded it**. Drydock
does not search global settings or other checkouts. For built-in GitHub, supply
a current-session observation with `source: "builtin"`, `configured: true`,
and `loaded: true`. Client name alone is not evidence of a built-in connection.
Reuse never implies that issue/comment tools or authorization are sufficient.
Approval records a `reuseIn` client choice on the canonical entry, so a later
setup without observations does not suddenly create a duplicate. This is a
configuration choice, not cached runtime evidence. If you remove that external
connection and want Drydock to generate it instead, remove the client's name
from `reuseIn`, then preview and approve setup again.

To adopt approved editor-specific definitions into the canonical set:

```text
drydock mcp setup --client cli --client-version <version> --import .vscode/mcp.json --servers learn
```

Review before adding `--apply`. Only the named definition is considered for
migration. The source remains unchanged. In VS Code an existing source
connection is reused instead of duplicated; in another client the canonical
definition generates that client's plugin. Do not also install the generated
server in a client's global configuration.

Migration fails rather than copying credentials or guessing how client
variables translate. Environment blocks, input references, arbitrary headers,
URL credentials/query strings, automatic approval, and client-specific tool
filters are not portable through this adapter. Keep such an existing connection
or configure its authentication/filter in the destination client yourself.
This validation applies on every import, even if the server was already
approved: filters (including an empty `tools` list) are rejected before
normalization. An explicit `disabled` value conflicting with the canonical
`enabled` flag is also rejected without writes; reconcile that flag explicitly
before retrying. Matching disable intent is preserved, and omitting `disabled`
on re-import never re-enables an already-disabled entry.
Allowed headers are GitHub's non-secret tool-selection/read-only headers only.
Never put tokens in commands, arguments, URLs, names, observations, or this
registry. Setup is not a secret manager and cannot identify every conceivable
secret encoded as ordinary text; review custom definitions before approval.

## Additional approved servers

No core code change is necessary. Add an entry to `.drydock/mcp.json`, or import
an approved definition using the same schema:

```json
{
  "version": 1,
  "servers": {
    "team-docs": {
      "enabled": true,
      "definition": { "type": "streamable-http", "url": "https://docs.example.com/mcp" },
      "requiredTools": ["search"]
    }
  }
}
```

Local definitions use `command` and `args`, with exact stable package versions
for supported package runners. The supported runner forms are deliberately narrow:

```text
npx [--no|-y|--yes|--offline] <npm-package>@<major.minor.patch> [server arguments]
dnx <NuGet-package>@<major.minor.patch> [-- server arguments]
```

The actual package position must contain one exact, non-prerelease version;
an unrelated argument ending in a version does not establish a pin. Windows
`.cmd`, `.exe`, `.bat`, and `.ps1` aliases, including case variants, undergo the
same checks. Prefer the bare executable name for cross-platform definitions.
`npx --package`/`-p`, `--call`/`-c`, multi-package selection (even all-pinned),
alternate package-manager wrappers such as `npm exec`/`pnpm dlx`, and `dotnet`
package-dispatch forms are rejected, not silently normalized or partially
validated. Use the supported single-package form or an explicitly installed
server executable instead. Validation never runs these commands.

No wildcard tool grant is emitted. Custom server
authentication is client-managed; no token/environment interpolation is
invented. `doctor --workflow custom --servers team-docs` checks `requiredTools`
and the corresponding observed authorization. Runtime detection only checks
executable presence and known runtime versions; it never executes a server as
a probe or installs a package.

## Readiness: five separate facts

Run this before issue-dependent work:

```text
drydock mcp doctor --client cli --client-version <version> --workflow issue
```

Configuration alone can establish only declaration. Loaded/enabled/trusted,
connected/authenticated, exposed tools, and authorization remain **unknown**
until observed in the active client. Even a successful read does not prove
write authorization. `doctor` makes no network requests and never tests access
by creating issues/comments, deploying resources, or mutating browser state.

The invoking agent may pipe the following non-secret observation shape to
`doctor --observations-stdin --session session-123`. This is Drydock's input
contract, **not** a claim that clients provide a standard observation API:

```json
{
  "client": "cli",
  "clientVersion": "<exact installed version>",
  "workspace": "<absolute current checkout>",
  "workflow": "issue",
  "session": "session-123",
  "portablePlugins": true,
  "observedAt": "<current ISO timestamp>",
  "servers": {
    "github": {
      "source": "builtin",
      "configured": true,
      "enabled": true,
      "trusted": true,
      "loaded": true,
      "connected": true,
      "authenticated": true,
      "tools": ["issue_read", "issue_write", "add_issue_comment"],
      "authorization": {
        "issue_read": "allowed",
        "issue_write": "unknown",
        "add_issue_comment": "unknown"
      }
    }
  }
}
```

Only use facts actually observed in that session. `"source"` is `builtin` or
`client`. Omit unknown booleans; authorization can be `allowed`, `denied`, or
`unknown`. For `issue_write`, `allowed` means the required create/update
operations in this repository, not merely a visible tool. Use authoritative
client permission information or already-observed legitimate operations; do
not invent write permission from a code read. If no supported observation is
available, leave it unknown and escalate under `require`.
`portablePlugins` reports observed canonical Agent Plugins 1.0 support in this
installed client, not merely that it has a generic Plugins menu. Omit it when
unverified. Public Learn and local Playwright do not require invented sign-in
observations, but their client trust, tool exposure and permissions still do.

The client/version, checkout, workflow and session must match the invocation;
observations expire after five minutes and are never stored. The agent must
normalize tool prefixes to canonical identifiers based on the actual inventory,
not invent tools. The output explicitly labels readiness as **agent-reported,
not independently verified**. Unknown authorization cannot produce ready.
Do not put raw errors, logs, tokens or free-form authentication data in stdin;
unknown fields are rejected without echoing their values.

Workflows: `issue` requires `issue_read`, `issue_write`, `add_issue_comment`;
`pull-request` requires `pull_request_read` (including permission for the
requested PR/status/check method); `docs` requires Learn search/fetch;
`browser` requires Playwright navigation/snapshot; `custom` uses the selected
entry's `requiredTools`. Optional Azure/browser/docs integrations do not block
unrelated issue work. Explicitly selecting an integration makes it relevant to
that diagnostic run **in addition to** the named workflow's mandatory
integrations. For example, `--workflow issue --servers learn` checks both GitHub
issue/comment capabilities and Learn; Learn cannot substitute for GitHub.
Use `--workflow custom --servers learn` for a Learn-only diagnostic.

## Policy and CLI transport

| Policy | Agent behavior | Standalone CLI |
| --- | --- | --- |
| `require` | Stop before dependent work for missing or unknown required capability. No alternate GitHub client. | GitHub-dependent commands refuse before their mutations: this process has no parent-client MCP transport. |
| `prefer` | Use authorized available MCP tools first; explain missing capability before fallback. | Reports its existing `gh` fallback explicitly. |
| `off` | Do not enable/use GitHub MCP. | Uses `gh`; setup omits GitHub MCP. |

An observation is evidence, not a transport. Even a successful doctor result
cannot authorize `gh` under `require`. Ask an MCP-capable agent to perform
supported GitHub operations; for CLI lifecycle actions that lack an MCP
transport, escalate to the policy owner. Do not hand-create a PR, fabricate a
receipt, or bypass gates. Read-only `drydock run` can still emit the agent
handoff prompt. Gate authority, SHA binding, route computation and ordering
are unchanged.

`doctor` exits nonzero when relevant MCP readiness is not established, except
that under `prefer`/`off` the allowed CLI fallback can cover GitHub alone
(reported, not tested). All additional integrations must still be ready; a
GitHub fallback never covers missing Learn/Azure/browser capabilities.
`mcpReady` remains false when using fallback; exit zero in that case does
**not** claim MCP readiness. Use `--json` for the structured result.

## Switching clients, worktrees, and upgrading

Commit only the reviewed non-secret canonical/generated assets. In a linked
worktree, run setup from that worktree: it uses `git --show-toplevel`, not
`git-common-dir`, and rejects paths/symlinks outside this checkout. It never
changes sibling sessions or global client files.

On switching clients, rerun setup for that client/version, supply evidence of
its existing/built-in connections, approve changes, and install/enable the local
plugin from `.drydock/mcp-plugins/<client>` in that client. Authenticate separately. Observations from the previous
client/session cannot be reused. The canonical set stays the authority; client
registration is not three independently maintained server lists.
Setting up CLI or app cannot rewrite the live folder registered by VS Code,
including when VS Code reuses an existing or disabled connection. Likewise,
upgrading one client's output leaves other client outputs byte-for-byte intact.
Rerun setup explicitly for each client when you want that client to pick up a
canonical definition or policy change; old client artifacts are not automatically
refreshed. Keep the active client's tools aligned with its current policy.

**Migrating the earlier shared output:** if `.drydock/mcp-plugin/plugin.json`
or `mcp.json` exists, setup refuses without writing anything. First unregister
or disable the shared `drydock-workspace` plugin in every client, then move the
reviewed `.drydock/mcp-plugin` folder to a backup location. Keep
`.drydock/mcp.json`. Preview/apply setup separately for each client and register
the exact new client folder/name above. Drydock cannot observe registrations
from files alone, so it neither deletes the old folder nor silently alters a
possibly live installation.

After a Drydock upgrade, preview setup again. Unmodified baseline definitions
advance to the new catalog pins; canonical overrides and disabled entries stay
as written. Generated-file hand edits cause a conflict instead of being
overwritten: move the intentional definition into the canonical set and
reconcile the generated file with its last approved version yourself. Repeated
approved setup with unchanged inputs writes nothing. Reload/update the installed
plugin using the client's supported controls; a cloned client plugin copy does
not update just because a workspace file changed.

## Troubleshooting

| Diagnostic | Supported corrective action |
| --- | --- |
| Missing configuration | Preview/setup approved definitions, then install the generated plugin in this client. |
| Disabled or untrusted | Review the existing disabled flag/client trust prompt; only the user enables or trusts it. |
| Not loaded | Install/enable the plugin and restart/reload the session; declaration is not loading. |
| Missing runtime or package | Install the pinned prerequisite explicitly; setup never downloads it. |
| Connection failure | Inspect client MCP status/logs locally; check endpoint, proxy and runtime. Never paste raw credentials/logs. |
| Authentication missing/expired | Sign in again through this client; never copy tokens across clients. |
| Insufficient authorization | Request the specific repository/cloud permission from its owner. |
| Missing/filtered toolsets | In CLI add only `issues`, `pull_requests`, or the specific `--add-github-mcp-tool`; then inspect inventory again. |
| Organization policy | Ask the administrator; do not bypass allowlists or permission restrictions. |
| Unsupported client/version | Use a documented supported version, not an inferred format or guessed minimum. |
| Unknown | Obtain a fresh, scoped current-session observation or stop under `require`. |

The optional observation `failure` field accepts these diagnostic identifiers:
`missing-configuration`, `disabled`, `untrusted`, `not-loaded`,
`missing-runtime`, `missing-package`, `connection-failure`, `authentication`,
`authorization`, `missing-toolsets`, `organization-policy`,
`unsupported-client`, `unknown`. A reported failure always prevents readiness.
