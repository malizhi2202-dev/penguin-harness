---
title: Configuration Reference
description: Complete field reference for environment variables, Project config, Agent config, the Vault, and Schedules.
---

PenguinHarness configuration has three layers: environment variables shape the deployment, the Project config manages models and credentials, and the Agent config defines a single Agent's behavior. Above them sits an optional common configuration scope (`<root>/common/`) that is configured once and drawn on by every Project. Each Agent additionally has two kinds of state files: the Vault (private environment variables) and Schedules (timed tasks).

## Environment variables

The CLI and the server automatically load a `.env` file from the working directory on startup.

| Variable | Description | Default |
| --- | --- | --- |
| `PENGUIN_HOME` | Data root directory | `~/.penguin/data` |
| `PORT` | Web service listen port | `7364` |
| `HOST` | Web service listen address | `127.0.0.1` |
| `PENGUIN_WEB_DB` | Server SQLite database path | `<root>/web.db` |
| `PENGUIN_WEB_DIST` | Front-end static assets directory | the npm server package falls back to its bundled web-dist |
| `PENGUIN_PREVIEW_ORIGIN` | Origin that serves Workspace HTML previews, e.g. `https://preview.example.com` | unset — the loopback counterpart is derived per request |
| `PENGUIN_TRUST_PROXY` | `1` trusts the `x-forwarded-proto` header — set it behind a reverse proxy that terminates TLS (and sets/strips the header itself) so session cookies are marked `Secure` and the hot-update network gate sees HTTPS | unset — the header is ignored |
| `PENGUIN_SEED_ADMIN_PASSWORD` | Fixed initial password for the seeded built-in admin (automated tests / e2e) | unset — the seed generates a random password, hashed and discarded unseen; the account is claimed through the first-login link |
| `PENGUIN_LANG` | CLI language (`en` / `zh`), set via `penguin config lang` | `en` |
| `PENGUIN_UPDATE_CHECK` | `off` disables the web app's new-release check (the server's only outbound internet call); the account menu then has no "check for updates" row either | enabled |
| `PENGUIN_NO_LOGIN_SHELL_ENV` | Any non-empty value stops the desktop app from importing the login shell's environment on macOS/Linux GUI launches (see [Desktop quickstart](/quickstart-desktop)) | unset — the import runs, filling only variables the launch left unset |
| `PENGUIN_CLI_ENTRY` | The CLI entry script this installation offers the Agents it runs (see below) | set for you by `penguin server` / `penguin web` and by the desktop app; falls back to the checkout's own `packages/cli/dist/penguin.js` when the server was started from one |

These configure PenguinHarness itself, so `PORT`, `HOST`, `PENGUIN_WEB_DIST` and `PENGUIN_CLI_ENTRY` are **removed from the environment of commands the Agent runs** — otherwise a dev server started by `exec_command` would read `PORT` and try to bind the port meant for PenguinHarness instead of choosing its own. The rest of the host environment passes through, with one further exception: `GIT_EDITOR`, `GIT_TERMINAL_PROMPT`, `TERM`, `NO_COLOR`, `PAGER` and `GIT_PAGER` are always forced to fixed values, so that a command cannot hang waiting on an editor, a credential prompt or a pager. The Agent's [vault](#vault) is applied on top of the host environment — setting `PORT` there does reach commands — but not on top of those six.

