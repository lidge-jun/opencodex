---
title: CLI Providers, Accounts, and Models
description: Provider configuration, credentials, quota, and model catalog commands.
---

These commands configure upstream providers, authenticate accounts, manage credential pools, and control the model catalog exposed to Codex.

## Providers

### `ocx provider <subcommand>`

Non-interactive provider management. Registry entries are seeded by name; a custom name requires
both `--adapter` and `--base-url`.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | List configured providers and the remaining registry entries. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Add a registry/custom provider. `--force` overwrites; `--sync` refreshes a running proxy in human-output mode. |
| `edit <name>` | provider field flags, `--json` | Edit validated live provider fields without replacing key pools. |
| `test <name>` | `--json` | Probe the real upstream model endpoint. |
| `show <name>` | `--json` | Show config with API keys masked. |
| `remove <name>` | `--json` | Remove a non-default provider; the last provider cannot be removed. |
| `set-default <name>` | `--json` | Select an existing provider as the default. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Read or update the provider model allowlist. |
| `quota` | `--refresh`, `--json` | Read provider quota reports. |
| `presets` | `--json` | List dashboard provider presets. |
| `account-mode` | `pool`, `direct`, `--json` | Select pooled or direct Codex account routing. |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

## Authentication

### `ocx login <provider>`

Start the provider's registered login flow. OAuth providers open a browser and store auto-refreshed
credentials under `~/.opencodex/`; API-key login providers open their key dashboard, prompt for the
key, validate it when possible, and save the resulting provider config. The command prints the
currently accepted OAuth and API-key provider ids when the name is missing or unknown.

Use the same command to **reauthenticate** after `ocx status` / `ocx doctor` reports
reauthentication required or a terminal refresh failure (or use Reauthenticate in the dashboard).
Codex pool accounts are not a public `ocx login` provider — reauthenticate via the dashboard Codex
account pool (Reauthenticate) or the headless `ocx account reauth` flow instead.

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

Remove the stored OAuth credential for a provider.

## Accounts and key pools

### `ocx account <subcommand>`

List and switch provider accounts and API-key pools through the running proxy. The shipped help
surface is:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Codex pool selection applies to the next request after clearing existing affinity; in-flight requests keep their captured account.
```

All subcommands require the proxy to be running; the CLI auto-resolves its recorded runtime port.
Successful operations exit 0. Invalid usage, an unknown provider or account/key id, an unreachable
proxy, or an API failure exits 1. Credential fields are displayed exactly as the management API
returns them (including its masking); raw API keys and OAuth tokens are never returned. Display
conveniences are synthesized client-side, same as the dashboard: `main` is the CLI alias for the
Codex App login in the `openai` account pool, OAuth accounts without an email appear as `Account N`,
and the plan/label column falls back across plan, masked email, label, and masked key.

`--json` account rows use this common shape (optional fields are omitted when unavailable):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

Without a provider, lists the Codex pool, OAuth accounts, and configured API-key pools. Empty
providers are skipped unless `--all` is present. With a provider, lists only that credential family.
Human output uses `PROVIDER TYPE ID PLAN/LABEL STATUS`; a manually chosen Codex row is marked
`selected`. When a stored Kiro account exists, the output notes that Kiro has one login slot and
that signing in again replaces the current account. An empty result is still success. `--json`
returns:

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

Shows the active account or key. A Codex pool with no manual pin reports automatic lowest-usage
selection; another family with no active credential reports that state and still exits 0. `--json`
returns:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

Selects an existing Codex account, OAuth account, or API key. For `openai`, `main` selects the Codex
App login. A Codex Pool selection clears process-local affinity and applies to the next request,
including one from an existing visible task; proxy restart or affinity eviction can also leave a task
unbound, while in-flight requests keep their captured account. This controls Pool routing only;
Direct mode keeps using the caller-owned/native main credential. Usage-based proactive switching,
401/403 reauthentication, 429/retry-after cooldowns, exclusion, and pre-output 429/402 failure
recovery may later select another eligible Pool account. Those recovery paths remain active when
usage-based switching is off. OpenCodex replays the conversation after an account change, but the
provider-side prompt cache may be cold. Unknown providers or ids exit 1.
On a **401/403**, App login clears that account's process-local affinity and requires reauthentication.
On a **429**, opencodex honors `Retry-After`, starts the account cooldown, clears affinity, and may
rotate the request to another eligible Pool account. These failure transitions remain active with
`autoSwitchThreshold: 0`; that setting disables only usage-based proactive switching.
`--json` returns:

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

For the Codex pool, use `ocx account refresh openai [--json]`. It force-refreshes account quotas and
prints available weekly/monthly percentages and reset times; missing quota data is reported as
unknown, not 0%. Its JSON envelope is `{ accounts: AccountRow[] }`, with `quota` on each Codex row.

For OAuth and API-key providers, this force-refreshes the provider quota-report endpoint; it is not a
token re-login or a plain account-list re-read. `--json` returns
`{ provider, report: ProviderQuotaReport | null }`. A provider with no supported quota report prints
`no quota report available for <provider>` and exits 0. Unknown providers and management-API
failures exit 1; an upstream quota probe that fails or times out degrades to a null or stale report
instead (exit 0), matching the dashboard's quota bars.

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Controls only the `openai` Codex account pool. `on` sets 80%, `off` sets 0%, `status` reads the current
value, and `threshold <n>` accepts an integer from 0 through 100. Other providers and invalid values
exit 1. `--json` returns:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account login|reauth|code|cancel ...`

