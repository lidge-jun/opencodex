---
title: Verify a custom remote gateway
description: Check a custom Chat Completions gateway from discovery through a bounded completion.
---

Before registering a gateway, obtain its authorized Chat Completions base URL, API key, and
supported model IDs from its operator. For example, `https://api.example.com/v1` is a placeholder,
not a working endpoint. Start the proxy if it is not already running, then choose **Custom** in the
dashboard, name it `my-gateway`, select `openai-chat`, and enter the authorized URL and key in the
form. Save it without putting the key in commands or shared examples. A saved provider is not yet
proof that discovery or inference works.

On a [Remote Link](/guides/remote-link/) Child, providers come from the Home: the Child's dashboard
refuses provider changes and its requests are served by the Home's providers. Register and verify
the gateway on the Home instead.

Check the boundaries separately, using the configured local port if it differs from the default:

```sh
curl -fsS http://127.0.0.1:10100/healthz
ocx ready
ocx provider test my-gateway
ocx models live --provider my-gateway --json
```

Health and readiness describe the proxy; they do not prove the upstream can generate text. The
provider test without `--model` checks discovery, not inference. `applicable: false` can mean there
is no live discovery endpoint for a static catalog; it is not a successful inference test. A public
model list also need not validate the key. If discovery fails or no model appears, check the URL,
credentials, upstream access, and provider configuration before selecting a model.

A gateway can serve completions without a model-list endpoint. If its operator supplies a supported
raw ID, configure `liveModels: false` and `models: ["vendor/model"]` on the existing provider,
preserving its other fields and replacing the example ID with the supplied value. See
[static model catalogs](/reference/configuration/providers/#static-model-allowlists).

Before editing `config.json` directly, save your work and wait for active requests to finish;
stopping the proxy can interrupt them. Stop the proxy through its owner: quit OpenCodex Desktop
from its tray, run `ocx service stop` for a service install, or run `ocx stop` for an unsupervised
proxy. Confirm it is stopped, then edit and save the file without running other configuration
writers. Start it again through the same owner: reopen Desktop, run `ocx service start`, or run the
original `ocx start` command with its launch options, including `--port` if supplied. For a
foreground start, leave it running in its terminal and run `ocx sync` and the remaining checks from
another terminal. Then inspect the live catalog again. Alternatively, test the supplied raw ID directly
with the cost-confirmed completion command below; that test does not require a catalog row.

In the live catalog inspect the actual `id`, `namespaced`, `disabled`, and
`initialSelectionPending` fields. Initial selection can leave models off or pending; see
[initial model selection](/reference/configuration/providers/#initial-model-selection).
Resolve pending initial selection before enabling a row. For visibility commands, combine the
provider name with the row's **raw `id`**, preserving any slashes inside that ID:

```sh
ocx models enable 'my-gateway/<raw-upstream-id>'
```

For example, a raw `id` of `vendor/model` needs the selector `my-gateway/vendor/model`.
The client-facing `namespaced` slug may instead be `my-gateway/vendor-model`; substituting that
encoded slug can leave a raw disabled entry in place. Enabling one model does not disable others.
If only that model should be visible from this gateway, disable each other enabled gateway row
using its raw `id` in the same selector format, then inspect the list again:

```sh
ocx models disable 'my-gateway/<other-raw-upstream-id>'
ocx models live --provider my-gateway --json
```

Check that the intended row has `disabled: false` and the other intended exclusions are disabled.
A bare native model ID can select a different route. Use exact values rather than display names or
guessed reasoning suffixes: a suffix may be a distinct upstream model ID, while reasoning effort
is a separate setting. See the [CLI reference](/reference/cli/providers-accounts/) for details.

When needed, run `ocx sync` to update the client catalog, then confirm the model appears in the
Codex model picker. A running client can retain an older in-memory list. Preserve active work and,
if the picker remains stale, fully quit and reopen Codex. Alternatively, after explicit approval,
use [`ocx system codex-restart --yes`](/reference/cli/agents/): it can
interrupt the session and discard unsaved drafts, selections, or pending approval prompts.
Outside the direct config-file edit above, restarting a client or proxy is not the default recovery step.

To verify one actual completion on a supported key-auth remote configuration, pass the **raw
upstream `id`** from the row or gateway operator unchanged, without adding the provider prefix:

```sh
ocx provider test my-gateway --model '<raw-upstream-id>'
```

This sends one bounded request, consumes quota, and may incur charges. Confirm the default-No prompt
only after approving that cost; non-interactive or JSON use requires `--yes`. An
`applicable: false` completion result sends no completion and is not a pass, even if the command
exits zero. Before counting a successful test as a pass, check that the reported wire model
matches the intended upstream ID; an alias can resolve to a different model. In JSON output this
is `wireModel`. A successful text completion does not establish tool calling, structured output,
continuation behavior, or the model's actual identity; upstream-reported identity is metadata. For
later compatibility issues, reproduce the affected protocol separately with a sanitized fixture.