One thing travels the other way: **this installation's own `penguin` is first on the PATH of every command an Agent runs**. At startup the server writes a launcher script at `<root>/bin/penguin` — it runs the CLI entry named above, on the server's own Node — and puts that directory at the front of PATH for each command. So `penguin` inside a command is the harness the Agent is running in, whatever version happens to be installed globally on the machine. The directory is prepended inside the shell as well as in the environment, because commands run through a login shell whose profile routinely rewrites PATH afterwards; that also puts it ahead of a `PATH` set in the [vault](#vault), which otherwise replaces the inherited value outright. The launcher is rewritten at every start, so a moved installation is picked up by the next one, and when there is no entry to point at none is written and `penguin` resolves however it did before.

`PENGUIN_PREVIEW_ORIGIN` must differ from the app's origin by **hostname**, not just port: cookies ignore ports, so a second port would still share the session cookie. Leave it unset for local use — the app is canonicalized onto `localhost` and previews are served from `127.0.0.1`, which needs no configuration and no DNS. Set it when the app is reached over a LAN address or a real domain; otherwise previews there fall back to a same-origin sandbox where `localStorage`, cookies and third-party embeds do not work. When you do set it on a real domain, keep the session cookie host-only (no `Domain=`), or a sibling subdomain shares it. An unparseable value is a startup error rather than a silent fallback.

### Provider credential variables

When a model entry has no inline `api_key`, AgentHub falls back to the provider's environment variable. A `*_BASE_URL` value is used only when the entry does not already inline `base_url`:

| Provider | API key | Base URL |
| --- | --- | --- |
| deepseek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| openai, openrouter, fireworks, siliconflow, tokendance, qwen-pay-as-you-go, qwen-token-plan, custom | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| minimax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` |
| google | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |
| zhipu | `ZAI_API_KEY` | `ZAI_BASE_URL` |
| moonshot | `MOONSHOT_API_KEY` | `MOONSHOT_BASE_URL` |

The openrouter, fireworks, siliconflow, tokendance, qwen-pay-as-you-go, qwen-token-plan, and custom groups speak the OpenAI-compatible protocol, hence the shared `OPENAI_*` variables. The direct MiniMax M3 Responses client uses `MINIMAX_*`; the built-in MiniMax preset already pins the official endpoint. Provider groups and the built-in model catalog are covered in [Models & Providers](/models).

## Project config

`<root>/<project>/.project_config.toml` is the Project's single config file: a hidden file written with mode 0600, with credentials inlined on the model entries. Model identity is always the `(provider, model_id)` pair — string concatenation is forbidden everywhere, and every reference into this file carries both halves: the provider is never inferred from a bare `model_id`.

| Field | Description |
| --- | --- |
| `name` | Project display name (the id is shown when unset) |
| `default_model` | Paired reference `{ provider, model_id }` to the default model; must point to an entry in `models` |
| `vision_model` | The vision model that reads images on behalf of text-only models (`read_file` hands images to it); a paired reference |
| `[command_policy]` | Sandbox command policy: deny rules for shell commands, applied ahead of the approval mode — see [Command policy](#command-policy) |
| `[[models]]` | The list of available model entries |

Model entry (`[[models]]`) fields:

| Field | Description |
| --- | --- |
| `provider` | Provider group; together with `model_id` forms the entry's unique key |
| `model_id` | Upstream request id, sent to AgentHub unchanged |
| `context_window` | Context window size |
| `client_type` | AgentHub client protocol; inferred from `model_id` by default — custom endpoints use a generic protocol client: `openai-responses`, `ant-messages`, or `openai-chat` (the Web dialog can detect which one a base URL serves; the pre-0.4.2 `openai` spelling is a deprecated alias of `openai-chat`, normalized on read) |
| `display_name` | Display name; persisted only when it differs from the built-in catalog |
| `vision` | Whether image input is supported; defaults to supported |
| `max_tokens` | Per-model max output tokens; overrides the Agent's `model.max_tokens` when set, omitted = inherit it |
| `fast_mode` | Per-model fast mode (premium faster serving tier); off by default, only `true` is persisted. Offered only for models whose AgentHub client can serve it; the others reject requests carrying it — see [Models](/models#fast-mode) |
| `pricing` | Three price buckets `cache_read` / `cache_write` / `output`, in USD per million Tokens (`unit = "usd_per_mtok"`) |
| `api_key` | Inline credential; when empty, falls back to the provider environment variable |
| `base_url` | Custom base URL; preset by the built-in catalog for gateways and direct MiniMax models |
| `created_at` | Write timestamp of `api_key` (ISO 8601; a display field maintained by the interface layer) |

```toml
default_model = { provider = "deepseek", model_id = "deepseek-v4-flash-vision-exp" }

[[models]]
provider = "deepseek"
model_id = "deepseek-v4-flash-vision-exp"
context_window = 1000000
vision = true
api_key = "sk-..."

[models.pricing]
unit = "usd_per_mtok"
cache_read = 0.005714
cache_write = 0.285714
output = 1.142857
```

`pricing.unit` is currently always `usd_per_mtok` (USD per million tokens); the three buckets map onto `token_usage`'s three counters.

Edit this file via the CLI (`penguin config model …`) or the Web Models page — never by hand while the service is running, and never by the model itself, which has no right to read or write it.

### Command policy

The `[command_policy]` block is the Project's sandbox guardrail for shell commands: a deny-rule list applied at the approval boundary itself to both tools that reach a shell — `exec_command`'s `cmd` (the launch) and `input_command`'s `chars` (what gets typed into an already-running one) — `Session.run` wraps the injected approval callback with it, so a hit is rejected before the host is asked, under every approval mode, allow-all included. The model receives the fixed line `Tool call denied by policy.` — distinct from a person's cancellation — and changes course. The policy also outranks a [pre-tool-use hook's](/agent-loop#pre-tool-use-hooks) `allow`: a vetoed call stays forbidden no matter what an installed hook answers. The policy lives in the Project config rather than in Agent State: an Agent editing its own configuration through its settings surface cannot reach it. It sits in the strict tier of runtime parameters: read once per model context, when the context opens — an edit reaches a running Session at its next rotation (compaction), and new conversations at once. It is not a filesystem permission — a tool that writes arbitrary paths can still rewrite the config file itself, and the rewrite takes effect at the next rotation: an accident guardrail, not a security boundary.

The rules are **plain data with no special tiers**: the factory set is seeded into each new project exactly like the model presets — copied in at creation, never rewritten afterward — and every rule can then be edited, disabled, deleted, or joined by new ones. A project from before the seeding (no `rules` list stored) behaves as the factory set until its first saved edit materializes the list; the settings page's "Restore defaults" loads the factory set back into the editor, and Save writes it.

| Field | Description |
| --- | --- |
| `enabled` | Master switch; absent = **on** (stored only as `enabled = false`) |
| `[[command_policy.rules]]` | The deny-rule list, matched in order: `name` (identifies the rule in the settings UI) + `pattern` (a JavaScript regex source, matched against the whitespace-normalized command) + optional `description` + per-rule `enabled` (absent = on). A stored empty list means no rules; an absent list means the factory set |

The factory set is deliberately small — commands whose verbatim execution is destructive with no undo: `rm` carrying both a recursive and a force flag, `mkfs`, `dd` writing straight to a block device, the classic fork bomb, and shell redirection onto a block device (`/dev/null` and friends stay legal). Four more are the Windows counterparts of the same five, since `exec_command` will resolve pwsh or cmd there: a recursive force delete (`Remove-Item -Recurse -Force`, `rd /s /q`), a volume format (`format C:`, `Format-Volume`), a raw disk overwrite (`\\.\PhysicalDriveN`, `Clear-Disk`), and the cmd fork bomb.

Matching normalizes ordinary spellings before the rules run, so plain typing does not slip through by accident: a leading path (`/bin/rm`), a wrapper (`sudo`, `env`, `command`, `nice`, `xargs`), quoting or a backslash escape of the command word (`"rm"`, `r''m`, `\rm`), and a literal `sh -c 'rm -rf /'` payload all match. Removing quote marks is all that happens — nothing is expanded, substituted, or decoded.

```toml
[command_policy]
enabled = true

[[command_policy.rules]]
name = "rm-recursive-force"
pattern = "…" # seeded from the factory set
description = "rm with recursive + force flags in one command (rm -rf and friends)"

[[command_policy.rules]]
name = "no-force-push"
pattern = "git push [^;|&]*--force"
enabled = false
```

This is an **accident guardrail, not a security boundary**, and that is a statement about what pattern matching can do rather than modesty about this implementation. Shell is a programming language; deciding what a program will do by reading its text before it runs is not a problem more rules get closer to solving. So the policy covers the spellings people and models actually type, and stops there:

- **A command computed at run time is not covered and will not be.** `$IFS` in place of spaces, a variable or alias (`X=rm; $X -rf /`), a command substitution, `eval`, base64 piped into a shell, `python -c`, an interpreter reached through a pipe. Each would take a pattern that costs maintenance forever and buys only the appearance of coverage. Anyone who wants the command to run can get it to run.
- **MCP tools are a different surface.** This policy reads `exec_command` and `input_command` only. An MCP server's own `permission` level is the knob that exists there, but read what it does before relying on it: it fixes the level its tools report to the approval mode and nothing else — it does not sandbox the server or restrict what its tools do when they run (see [Tools & Approval](/tools)). Extending a shell-text matcher into arbitrary MCP arguments would be a second, weaker control over a surface that needs a real one.
- **Commands not on the list.** `shred`, `wipefs`, `find -delete`, `git clean -xfd`, `chmod -R 000 /` match no factory rule — the list is deliberately small. Add your own rules for what your project cares about.

What it does buy is that a destructive one-liner does not run by accident, in either of the two ways a model reaches a shell, in either the POSIX or the Windows spelling, under any approval mode. That is a speed bump, and a speed bump is worth having in front of an irreversible command. For an actual boundary — a process that *cannot* reach the rest of the filesystem regardless of what it runs — the mechanism is confinement (bubblewrap, dsh), which is a separate layer this policy complements rather than replaces.

Manage it from the Security policy tab of Project Settings in the Web App (owner-only to edit; members see the effective policy).

## Common config

`<root>/common/` is this machine's **common configuration scope**: configure it once and every Project on the data root draws on it. Its path layout is the same as a Project's — the same loaders, the same file formats — but it is not a Project. It only reuses that layout:

| Path | Contents |
| --- | --- |
| `<root>/common/.project_config.toml` | The common Model table, with exactly the fields of a Project's [same-named file](#project-config) |
| `<root>/common/agents/<agentId>/agent_state/…` | A common Agent template — an ordinary Agent State directory |
| `<root>/common/plugins.toml` | The common default plugin set: `default_plugins = ["goal", "…"]` |

`common` is a reserved id: it never appears in the Project list, cannot be created, renamed or deleted, and no Session can be started inside it — the Agents there are templates to copy, not Agents to run. In the Web App it is not in the Project switcher (it is not a Project) and is never the app's current scope: an administrator opens **System settings → Global config** (a group of its own below the server's, administrators only) and the scope's three surfaces are right there — Plugin Library, Models, Agents: those very Project pages, opened by the settings page with the common config as their scope, while the sidebar and the switcher stay in the Project you were in. Leaving the group needs no switching back.

The scope's Agent list starts with a `default_agent` (General Agent): the first read of the scope on a data root initializes it from the built-in preset, the same way creating a Project does (preinstalled library plugins included), so it can be edited in place or left as one template among several. It is a template — it never updates itself, and no Project's General Agent is copied into it. Apart from that, **with no `common/` directory nothing changes at all**: the directory appears only once the scope is genuinely read, and a new Project still starts from the built-in presets.

The three things it holds inherit by three different rules, and that difference is the point of the scope:

**Models are copied.** A new Project is seeded with the whole common table copied over — credentials included, so the Project is usable the moment it appears (and a common scope with no models still falls back to the built-in presets). Models added to the common side later are pulled into an existing Project with the models page's "Import from common". Copied means copied: the two sides are independent from then on, editing either leaves the other alone, and an import only appends — an entry the Project already carries under the same `(provider, model_id)` pair is never overwritten.

**Agent templates are copied.** Creating an Agent from a common template copies that Agent's *behavior* — `system_config.yaml`, `AGENTS.md`, `skills/`, `hooks/`, `tools/` — while `.vault.toml` (credentials), `memory/` (its own memory) and `schedule/` (its timed work) stay behind: secrets, personal memory and timed work are not behavior. The copy has no link back to the template afterwards, so editing either side is free. A `name` / `description` given at creation overrides the template's; without one the new Agent keeps its own id — the template names itself, not its copies.

**The default plugin set applies when nothing was chosen.** The names in `plugins.toml` are installed on a newly created Agent whose creator **selected no plugins** (installed in the file's order). An explicit empty list means "no plugins for this one" and does not apply them; an Agent imported from a snapshot carries its own skills and hooks and does not apply them either; and an Agent created from a template is already fully described by that template, so the default set is not layered on top. A missing file means "no defaults", which is exactly what creating a plain new Agent did before.

Only an administrator can read or write the scope through the ordinary Project routes; for a member, `/api/projects/common/…` answers 404 just like a Project they have no access to. Two reads stay open to members: `GET /api/common/plugins` (the default plugin set) and `GET /api/common/agent-templates` (the template list the create dialog offers). Models and Agent templates have no dedicated routes of their own — they are the ordinary Project routes with the reserved id.

A data root that predates this scope can already carry a Project whose id is `common` (creation refuses the id from this release on), and that Project's directory is the very one the scope uses. The collision leaves that Project untouched — its owner and members keep using it, with Sessions, rename and delete all as before — and simply disables the scope for as long as it lasts: the related reads and writes answer 409 `common_scope_conflict`, and the Web App offers no common-config entry. To enable the scope, delete that Project, or — when its data has to be kept — stop the server, change the `project_id` of its row in `web.db`'s `projects` table and rename `<root>/common` to match, then start again.

The CLI's `--project-id` takes the reserved id too: `penguin config model add … --project-id common` edits the common Model table (the CLI works directly on this machine's data root, with the same authority as editing that file by hand).

## Agent config

`agent_state/system_config.yaml` defines a single Agent's behavior (YAML; comments are preserved when edited via the Web UI):

| Field | Default | Description |
| --- | --- | --- |
| `name` | — | Agent display name (falls back to the id) |
| `description` | — | Agent description |
| `version` | `1` | Agent State version (a natural number), incremented on each successful optimization |
| `kernel_version` | current kernel version | Config kernel version (a date string): which generation of the built-in defaults this config is based on, stamped at creation, restore-defaults and kernel update; unrelated to `version`, never changed by user edits; missing = predates the mechanism (i.e. outdated) |
| `system_prompt` | built-in template | Required; the only template with placeholder substitution |
| `max_turns` | `-1` | Maximum LLM turns per Task (`-1` = unlimited; a positive integer caps the Task) |
| `model.max_tokens` | `32000` | Output Token ceiling per Request (-1 = no cap, provider default); each request clamps the effective value to the model's `context_window` minus the estimated input, so a small-window model never gets asked for more than fits |
| `model.thinking_level` | `medium` | `none` / `low` / `medium` / `high` / `xhigh` / `max`; the level each model context opens at unless the Session pins one — fixed for the context, so a change lands at the next compaction |
| `model.timeoutMs` | `300000` | **Idle** budget for a Request (milliseconds): the longest wait for the next upstream event, reset by every event — not a cap on the request's total duration. It bounds the connect + first-event wait and the gaps between events; a model that keeps its reasoning off the wire spends its whole thinking phase inside that first gap, which is what the default leaves room for |
| `compaction.max_context_length` | `256000` | Context Token threshold that triggers compaction; the effective threshold is the smaller of this and the model's `context_window` − 2048, so a small-window model compacts inside its window while a window above 258048 fires at this number (an entry with no `context_window` assumes a 128000 window) |
| `compaction.max_session_turns` | `-1` | Cumulative Session turn threshold (`-1` = unlimited) |
| `compaction.mode` | `summarize` | `summarize` / `discard` |
| `compaction.prompt` | built-in template | Prompt used for summarize compaction |

The four `compaction.*` fields are the one part of this file a running conversation does not have to wait for: the engine re-reads the section at every compaction checkpoint (after each request reports its token usage, and on a manual `/compact`), so a saved change applies to Sessions already running. Everything else here is read when a model context opens and lands at the next compaction. The Web App can also change the threshold straight from the context panel — drag the dashed cutter on its bar.
| `memory.enabled` | `true` | Whether Memory enters the context and Memory directories are prepared |
| `memory.prompt` | built-in template | Always-injected half of the `{{MEMORY}}` block, editable on the Memory tab — carries `{{USER_MEMORY_INDEX}}` |
| `memory.workspace_prompt` | built-in template | Appended only in a persistent Workspace, editable on the Memory tab — carries `{{WORKSPACE_MEMORY_INDEX}}` and `{{WORKSPACE_MEMORY_DIR}}` |
| `vault.enabled` | `true` | Whether the vault section enters the context (with it off, values are still injected into subprocess environments — the model just doesn't see the key-name list) |
| `vault.prompt` | built-in template | The `{{VAULT}}` block, editable on the Vault tab — carries `{{VAULT_KEYS}}` |
| `skills.enabled` | `true` | Whether the skills section enters the context (with it off, installed skills remain explicitly invocable via `[use_skills]`) |
| `skills.prompt` | built-in template | The `{{SKILLS}}` block, editable on the Skills tab — carries `{{SKILL_METADATA}}` |
| `schedules.enabled` | `true` | Whether the scheduled-tasks section enters the context (with it off, the server still fires tasks — the model just isn't taught the task system) |
| `schedules.prompt` | built-in template | The `{{SCHEDULES}}` block, editable on the Schedules tab — teaches the model file-based task management, carries `{{SCHEDULE_LIST}}` |
| `tools.builtin` | full default toolset when omitted | Tool entries: `name` / `description` / `parameters` / `permission` (`r` or `rw`) / `forModel` / `timeoutMs` / `maxOutputLength` / `call_description` (per-tool toggle for the `description` call argument, required while on; missing = kept); once written it replaces the default list wholesale |
| `tools.mcpServers` | `[]` | MCP Server configuration (`name` + `config`): transport is `stdio` / `http` / `sse`, and discovered tools join the toolset as `mcp__<server>__<tool>`; `config.permission` (`auto` / `r` / `rw`, default `auto`) fixes the approval level of every tool of that Server instead of trusting its `readOnlyHint`; see the MCP Servers section of [Tools & Approval](/tools) |

Tool permissions and approval semantics are covered in [Tools & Approval](/tools).

A partial-override example (edit the file the init step generated). Note that this file is **not deep-merged with the defaults**: a key you write out takes effect wholesale, and only omitted keys fall back to the defaults above at their use sites; `system_prompt` is required (loading refuses without it), so keep the full generated template when editing other fields:

```yaml
name: default_agent
description: General-purpose agent
version: 3

# Required: keep the full generated default template ({{AGENTS_MD}} and friends; elided here).
system_prompt: |
  …

# -1 (the default) = unlimited; set a positive integer to cap the turns of a single Task.
max_turns: -1

model:
  max_tokens: 32000
  thinking_level: medium
  timeoutMs: 300000

compaction:
  max_context_length: 256000
  max_session_turns: -1
  mode: summarize

# Omitting the whole tools section = the full default toolset. Writing tools.builtin
# REPLACES the default list wholesale: carry the complete definition (including the
# parameters JSON Schema) for every tool you keep — see Tools & Approval.
```

An existing Agent always runs with its on-disk config verbatim — newer code defaults are never merged in automatically. When the built-in defaults change substantively, the config's `kernel_version` falls behind the current kernel and the settings page and agents list show an update hint. Two paths adopt the current defaults (side by side on the settings overview):

- **Update kernel**: a lossless merge, **one settings tab at a time** (System Prompt, Runtime, Tools, Skills, Memory, Vault, Schedules). A tab the config lacks entirely, or one still hashing to a *recorded* generation's built-in default, is rewritten from the current defaults — that wholesale rewrite is also how tools added by a later version reach an existing Agent. A tab you have changed in any way stays unchanged **in full** and is listed in the result: edit one built-in tool and the entire Tools tab is kept, so tools you added and tools you deleted both survive, and the rest of that tab stops following new defaults until you restore defaults. `name`, `description`, `version` and `tools.mcpServers` belong to no tab and are never touched. The config is then stamped with the current `kernel_version`. Matching is **conservative**: only a tab whose hash hits a recorded generation counts as an old default — a tab from a generation too old to be recorded is kept as if customized.
- **Restore default configuration**: like a skill update, overwrites the existing configuration with the current defaults — custom system prompt, tool list, model/compaction settings and MCP Servers — keeping only `name`, `description` and `version`. The full-refresh fallback when the kernel update's conservative matching leaves fields behind.

For developers: `kernel_version` advances manually, and only on a substantive change to the built-in defaults (using that day's date). The pinned-hash test in CI (`core/test/kernel-version.test.ts`) recomputes every tab hash against `KERNEL_DEFAULT_TAB_HASHES` in `kernel-history.ts` and fails on drift, naming each tab that moved and the edit it needs: bump `KERNEL_VERSION`, append the tab's previous hash to `KERNEL_SUPERSEDED_TAB_HASHES`, and write the recomputed hash in. Several changes on the same day may reuse that day's version. The superseded hashes are frozen forever — they are what identifies "still the old default".

### System prompt placeholders

`system_prompt` is the only template with placeholder substitution. Available placeholders:

| Placeholder | Injected content |
| --- | --- |
| `{{AGENTS_MD}}` | Full text of `AGENTS.md` |
| `{{VAULT}}` | The rendered `vault.prompt` block (the vault section); empty when `vault.enabled` is off. A template without it injects no vault section — the Vault tab offers inserting/migrating it explicitly |
| `{{SKILLS}}` | The rendered `skills.prompt` block (the skills section); empty when `skills.enabled` is off. A template without it injects no skills section — the Skills tab offers inserting/migrating it explicitly |
| `{{MEMORY}}` | The rendered `memory.prompt` block, plus `memory.workspace_prompt` in a persistent Workspace; empty when Memory is off. A template without it injects no Memory — the Memory tab offers inserting it explicitly |
| `{{SCHEDULES}}` | The rendered `schedules.prompt` block (the scheduled-tasks section); empty when `schedules.enabled` is off. A template without it injects no schedules section — the Schedules tab offers inserting it explicitly |
| `{{VAULT_KEYS}}` | Inside `vault.prompt`: the Vault key-name list (names only, one `- KEY` line per key). For legacy templates, an occurrence directly in the template body is still substituted, honoring `vault.enabled` the same way |
| `{{SKILL_METADATA}}` | Inside `skills.prompt`: the installed Skills' metadata lines. For legacy templates, an occurrence directly in the template body is still substituted, honoring `skills.enabled` the same way |
| `{{SCHEDULE_LIST}}` | Inside `schedules.prompt`: the current task-name list (one `- name` line per task; an empty-roster note when none exist) |
| `{{USER_MEMORY_INDEX}}` | Inside the Memory prompts: content of the user scope's `MEMORY.md` index (at most 200 lines and 25,000 characters total) |
| `{{WORKSPACE_MEMORY_INDEX}}` | Inside `memory.workspace_prompt` only: content of the Workspace scope's `MEMORY.md` index (at most 200 lines and 25,000 characters total) |
| `{{WORKSPACE_MEMORY_DIR}}` | Inside `memory.workspace_prompt` only: absolute path of the current Workspace's Memory directory |
| `{{PLATFORM}}` | Runtime platform |
| `{{OS_VERSION}}` | Operating system version |
| `{{DATE}}` | Current date |
| `{{PROJECT_DIR}}` | App Data Dir: the PenguinHarness app data root (the Project directory) |
| `{{AGENT_ID}}` | Agent id |
| `{{CWD}}` | Workspace path |
| `{{PROVIDER}}` | Model provider group |
| `{{MODEL_ID}}` | Upstream model id |
| `{{SESSION_ID}}` | Session id |

`{{PROJECT_DIR}}` is surfaced to the model as the **App Data Dir**: PenguinHarness's application data root, holding every Agent's data files (`agents/<agent_id>/…`) and the project-level data — deliberately not described as a project or task directory, so the model does not mistake it for the task's working directory (`CWD`).

On Windows, `{{PROJECT_DIR}}` and `{{CWD}}` are injected with forward slashes — like every other path core composes for the model (attachment lines, the goal-file line, truncated-output recovery paths). The model re-emits these spellings into JSON tool arguments and shell commands; forward slashes are accepted by Node's fs APIs and the package's (Git) Bash tool shell, and avoid JSON backslash-escaping mistakes.

`agent_state/AGENTS.md` is the developer-editable instruction file, injected via `{{AGENTS_MD}}` and empty by default — it is also the file an optimizer edits most (see [Self-Improvement](/self-improvement)). Like the rest of the Agent State — `system_config.yaml` included — it is read whenever a model context opens: at Session creation and again when a compaction opens the next context. An edit therefore takes effect at the next compaction of a running Session, not only in new Sessions, and never inside the context that is running (the `compaction` section is the exception — see [Compaction](/agent-loop)).

The Vault / Skills / Memory / Schedules sections all follow the same placeholder + toggle + editable prompt pattern: the template holds only the `{{VAULT}}` / `{{SKILLS}}` / `{{MEMORY}}` / `{{SCHEDULES}}` placeholders, the section text lives in the corresponding `*.prompt` config (edited on its settings tab), and turning `*.enabled` off empties the whole block. The four section placeholders are expanded **last, in a single pass** at assembly time: expansion products are never rescanned, so placeholder-looking text inside a memory index or a section prompt stays literal instead of triggering a second substitution.

**Legacy templates**: `system_config.yaml` is materialized at Agent creation and never auto-upgraded, so an Agent created before this mechanism carries hardcoded `# Vault` / `# Skills` section text with inline `{{VAULT_KEYS}}` / `{{SKILL_METADATA}}` in its template. Such templates keep working: the inline placeholders are still substituted, and now honor the new toggles (an off switch substitutes an empty string). The matching tab reports the legacy template and offers one-click migration — replacing the old default section verbatim, in place, with the new placeholder, leaving the assembled prompt unchanged; a template whose section text was customized doesn't match the verbatim migration and is treated as missing the placeholder instead, with a one-click insert (before `# Environment`).

## Memory

`agent_state/memory/` is what the Agent remembers between Sessions: user feedback, project decisions, working conventions and entry points into external systems — the things that cannot be re-derived from the Workspace or its code history. It is not context compaction, which preserves one Session's short-term state.

Memory has two scopes, both belonging to one Agent and never shared with another:

- **User scope** (`memory/user/`) — what stays true wherever the Agent works: who the user is, their standing preferences, reference material not tied to one codebase. Every Session reads it, including one running in a temporary Workspace, which has no other place to write.
- **Workspace scope** (`memory/<workspace_memory_key>/`) — facts about one Workspace. Sessions of one Agent in one Workspace share it; different Workspaces keep their topic files apart.

Each scope carries its own `MEMORY.md` index, and different Agents never share Memory even in the same Workspace. Because Memory lives in Agent State it travels with export / import and snapshots, and every Project member who can reach the Agent can read it — so credentials and sensitive personal data never belong in it.

```text
agent_state/memory/
├── user/                         # user scope (no marker: it stands for no path)
│   ├── MEMORY.md                 # this scope's index
│   └── prefers-pnpm.md
└── my-app-a81f32c4/              # one Workspace
    ├── .workspace                # the Workspace path this key stands for
    ├── MEMORY.md
    └── testing-conventions.md
```

`user` is a reserved directory name, safe because every generated workspace memory key is `<base>-<8 hex>` and therefore always carries a hyphen — a hyphen-free name can never be produced.

The workspace memory key is `<safe-basename>-<8 hex of the real path's sha256>`. Identity is the directory itself and has nothing to do with Git: two symlinks to one directory resolve to one key, while moving or renaming a directory makes it a new Workspace (the old Memory stays on disk under the old key). A temporary Workspace — one PenguinHarness allocated under `agents/<agent_id>/workspaces/` — gets no Workspace scope at all, a subagent inheriting one included: a temporary Workspace is allocated per Session, so no later Session would ever run there to read it back. Such a Session still gets the user scope, which is where anything it learns belongs anyway.

A topic file is a semantic subject, not one per Task, Session or date, and carries frontmatter:

```markdown
---
name: testing-conventions
description: the project's test environment and verification rules
updated_at: 2026-08-07
---

- Integration tests connect to a real database; no mock repositories.
```

These three fields are all the frontmatter there is — which layer a memory belongs to is expressed by its directory, so there is no `type` field (a `type:` line left in an earlier file is ignored as an unknown field). Worth saving: who the user is (role, expertise, standing preferences) and how they want the Agent to work, with the why; decisions, constraints and plans not derivable from the code; stable entry points into external systems, documents and services. The prompt also names the moments that produce such a fact — a request made a second time, a correction that holds beyond the current task, a habit or development practice stated more than once, or a reusable working detail handed over that the Agent would otherwise ask for again. A repeat is a strong signal rather than a condition, so one clear statement of a standing preference is enough; when the Agent cannot tell whether something is worth keeping, it asks in the conversation. A topic that turns out to be wrong is deleted together with its index line, and dates are written absolute (`YYYY-MM-DD`) — relative ones mean nothing to a later Session. What must never be saved: facts the code, config or Git history already states; short-lived task progress and debugging notes; credentials, tokens or secrets; unconfirmed guesses; long transcript excerpts.

Each `MEMORY.md` lists its scope's memories one line each — `- [Title](file.md) — hook`, links relative to the scope directory — and is updated in the same round as the file, so the two never disagree.

Only the indexes reach the context, through the template's `{{MEMORY}}` placeholder. It expands to `memory.prompt` — what Memory is for, the save mechanics, then a `## User memory` section with its index (`{{USER_MEMORY_INDEX}}`) — plus `memory.workspace_prompt`, a `## Workspace memory` section with `{{WORKSPACE_MEMORY_INDEX}}`, when the Session runs in a persistent Workspace. Both prompts are per-Agent config, editable on the settings page's Memory tab, and organized by Markdown headings like the template's other sections. The `User Memory Dir` line is the literal pattern `<app_data_dir>/agents/<agent_id>/agent_state/memory/user`, resolvable from the Environment section; the `Workspace Memory Dir` line renders resolved via `{{WORKSPACE_MEMORY_DIR}}`, because its final segment — the workspace memory key — is a path hash the model could never compose itself.

A blank index injects an explicit "nothing saved yet" note. Injection is capped at 200 lines per scope (one memory per line by convention), then at 25,000 characters total as a backstop for indexes whose few lines are enormous — past a cap a truncation note tells the model to open the full `MEMORY.md` itself, and the file on disk is never touched. The default Memory prompt declares the line cap and asks for index lines under ~150 characters, so the model keeps the index short before ever hitting the caps; the character backstop lives only in code. Topic bodies are read on demand by the model.

The two halves are separate config keys because substitution has no conditionals: a temporary Workspace must never be handed the Workspace section (its directory line and the scope-choice rule), so that half is simply not appended there. The Harness only decides where Memory lives and keeps writes inside it — deciding what is worth keeping, splitting topics and maintaining the indexes is the model's job, done with the ordinary file tools.

A template without `{{MEMORY}}` injects no Memory — an Agent created before Memory shipped, for instance. The Memory tab reports this and offers inserting the placeholder (before `# Environment`, the position the default template gives it) as an explicit one-click action; nothing is ever spliced in automatically. The assembled prompt is recorded in `session_meta`.

To read, delete or ask the Agent to edit what it has saved, use the settings page's [Memory tab](/web-app#agent-settings-agents).

## Vault

`agent_state/.vault.toml` is the Agent-level environment-variable vault: a hidden file written with mode 0600.

- Key names must match `^[A-Za-z_][A-Za-z0-9_]*$` (shell environment variable naming rules);
- Values are injected only into tool subprocess environments and never enter the model context or the Trace;
- Only key names are disclosed in the system prompt: the template's `{{VAULT}}` placeholder expands to `vault.prompt` (carrying the `{{VAULT_KEYS}}` key-name list), editable on the Vault tab; with `vault.enabled` off the block is empty — values are still injected into subprocesses, the model just doesn't see the key-name list. A legacy template's inline `{{VAULT_KEYS}}` is still substituted under the same toggle, and the tab offers one-click migration (see "System prompt placeholders");
- Saving through the Web/API invalidates the Agent's cached Session runtimes: the next Task on any of its Sessions re-resumes and runs with the new values; a Task already in flight keeps the values it started with (a direct CLI file edit reaches a running server only when a Session is next created or resumed);
- Managed via `penguin config vault set/list/remove` or the Web Vault tab.

## Schedules

Each file `agent_state/schedule/<name>.toml` describes one scheduled task (the filename is its identity) that sends a preset Prompt to the Agent on a cadence. Schedules execute only while the Web service (the server runtime) is running, and are managed in the Web Agent settings → Schedule tab.

| Field | Required | Description |
| --- | --- | --- |
| `prompt` | yes | The Prompt sent on each trigger |
| `enabled` | no | Enabled switch; defaults to `false` |
| `start_at` | yes | First trigger time (ISO 8601) |
| `period` | no | Cadence such as `30m` / `12h` / `7d`, minimum 5 minutes; omitted means a one-shot task |
| `end_at` | no | End time; must be later than `start_at` |
| `session_id` | no | Bind to an existing Session; mutually exclusive with the three fields below |
| `workspace` | no | Workspace for new-Session mode |
| `provider` / `model_id` | no | Paired model reference for new-Session mode; write both or neither — a lone `model_id` is rejected, and with neither the Project's default model is used |

```toml
prompt = "Check yesterday's builds and summarize the failures"
enabled = true
start_at = 2026-08-01T09:00:00Z
period = "12h"
```

The template's `{{SCHEDULES}}` placeholder expands to `schedules.prompt`: it teaches the model to manage these TOML files with its own file tools (the directory, the field rules, the ~30-second automatic pickup, and the hygiene rules against duplicates), ending with the current task-name list via `{{SCHEDULE_LIST}}`. The prompt is editable on the Schedules tab; with `schedules.enabled` off the block is empty — the server still fires tasks on schedule, the model just isn't taught the task system. An Agent created before this mechanism has no such placeholder in its template; the tab offers one-click insertion.

## Project alignment timers

A Project may declare `timers.toml` in its own directory (`<projectDir>/timers.toml`). Each `[[timer]]` entry periodically aligns the Project's local repositories with their upstreams, checks the documentation against the code, and optionally hands what it found to an Agent. Like Schedules, timers execute only while the Web service is running, and are managed in the right dock's 对齐定时器 panel — the file is hand-editable, and the panel is a view onto it.

The repositories a timer passes over are the ones the Project's Workspaces sit in — exactly the set the Git panel shows. There is no repository list to configure: a Project cannot be pointed at a checkout it never used.

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Identity within the file; lowercase id |
| `enabled` | no | Enabled switch; defaults to `false` |
| `start_at` | yes | First trigger time (ISO 8601) |
| `period` | no | Cadence such as `30m` / `12h` / `7d`, minimum 5 minutes; omitted means a one-shot |
| `end_at` | no | End time; must be later than `start_at` |
| `sync` | no | `none` / `fetch` / `fast-forward` / `merge`; defaults to `fetch` |
| `commit` | no | `off` / `auto`; defaults to `off` |
| `docs` | no | Run the documentation / commit / code drift checks; defaults to `true` |
| `agent_prompt` | no | When set, a run that finds something needing attention sends this Prompt plus the report to a Session |
| `session_id` | no | Bind that hand-off to an existing Session; mutually exclusive with the three fields below |
| `workspace` / `provider` / `model_id` | no | New-Session hand-off target (the Project's built-in Agent unless `workspace` says otherwise) |

```toml
[[timer]]
name = "git-align"
enabled = true
start_at = 2026-08-01T09:00:00Z
period = "1h"
sync = "fast-forward"
commit = "auto"
agent_prompt = "Fix the documentation drift this report describes."
```

One run does three things, in this order. It commits the work tree if `commit = "auto"` (the message is generated from the diff, and says so in a trailer). It fetches, then brings the branch up to date by fast-forward, or by merge when `sync = "merge"`. Finally it reports drift: code that changed while no document did, documents that changed while no code did, a changed document whose relative link or code-span path points at nothing (reported as `file:line`), and local commits that have not landed upstream.

The rails are the point of the feature, so they are worth stating plainly. It never force-pushes, never rebases and never rewrites history. A conflicting merge is aborted and reported, leaving the work tree byte-for-byte as it was, rather than leaving a half-merged checkout for someone else to find. A repository with an unfinished git operation (merge, rebase, cherry-pick, revert) is skipped, not "cleaned up". Repositories are walked one at a time, because two passes over one index would race. A due time that has already passed when the server first sees a timer is consumed, never replayed — a restart does not fire yesterday's alignment. A slot is consumed whether or not the pass succeeds, so a failure is reported rather than retried in a loop. `commit = "auto"` is opt-in, a manual run can be a dry run, and the checks themselves are deterministic: no model is consulted, so the same tree always yields the same report.

Known limits, so they are not discovered the hard way. Nothing here talks to a hosting platform: there is no pull-request, review or CI awareness, and "commits that have not landed" (local commits ahead of the upstream) is the local stand-in for a PR's state. The drift checks are pattern-based, not semantic — a document whose meaning quietly stopped matching the code is not detected. And a hand-off is skipped when the bound Session is busy; the next run reports the same findings.

## Design principle

An Agent's behavior lives entirely in editable files on disk — prompts, Skills, and configuration are data, not code. That is what makes Agents improvable by Agents: an optimizer edits exactly the same files you edit by hand. See [Self-Improvement](/self-improvement) and the [CLI Reference](/cli).
