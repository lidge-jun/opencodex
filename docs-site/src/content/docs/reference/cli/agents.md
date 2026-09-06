---
title: CLI Agents, Routing, and Integrations
description: Multi-agent, combo, observability, access, integration, system, and config commands.
---

These commands control agent policy and routing, inspect the live proxy, and connect supported clients to opencodex.

## Agent policy

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Manage the headless multi-agent roster, effort caps, prompt injection, fallback, and sidecar settings.
Use `status` for the current policy. See [Sub-agent surfaces](/guides/sub-agent-surface/) for how
surface modes, delegation, effort, and fallback behavior fit together.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

`ocx agent sidecar web --list` and `ocx agent sidecar vision --list` print the models the
server currently offers for each sidecar — the exact filtered set the dashboard picker shows
(picker-visible rows plus the login-entitled Luna/Haiku auth slots, intersected with executor
availability for web search, minus provably text-only models for vision). Human-readable lists
show each model's backend in brackets. A web-search `--model` write resolves that server-offered
row and persists its backend and model together, so switching to an Anthropic option cannot keep
an OpenAI backend (or vice versa). Writes go to the same management route as the GUI and are
subject to the same per-sidecar gate: web search refuses a backend/model pair outside the listed
set (closed membership), while vision refuses only a model provably unable to see (unknown ids
stay writable).

```bash
ocx agent sidecar web --list
ocx agent sidecar web --model gpt-5.6-luna
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|keep-native-v1 <on|off>|threads <n>|mode-hint <text|--clear>>`

Manage the Codex `multi_agent_v2` feature flag and the three-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the global `multi_agent_v2` feature and resync the catalog. Rejected while the v2 hybrid pin is active because the global override would defeat it. |
| `off` | Disable the `multi_agent_v2` feature and resync the catalog. |
| `mode v1` | Force all models to v1, disable native v2, and preserve the active thread limit. |
| `mode default` | Respect upstream model surface pins. |
| `mode v2` | Force models to v2 and preserve the active thread limit. With `keep-native-v1` off, enable global native v2; with it on, disable the global override and use catalog pins. |
| `keep-native-v1 on\|off` | Under `mode v2`, keep ChatGPT-native models on v1 and routed models on v2. Enabling it disables the global V2 override before catalog sync. |
| `threads <n>` | Set the active v1/v2 thread limit to an integer of at least 1. |
| `mode-hint <text>` | Set the Proactive delegation hint (Ultra mode) for every model and effort. |
| `mode-hint --clear` | Remove the hint so the effort-derived policy (ultra = proactive) resumes. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
ocx v2 mode-hint "Proactive multi-agent delegation is active."
ocx v2 mode-hint --clear
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
Mode and flag transitions move the current numeric thread limit between the valid v1/v2 Codex keys;
a failed transition restores the original `config.toml`. Changes apply to new Codex sessions, while
running sessions keep their pinned surface.

Codex resolves an enabled global `multi_agent_v2` override before the selected model's catalog
pin. The hybrid `keep-native-v1` contract therefore keeps that global override off; otherwise a
native row stamped `v1` would still start on V2 and produce backend-encrypted child tasks.

`mode-hint` writes `features.multi_agent_v2.multi_agent_mode_hint_text` in Codex's
`$CODEX_HOME/config.toml` even when `multi_agent_v2` is currently disabled. The
command only persists the override; it does not enable or disable the feature, so
the hint takes effect when a matching Codex surface is active. The hint overrides
codex-rs's effort-derived multi-agent policy, so any model and any reasoning effort
receives the Proactive delegation prompt. It does **not** change reasoning effort
itself. A missing argument or a whitespace-only value is rejected; only `--clear`
removes the hint. The Subagents dashboard's Ultra mode **on** toggle has a stricter
gate: it requires the native feature to be enabled with an explicit v2 surface
(`ocx v2 mode v2`); `ocx v2 on` alone does not satisfy that dashboard gate.

## Combo routing

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

Manage combo failover and round-robin virtual models. `ocx route combo` is the hierarchical alias;
combo is currently the supported routing resource. Targets use
`provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` accepts `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias`, and
`--display-name <label|->` (`-` clears the label). A native alias captures only one currently supported,
unqualified bare OpenAI model id. Bare `gpt-5.6-*` native aliases use Codex Pool/Direct credentials.
Account-qualified OpenAI routes remain distinct, while provider-qualified routes such as
`openai-apikey/gpt-5.6-*` use their configured API key and never fall through to the native alias.
Read the safety and visibility contract in the guide before enabling the compatibility pair.

See [Combos](/guides/combos/) for routing behavior and configuration guidance.

## Observability and debug

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspect proxy requests, usage, storage, memory, and debug data. The direct aliases are:

| Alias | Equivalent resource |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