Run browser-based or manual-code account authentication from a headless shell. Use
`ocx account --help` for the provider-specific command shape.

### `ocx account remove <provider> <id|main> --yes [--json]`

This guarded, non-interactive deletion requires `--yes`. Before deleting, it verifies that the id
exists; a missing id exits 1 without sending DELETE. The main Codex App login cannot be removed, so
`remove openai main --yes` is refused. After deletion, the family is read again: removing the pinned
Codex account clears the pin and returns to automatic selection; OAuth promotes the first remaining
account or reports none; API-key pools promote the first remaining key or report none. `--json`
success and failure shapes are:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

### `ocx account add-key <provider> [--label <label>] [--json]`

Adds and activates a key for an API-key provider. The key is read only from non-TTY piped/redirected
stdin; interactive TTY input, empty input, OAuth/Codex providers, and API failures exit 1. The key is
never echoed, including when it appears inside a label. Prefer a secret manager or a here-string:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` returns `{ ok: true, id: string | null, label?: string }` and never includes the key.

### `ocx account reset-credits <id|main> [--consume --yes]`

Inspect Codex reset credits for an account. Consuming a credit is destructive and requires both
`--consume` and `--yes`.

## Models

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` is an alias of `ocx models`. With no subcommand, list the models statically seeded in
configured providers. `--provider` filters one configured provider and `--json` returns model
metadata. `live` reads the running catalog; `add`, `edit`, `remove`, and `list-custom` manage manual
catalog entries; `enable`, `disable`, and `provider` control visibility; `selected` controls a
provider allowlist; `context` controls provider context caps; and `shadow` manages background
shadow-call interception.

Every per-model operation the dashboard offers is available here, so a headless install never needs
the GUI to manage a catalog. `add`, `remove`, and `list-custom` work against the config file and apply
to a running proxy through a catalog sync; the rest talk to the live management API and require the
proxy to be running (`ocx start`, or an installed service).

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` (default) | `--provider <name>`, `--json` | List models seeded in configured providers. |
| `live` | `--provider <name>`, `--json` | Read the running catalog, including models discovered at runtime. Rows are flagged `native`/`routed`, `custom`, and `enabled`/`disabled`. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | Register a model the provider catalog does not advertise. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Edit a custom model. `-` clears a field; `0` clears the context window. |
| `remove <custom-id\|provider/modelId>` | `--yes` | Delete a custom model. Requires `--yes` when stdin is not an interactive terminal. |
| `list-custom` | `--json` | Show all custom models with the `custom-id` the other subcommands take. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Make one model visible to Codex. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Hide one model from Codex. |
| `provider <name> <on\|off>` | `--json` | Enable or disable every model of one provider in a single write. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | Read or replace the provider model allowlist. `--clear` removes the allowlist so every model is offered. |
| `context <status\|value <tokens>\|provider <name> <on\|off>\|all <on\|off>>` | `--json` | Read or set the context-window cap, globally or per provider. |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Read or set the replacement model for Codex's background helper calls. `-` clears the model. `status` also reports `sourceModels`, the helper slugs the proxy intercepts (defaults: `gpt-5.4-mini` and `gpt-5.6-luna`). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

A model selector with a slash is routed (`anthropic/claude-opus-5`); a bare id is treated as a
native OpenAI model, so `--native` is only needed to force that reading for an id that would
otherwise look routed.

`--modalities` accepts only `text`, `image`, and `audio`. Codex parses that field as a closed enum
and rejects an entire catalog containing any other value, so `add`, `edit`, and the management API
all refuse the bad value rather than storing something the catalog writer would have to strip later
(#759).
