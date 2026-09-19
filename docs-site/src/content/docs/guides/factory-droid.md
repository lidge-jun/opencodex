---
title: Factory Droid integrations
description: Use OpenCodex models in Droid, or connect Factory models to OpenCodex through a local bridge.
---

Factory Droid and OpenCodex can connect in two directions. The managed integration below is the
normal choice when you want to run OpenCodex models inside Droid. The bridge section is for the
opposite direction, where OpenCodex calls a model supplied by Factory.

## Use OpenCodex models in Droid

Install and sign in to the [Droid CLI](https://docs.factory.ai/droid-cli/quickstart), start OpenCodex
on loopback, then enable **Factory Droid** on the OpenCodex **Integrations** page. The equivalent CLI
commands are:

```bash
ocx integration client status --client droid
ocx integration client enable --client droid
```

OpenCodex adds one row per active model to `~/.factory/settings.json` under `customModels`. Each row
uses a stable `custom:opencodex:<provider/model>` ID, the OpenCodex `/v1` base URL, and Factory's
`generic-chat-completion-api` provider. Context, image, and reasoning metadata come from the live
OpenCodex catalog. The response ceiling is 16,384 tokens so Droid does not request the full context
window as output. OpenCodex does not write a real API key.

The integration owns only those exact OpenCodex rows. Existing Factory settings and custom models
remain untouched. A model selection change or `ocx sync` refreshes an already-owned catalog.
Disabling removes only the OpenCodex rows, and restore puts back the exact file snapshot recorded
for the selected operation:

```bash
ocx integration client disable --client droid
ocx integration client restore --op <opId> [--confirm-drift]
```

For a process-only trial that does not modify `~/.factory/settings.json`, export to a temporary file
and pass it to Droid:

```bash
ocx export --client droid --out /tmp/opencodex-droid-settings.json --force
droid exec --settings /tmp/opencodex-droid-settings.json \
  --model custom:opencodex:gpt-5.6-luna \
  "Reply with DROID_OK only."
```

This integration is loopback-only. Factory's custom model schema cannot carry OpenCodex's dedicated
remote admission header without persisting a credential, so OpenCodex refuses a non-loopback bind.

## Use Factory models in OpenCodex

Factory Droid is an agent runtime, not a documented OpenAI-compatible inference endpoint. If a
custom provider pointed at an internal Factory LLM URL returns `403 Forbidden`, changing only the
opencodex adapter or adding provider headers does not make that private route a supported public API.

The working integration is:

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

This keeps the Factory credential inside the official Droid client. OpenCodex receives a separate,
local-only bridge token.

## What failed and why

| Symptom | Cause | Fix |
| --- | --- | --- |
| `403 Forbidden` from a Factory LLM URL | The URL is not a documented general-purpose OpenAI endpoint for third-party clients | Invoke Factory through the official Droid CLI or SDK |
| `404` at `/models/models` | The provider base URL already ended in `/models` | Use an API root as `baseUrl`; never include the discovery path |
| Model search fails | The bridge does not expose a complete live catalog | Set `liveModels: false` and provide a static `models` list |
| Loopback provider is rejected | Private-network access is denied by default | Set `allowPrivateNetwork: true` only for the loopback bridge |
| `${DROID_BRIDGE_TOKEN}` is unresolved | The variable is missing from the opencodex service environment | Inject it into the service process, not only an interactive shell |
| `OutputTextDelta without active item` | The bridge emitted a text delta before opening an output item and content part | Emit the complete Responses SSE lifecycle in order |

The same Factory credential can therefore work in `droid exec` while a direct request to an
undocumented LLM URL still returns `403`. Those results test different products and should not be
treated as contradictory.

## Prerequisites

1. Install and sign in to the [Droid CLI](https://docs.factory.ai/droid-cli/quickstart).
2. Confirm a bounded headless request works:

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. Run a local bridge that invokes `droid exec` (or the official Droid SDK) and exposes:

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory documents `droid exec` as its non-interactive automation surface and recommends JSON output
for scripts. For a longer-lived integration, Factory also documents stream JSON-RPC and official
TypeScript and Python SDKs in the
[Droid Exec guide](https://docs.factory.ai/droid-exec/overview).

## Bridge contract

Bind the bridge to `127.0.0.1`, require a randomly generated bearer token, cap request sizes, and
allowlist model IDs. The minimal bridge accepts only these Responses `input` shapes:

- a non-empty string; or
- an array containing only `message` items. Each message must have a `user`, `developer`, `system`,
  or `assistant` role and either string content or text-only content parts (`input_text` for input
  roles and `output_text` for assistant history).

Validate the complete request before invoking Droid. If an input part is an image or file, `tools`
contains any tool definition, or `input` contains a tool call or result (`function_call`,
`function_call_output`, `custom_tool_call`, or `custom_tool_call_output`), return HTTP `400` with a
Responses-style `invalid_request_error`. Use a stable bridge-specific code such as
`unsupported_bridge_input` and identify the rejected field in the message. Do this before starting
SSE, even when `stream: true`; never discard, stringify, or flatten unsupported content into the
prompt.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

For an accepted request, the bridge should:

1. Convert the accepted Responses `input` to a prompt.
2. invoke `droid exec --model <id> --output-format json <prompt>`;
3. parse the final `result` and `session_id`;
4. return an OpenAI Responses envelope; and
5. map `previous_response_id` to the Droid session ID when continuation is required.

For streaming responses, emit this lifecycle in order:

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Do not expose the bridge on `0.0.0.0` and do not reuse the Factory credential as the bridge bearer
token.

## OpenCodex provider configuration

Create the custom provider with the explicit provider ID `droid`:

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

This creates the `providers.droid` config entry. In the dashboard, open **Providers → droid → Edit
JSON** and replace that provider's value with:

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

The model IDs are examples. Keep only models that `droid exec` can use for the signed-in Factory
account. Do not add Factory-specific inference headers to this provider: its upstream is the local
bridge, not a Factory HTTP endpoint.

After saving a provider or changing its static catalog, synchronize and restart Codex so new
sessions read the updated catalog:

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex` restarts matching app-servers and fully quits and relaunches the Codex desktop
app, which ends live conversations. Use `--restart-app-server-only` to leave the desktop app
running. Run the restart only after finishing or saving those sessions.

## Verify the complete route

Check each boundary separately:

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

A provider row or model-picker entry proves only catalog visibility. The integration is working only
after the Responses probe returns through the `droid/<model>` route.

## Current limitation

The minimal bridge above translates text and the Responses SSE lifecycle. It does **not** implement
the full bidirectional Codex function/tool-call protocol. Codex App and `codex exec` normally send
tool definitions even when a prompt says not to call tools, and the current Codex CLI has no general
flag that removes those definitions. The minimal bridge must reject those requests with the `400`
contract above. Tool definitions, tool calls, tool results, permissions, cancellation, and rich
Droid events require a stateful bridge built on Factory's stream JSON-RPC mode or an official Droid
SDK. Treat `ocx access test` success as text-path verification, not Codex agent or tool-path
verification.