`--range today` (alias `1d`) reports the current local day. `--provider` and
`--model` narrow the report to one upstream target — distinct from
`--surface`, which selects the calling client (Codex, Claude Code, Grok)
rather than the provider serving the request.

The default view prints request, token and estimated-cost totals plus
per-provider and per-model breakdowns. Costs are API list-price equivalents,
not a billing receipt: subscription plans and provider credits are billed
separately, and requests with no matching price row are counted as
`unpriced`/`unmetered` rather than folded in as zero.

```bash
ocx usage --range today --provider xai
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Read or change runtime debug overrides through the running proxy's management API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

With no scope, `ocx debug` prints usage and, when the proxy is stopped, the next-start environment
defaults. Provider debug defaults from `OCX_DEBUG=1` (legacy `OCX_DEBUG_FRAMES=1` also works); usage
debug defaults from `OPENCODEX_USAGE_DEBUG=1`.

## API access

### `ocx access <key|endpoints|models|test> ...`

Manage OpenCodex admission API keys and inspect external endpoints and models. `ocx api-key
<list|create|remove> ...` is an alias of `ocx access key`.

```bash
ocx access key create deployment
```

## Client integrations

### `ocx integration <claude|grok> ...`

Manage supported Claude and Grok integrations. The direct command families below expose their
client-specific controls.

### `ocx claude [claude args...]`

Ensure the proxy is running, then launch Claude Code with `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and model slots from
`config.claudeCode`. Routed models appear in the native `/model` picker through stable slot aliases
with Claude Code 2.1.129 or newer. On older versions, select with `ANTHROPIC_MODEL` or `/model <id>`.
User-exported `ANTHROPIC_*` variables always take precedence.

Claude Desktop profile commands are:

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop status [--json]                 Show applied state, drift, and health
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

The families are `opus`, `fable`, `sonnet`, and `haiku`; new routes start in `opus`. `none` is valid
only when that family is empty. Legacy apply flags `--static`, `--hybrid`, and `--discovery-only`
remain supported. Use `ocx claude config <status|set> ...` for Claude Code settings.

### `ocx opencode [opencode args...]`

Ensure the proxy is running, then launch opencode with the generated `provider.opencodex` and
`providers.opencodex` blocks in OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). The
legacy block keeps V1 clients working; the V2 block is the one carrying the selectable
reasoning-effort variants. Existing inline config is preserved and only those two keys are replaced
for this launch. Global or project `opencode.json` files may be read to warn about an existing
override, but on-disk files are never modified. Routed models appear as
`opencodex/<provider>/<model>`. Launching plain `opencode` later behaves exactly as before.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Manage and apply the Grok Build model fence.

## Client config export

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast>`

Print a client config wired to the running proxy. The command serializes the
`opencodex` provider block — base URL, model list, and the client's credential
reference or loopback placeholder — in the selected client's native format.

The proxy must be running; the command resolves its live port, reads `/api/models`, and emits only
models Codex can currently see.

| Flag | Action |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast>` | Required. Selects the client config dialect. |
| `--json` | Print the generated document as JSON on stdout for scripts. This is JSON even when the selected client's native format is YAML, TOML, or JSON5. |
| `--out <path>` | Write the client's native config format to `<path>`. Refuses to replace an existing file. |
| `--force` | Allow `--out` to replace an existing file. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

Without `--json` the generated config leads, then the canonical destination path, the merge warning, the env
export line where the client has one, and a model count with how many rows omit context limits (the
client applies its own defaults for those).

| Client | Canonical destination | Download filename | Env var |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` wins when set) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR` wins when set; a relative value is refused) | `pi-models.json` | none — the block carries the literal `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml` (`OMP_PROFILE` wins over `PI_PROFILE`, even when empty; named profiles use the home-relative `PI_CONFIG_DIR` directory name and ignore `PI_CODING_AGENT_DIR`, while the default profile lets `PI_CODING_AGENT_DIR` win) | `omp-models.yaml` | none — loopback placeholder |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | none — loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |
| `dsh` | `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) | `settings.yaml` | none — non-secret loopback bearer placeholder |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, then the legacy `MAVIS_DATA_DIR`, win when set; a relative value is refused) | `mcode-config.yaml` | none — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR` wins when set; a relative value is refused) | `config.json` | none — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` wins when set; a relative value is refused) | `prime-models.json` | none — loopback placeholder |
| `aside` | `~/.aside/u/<account>/models.json` for the account Aside's own `accounts.json` names as current; an unreadable manifest is refused rather than defaulting to an account | `aside-models.json` | none — loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml` on macOS and Windows alike (Raycast does not honor `XDG_CONFIG_HOME`) | `raycast-providers.yaml` | none — loopback only, no `api_keys` entry is written |

