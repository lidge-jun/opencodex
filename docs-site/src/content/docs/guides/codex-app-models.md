---
title: Codex App model picker
description: How opencodex models appear in Codex App, Codex CLI, and Codex TUI through the shared Codex catalog.
---

opencodex does not patch Codex App. It writes the same Codex configuration and model catalog that
Codex CLI/TUI use. The app-server reads that shared state, but some Codex Desktop releases apply a
second remote model allowlist in the renderer and can still remove routed rows from the picker.

OpenAI entries use two credential routes: native Codex login and the namespaced
`openai-apikey/<model>` API-key transport. Changing `codexAccountMode` between Pool and Direct by
itself does not change picker ids. When account-qualified picker rows are enabled by
`codexAccountPickerEnabled` and `codexAccountNamespaces` has eligible selectors whose
mapped accounts still exist, however,
opencodex adds separate `<selector>/<native-openai-model>` rows for the mapped accounts and hides
the bare native rows from the Codex picker. Selector labels are user-chosen public names with no
built-in account-role meaning. Selecting a qualified row uses only its mapped account, does not
change the active Pool account, and fails closed instead of switching accounts when the target is
unavailable. If Codex's account-scoped catalog contains a visible, API-supported OpenAI-family id
that is not yet in opencodex's static set, the exact id is preserved as a selector-qualified row
for eligible main-account selectors; it is not copied to an unrelated account and is not added to
the bare or API-key model list. The row is matched on the field shape a real catalog row has,
which filters malformed entries — it does not prove the id came from an upstream response, since
the cache is a user-owned file. See [Exact Codex account selectors](/reference/configuration/routing/#exact-codex-account-selectors).

`gpt-daybreak-blue-latest` is account-gated. opencodex checks each authenticated ChatGPT account's
own Codex model roster before advertising or routing it. In Pool mode, the bare row exists only when
at least one eligible Pool account reports the slug. In Direct mode, the bare row follows the main
account used by the local catalog, and each request also checks the forwarded caller credential (or
the stored main credential when an OpenCodex admission bearer is substituted). A
`<selector>/gpt-daybreak-blue-latest` row exists only when that selector's mapped account reports it.
Pool routing excludes unentitled accounts. If no roster can be confirmed, the gated row fails closed
instead of spending a prompt on an upstream 400.

A separate, explicit `customModels` entry can expose the same wire id as
`openai/gpt-daybreak-blue-latest` through the canonical Codex-login forward provider:

```json
{
  "customModels": [
    {
      "id": "daybreak-codex-forward",
      "provider": "openai",
      "modelId": "gpt-daybreak-blue-latest"
    }
  ]
}
```

Only that exact provider, endpoint, and model id receive the pinned Sol capability snapshot:
922,000 context, 829,800 automatic compaction, the native reasoning ladder, and native Codex tool
metadata. The request still sends `gpt-daybreak-blue-latest`; opencodex does not rewrite it to Sol
or grant account entitlement. The separately billed
`openai-apikey/daybreak-blue-latest` API row is a different route and its 1,050,000 / 922,000 limits
are never copied into the Codex-login row.

When the `codexAccountNamespaces` map is empty, account-qualified picker rows are off. If
`codexAccountPickerEnabled` is omitted with a non-empty map, they are treated as enabled for
backward compatibility. Set it to `false` to hide generated qualified rows and restore bare native
rows in the picker without deleting mappings or disabling exact
`<selector>/<native-openai-model>` routing.

API GPT-5.6 and Daybreak entries use
1,050,000 context / 922,000 max input, and `*-pro` picker ids resolve to the base wire model with
`reasoning.mode: "pro"` while logs, usage, and picker state keep the virtual id.
The API catalog is fixed to exactly ten ids: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, their three Pro
virtual ids, `daybreak-red-latest`, and `daybreak-blue-latest`; there is no generic
`gpt-5.6-pro` alias.
Compact requests keep the selected tier but send the base model without a reasoning object.

Select the credential route represented by the picker id. Change Pool/Direct on the Providers page;
`<selector>` below is a user-chosen public label mapped through `codexAccountNamespaces`:

```text
gpt-5.6-sol                         # bare Codex-login route via Pool or Direct
<selector>/gpt-5.6-sol              # stored Codex account mapped by that selector
openai-apikey/gpt-5.6-sol           # API key
openai/gpt-daybreak-blue-latest     # explicit Codex-forward custom row (922,000)
<selector>/gpt-daybreak-blue-latest # account-qualified native id, only when that account reports it
openai-apikey/daybreak-blue-latest  # separate API-key route (1,050,000 / 922,000)
```

Fresh installs and configs with no saved mode default to Pool. Current configs use marker 2 and
retain the shipped v1 source at `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restore it with:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Earlier v1 three-provider configurations migrate automatically into the single option-aware row.

## Desktop remote-allowlist limitation

If `codex debug models` and app-server `model/list` contain a routed model but Desktop does not show
it, check the upstream [Codex issue #19694](https://github.com/openai/codex/issues/19694). With the
remote `use_hidden_models` policy active, Desktop can keep only ids in its native
`available_models` list and can also display native rows whose catalog visibility is `hide`.
Catalog refreshes and proxy restarts alone cannot change that renderer policy.

For an equivalent routed model, opencodex provides an explicit, default-off native-alias combo mode.
It publishes an allowlisted bare slug with an honest custom display label and routes that exact slug
through the configured combo before canonical OpenAI routing. It also omits disabled bare native
rows from the effective catalog while compatibility aliases exist, so Desktop cannot resurrect
them by ignoring `visibility`. See [Codex Desktop native-allowlist compatibility](/guides/combos/#codex-desktop-native-allowlist-compatibility)
for the command, disable-key semantics, and safety constraints.

## Integration path

`ocx init`, `ocx start`, and `ocx sync` wire the shared Codex config and catalog into the proxy; see
[Codex Integration](/guides/codex-integration/) for config injection, catalog sync, shims, WebSocket
fallback, and restore mechanics.

## Native quota fallback limitation

When the Codex app exhausts its native five-hour quota it can switch to a reserve
fallback model and grey out the other rows in its picker. Reported in
[#2813](https://github.com/lidge-jun/opencodex/issues/2813), that gating also hides routed
opencodex rows, even though those use unrelated provider credentials and consume none of the
ChatGPT quota.

This gate is applied by the client before a request reaches the proxy, so opencodex cannot lift
it. Routed rows are written with `visibility: "list"`, catalog filtering consults only
`disabledModels` and each provider's `selectedModels`, and no quota value takes part in routed
visibility.

Selecting a routed model explicitly does not go through the picker. Set the model in
`config.toml`:

```toml
model = "anthropic/claude-sonnet-5"
```

or send it directly:

```bash
ocx access test anthropic/claude-sonnet-5 --protocol responses
```

Both paths route correctly **once the request reaches the proxy** — that part is covered by
tests. What is not established is whether the app still sends the configured model while reserve
mode is active; if the client rewrites or refuses it before the request leaves, no proxy-side
setting changes that. Treat the explicit-selection route as worth trying rather than a confirmed
workaround.

## Why routed models show up

Codex's model picker expects Codex-shaped catalog entries. opencodex builds routed entries by cloning
a native Codex model template, then replacing the routed model identity:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

The clone keeps strict-parser fields such as reasoning levels, shell type, API support flags, and
base instructions. opencodex then removes native-only capabilities that the route cannot honor,
including OpenAI service-tier metadata.

## Current stable model coverage

The native fallback set includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, and GPT-5.6 Sol/Terra/Luna. For the GPT-5.5/5.4 family, opencodex preserves
the installed Codex catalog's richer live entries and only synthesizes a missing entry. The bundled
upstream snapshot is used only for GPT-5.6, where it supplies the real per-model identity and
metadata instead of an older-template approximation.

| Route | Picker ids and catalog metadata |
| --- | --- |
| Codex login (account-qualified rows disabled) | Bare native ids such as `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; Pool or Direct is selected through `codexAccountMode`. GPT-5.6 rows use a 922,000-token catalog window. |
| Codex login (account-qualified rows enabled with eligible selectors) | One `<selector>/<native-openai-model>` row per eligible selector and supported native model; each row uses only its mapped account, and bare native rows are hidden from the picker. Native metadata and context windows are preserved. |
| Codex login (explicit Daybreak forward row) | `openai/gpt-daybreak-blue-latest` only when the exact `customModels` row is configured on the canonical `openai` provider. It keeps the Daybreak wire id and uses the pinned Sol capability snapshot (922,000 context; 829,800 automatic compaction). |
| OpenAI (API key) | Exactly ten namespaced rows: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, the three `*-pro` virtual ids, and the two Daybreak aliases (1,050,000 context; 922,000 max input for all ten) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (922,000) |
| Cursor | Static fallback includes `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, and `cursor/gpt-5.6-luna` (1,000,000), plus regular/Fast rows for Grok 4.5 and 4.6 (500,000); 4.6 adds `xhigh`, and live account discovery decides which rows remain visible. |
| xAI | Live discovery is authoritative. The fallback catalog includes `xai/grok-4.6` and defaults to `xai/grok-4.5`; both have 500,000-token windows. Grok 4.6 exposes `low` / `medium` / `high` / `xhigh` (upstream default: `high`), while Grok 4.5 stops at `high`. |

The pinned GPT-5.6 entries preserve the exact upstream ladder. Sol and Terra expose `low` through
`ultra`; Luna stops at `max`. Sol defaults to `low`, while Terra and Luna default to `medium`.
The explicit Codex-forward Daybreak Blue row inherits Sol's ladder and default without changing its
wire identity.
`ultra` is a client-facing choice for maximum reasoning plus proactive delegation and reaches the
backend as `max`. A picker entry only means the catalog is ready: the connected account or API key
must still be entitled to use that model.

## Native and routed model toggles

The dashboard Models page exposes `disabledModels` toggles for bare native ids and routed
`provider/model` ids. Account-qualified `<selector>/<native-openai-model>` ids are also supported by
`disabledModels`, but the dashboard does not list or toggle those exact selector rows; add them to
the configuration manually:

- Routed ids are namespaced (`provider/model`). Disabling one excludes it from the synced catalog
  and `/v1/models`.
- Account-qualified native ids use `<selector>/<native-openai-model>`. Adding one to
  `disabledModels` hides only that selector row.
- Native GPT ids are bare slugs. Disabling one keeps its catalog entry but changes `visibility` to
  `hide`, preserving the exact entry for a later re-enable; it hides the bare row and every
  selector-qualified clone for that model from discovery.
- With at least one native-alias combo configured, disabled bare native rows are omitted rather than
  retained hidden because affected Desktop releases ignore the hidden flag. A bare native slug
  shadowed by a native alias is also omitted from the Models page, so it has no native switch there;
  only unshadowed native rows remain switchable. Sync restores pristine native metadata when an
  unshadowed disabled row is re-enabled.
- Unshadowed native rows come from the supported static set, so a disabled unshadowed model stays
  visible in the dashboard and can be turned back on.

The visibility pass runs after snapshot upgrades, and the management API refreshes the catalog and
forces Codex's model cache stale after a toggle.

## Multi-agent surface mode

The Models-page v1/base/v2 control changes which Codex collaboration surface each picker entry uses;
see [Sub-agent Surface](/guides/sub-agent-surface/) for the canonical mode, delegation, inheritance,
fallback, and encrypted-task behavior.

## Reasoning top tiers

Reasoning-tier visibility is independent of the v1/base/v2 surface mode. Generated reasoning-capable
entries advertise `max` so direct sub-agent effort overrides validate; current generated routed
entries and older native GPT entries also advertise `ultra`. Exact upstream GPT-5.6 ladders are
preserved, so Luna has `max` but no `ultra`.

On the wire, routed adapters map or clamp unsupported tiers. For older native models whose real
ladder stops at `xhigh`, `nativeEffortClamp` maps a direct `max` or an `ultra` selection to `xhigh`
(for example, GPT-5.5). Sol, Terra, and Luna have a real `max` rung.

## Fast tier rules

Codex stores fast mode as:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

But the model catalog and runtime request tier id use `priority`. opencodex preserves that split.
Native OpenAI passthrough models keep fast support; routed providers are capability-gated —
`service_tier` is stripped only when the provider declares `supportsServiceTier: false` (the registry
classifies canonical OpenAI as `true`, DeepSeek and Volcengine Ark as `false`), while unclassified
custom gateways keep caller-supplied values untouched and never get an injection. A custom gateway
can opt in globally with `supportsServiceTier: true`, or narrowly with
`modelSupportsServiceTier: { "verified-model": true }`; an exact `false` narrows a provider
default of `true`, while provider-level `false` remains fail-closed. The same final adapter/model
decision controls both catalog metadata and runtime injection, so the fast option is never
advertised where it cannot be honored. An `openai-chat` destination can authorize every otherwise
eligible model with `chatServiceTier: true`, or authorize only exact models with
`modelSupportsServiceTier`; Responses routes do not need that extra Chat wire authorization.

## Subagent selection

Codex sorts picker-visible catalog entries by ascending `priority` and advertises the first five as
`spawn_agent` model overrides. The dashboard Subagents page can select and save up to five bare
native ids or routed `provider/model` ids. Manually configured `subagentModels` also accepts
account-qualified `<selector>/<native-openai-model>` ids, but the dashboard does not offer those
exact ids; saving the page replaces the list with dashboard-visible choices. opencodex assigns low
catalog priorities in the selected order; when account-qualified picker rows are enabled, bare native selections
expand into selector-qualified groups. Other models remain callable by exact id.

The featured-model list is separate from the Dashboard's **Sub-agent delegation** selection. It
controls which overrides Codex offers first; it does not select a model or trigger delegation by
itself.

## Desktop remote servers

Codex Desktop's remote-server mode filters the picker against the client's own
`available_models` allowlist (active when the remote `use_hidden_models` setting is on). Routed
catalog entries are still loaded and served - `model/list` returns them and the bundled CLI reads
them - but the Desktop renderer drops anything that is not on that native-only allowlist before
rendering. opencodex has no hook into that list; the upstream bug is tracked at
[openai/codex#19694](https://github.com/openai/codex/issues/19694).

Until Desktop exposes a control for the allowlist:

- Set the model directly in `~/.codex/config.toml` on the remote machine, for example
  `model = "input/grok-4.5"`. The picker may show `Custom`, but requests still use the configured
  routed model.
- Use Codex CLI or TUI instead of the Desktop picker; they do not apply the allowlist and list
  routed models normally.

## Refreshing model state

If the picker still shows stale entries, refresh the catalog and restart the target Codex surface:

```bash
ocx sync
```

opencodex rewrites `models_cache.json` with a deliberately stale cache wrapper whenever catalog
visibility, priority, or metadata changes, so the next Codex model refresh reads the new catalog.