The managed DSH export requires DSH 0.1.0-rc.6 or newer and owns only
`llm-pi-ai.providers.opencodex`. DSH hot reloads that provider; the user's default model and
`deepseek-official` remain untouched. This export is loopback-only and carries no real credential.

opencode interpolates `{env:OPENCODEX_OPENCODE_API_KEY}`. The generated Pi and OMP exports do
not require an environment variable: each carries the literal `opencodex-loopback` placeholder.
This is load-bearing because both clients resolve `apiKey` while building their model lists and
hide the whole provider when an existing config contains an unset env reference. The proxy never
checks the generated placeholder on loopback. OMP supports provider-level headers, but this initial
integration deliberately remains loopback-only; remote `x-opencodex-api-key` wiring is deferred.

The Raycast export is a standalone `providers.yaml` document with one `id: opencodex` element
in the `providers` sequence: `name: OpenCodex`, the proxy's `/v1` base URL, and every routed model
with its `abilities` (`tools` and `system_message` always supported, `vision` from the catalog's
input modalities, `reasoning_effort` when the model has an effort ladder, `temperature` off for
reasoning models). Custom Providers is a Raycast Pro feature, and Raycast watches the file, so a
saved change takes effect without a restart. The format is documented at
[manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers). No
`api_keys` entry is written, so this export is loopback-only and a non-loopback bind is refused.

The MCode, ZCode and Prime exports are loopback-only for the same reason and likewise carry the
`opencodex-loopback` placeholder rather than a real credential. Prime Agent reads the same
`models.json` contract Pi does, so the two exports produce the same document; only the destination
differs. A relative path in any of those three environment overrides is refused, because the proxy
and the client can have different working directories and would otherwise disagree about which
file is meant.

ZCode 3.8.1 may save runtime-derived `reasoning`, `limit.output`, and default context metadata back
into the generated `provider.opencodex.models` entries. Managed integration status treats only
those documented additions as refreshable drift. Provider identity and connection settings,
including `options.baseURL`, model membership, names, modalities, and any context limit OpenCodex
emitted authoritatively remain protected; editing them reports `conflict / foreign-edit` instead of
overwriting the file. An ownership record created by an older OpenCodex version can recover
automatically when the generated catalog is otherwise unchanged. If both the catalog and the block
changed, re-apply only after reviewing the file because the older record cannot prove which change
was ZCode-derived.

:::caution[Merge, never replace]
`ocx export` never writes your real client config. The destination is printed for you to merge by
hand, and `--out` refuses to overwrite an existing file without `--force`, because replacing a
config destroys the other providers, agents, and MCP entries already in it.
:::

No key is ever serialized. Configs carry either a documented environment reference or a
non-secret loopback placeholder. A loopback proxy (`127.0.0.1`, the default) requires no
admission key at all. Set a referenced variable only when the client schema supports it and
the proxy binds beyond loopback; see
[Remote access](/reference/configuration/#remote-access) for how admission keys are issued. Keys for
the upstream providers themselves are a separate thing entirely, configured per
[Providers](/guides/providers/).
Gajae is the exception: `OPENCODEX_GAJAE_API_KEY` fills its provider credential from the
environment, but its schema cannot send the remote admission header, so the generated Gajae
integration remains loopback-only.

The same payload is served by `GET /api/client-config` and rendered on the dashboard's API tab, so
the CLI, the API, and the GUI use the same bytes.

## Runtime and configuration

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Manage headless runtime settings, startup, sync, diagnostics, and updates.

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` updates OpenCodex itself. The separate Codex CLI inspection surface is:

```bash
ocx system codex-cli-update check --json
```

`check` makes no package-registry request and inspects bounded configured-candidate provenance evidence,
including a redacted executable location and ownership evidence. Trusted published-launcher context authenticates
the candidate snapshot, not successful Codex execution. Because this one-shot command never executes Codex,
environment and persisted candidates remain report-only (`managed: false`, normally `selection_unattested`);
`selectionAttested` remains `false`. The JSON report exposes `candidateAvailable`, `candidateVersion`, `candidateSource`,
and `selectionAttested`. Inspecting the configured candidate requires a trusted published-launcher context;
a direct Bun/source launch has no such proof, ignores ambient and persisted candidate state, and may report
`candidate_unavailable`. On Windows this first slice performs no candidate or configuration filesystem I/O:
only a proof-captured absolute environment candidate can receive lexical app-bundle or version-manager labels;
every other Windows candidate fails closed. The command does not execute Codex or a package manager, repair a shim,
write configuration or cache state, stop a process, or install anything. App-bundled, recognized
version-manager, unverified standalone, and ambiguous shim states are reported as unmanaged or unknown
and are never classified as managed.

### `ocx config <show|get|set|unset|validate|export|import> ...`

Inspect and safely modify validated OpenCodex configuration. `show` and `get` mask secrets. Import
validates before writing and requires `--yes`.
