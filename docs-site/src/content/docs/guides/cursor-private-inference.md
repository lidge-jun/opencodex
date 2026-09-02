---
title: Cursor Private Inference
description: Use opencodex-routed models inside Cursor's local-agent build, on macOS, Windows or Linux, without a public tunnel.
---

Regular Cursor cannot talk to a proxy on your own machine. When you set "Override OpenAI
Base URL", Cursor's backend builds the prompt and calls that URL from Cursor's servers, which
reject loopback, LAN and private addresses. That is why every community recipe for Cursor +
local models ends with ngrok, Cloudflare Tunnel or a VPS.

Cursor also ships a second desktop build, **Cursor Private Inference**, whose agent loop runs
locally and calls an OpenAI-compatible gateway you configure. Pointed at opencodex, it uses
your routed models with no tunnel, no app patching and no TLS. This page covers that build.

## Before you start

Read this section first; it is the part people miss.

- **opencodex does not distribute this build.** Cursor does not document it either. It is
  not linked from cursor.com, may change without notice, and may stop being available. If
  you do not already have it, this guide does not apply; use the community
  [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) bridge with a public HTTPS
  endpoint instead.
- **Cursor sign-in is still required.** The login wall comes before the gateway dialog.
- **Cursor's own models are unavailable.** In local mode the picker lists only what your
  gateway returns. Tab completion, Cursor's catalog (Composer, Auto) and Cloud Agents are
  off. You can still reach Cursor-provider models through opencodex's own `cursor/*`
  routes if you have configured that provider.
- **Every turn carries Cursor's local system prompt**, roughly 23k tokens on the second
  and later turns. Budget for it when you pick a model.
- **It shares identity with regular Cursor.** Same bundle id, same `~/.cursor`, same
  `Application Support/Cursor` (macOS), `%APPDATA%\Cursor` (Windows) or
  `~/.config/Cursor` (Linux). Launch it with `--user-data-dir <dir>` to keep the two apart,
  and leave "Import data from existing Cursor installation" unchecked on first run unless
  you want your settings copied.

## Configure the gateway

opencodex needs to be running (`ocx service status`). Then either of these works; both
end up in the same place.

**In the app.** Settings → Models → Gateway → Configure gateway:

| Field | Value |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1` (include `/v1`; plain `http://` loopback is accepted) |
| API Key | the value of `OPENCODEX_API_AUTH_TOKEN` if your service uses API auth, otherwise any placeholder such as `opencodex-loopback` |

Click **Refresh model list**. The picker fills with opencodex's `/v1/models`; switch on the
rows you want.

**With environment variables.** The app reads these at start:

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, extra headers as key=value pairs
```

Cursor Private Inference is a GUI app, so an interactive shell profile is not enough on
its own; the variable has to be in the environment of whatever launches the app.

| OS | Where to put it |
|---|---|
| macOS | `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` for the current login session, or a LaunchAgent with `EnvironmentVariables` to make it persistent. Starting the app from a terminal also works. |
| Windows | `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1` (user scope; affects new processes) or System Properties → Environment Variables. Restart the app afterwards. |
| Linux | `~/.profile` or `~/.pam_environment` for a display-manager session, or `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1` when the desktop runs under a user systemd session. The AppImage launched from a terminal inherits that shell's environment. |

The build exists for macOS (arm64, x64, universal), Windows (x64, arm64) and Linux (x64,
arm64). Configuration is identical across them.

## From the dashboard

The opencodex dashboard has a **Cursor** tab under Integrations (`/#integrations/cursor`). It is
read-only toward Cursor: it never writes Cursor's settings database, keychain entry, or app
bundle, so there is no switch to flip. What it does is hand you the values and show you whether
they took.

- **Installed builds.** Whether Cursor Private Inference (with its path and version) and
  regular Cursor (path only) are present. If only regular Cursor is found, the tab says so and links back here:
  regular Cursor routes custom endpoints through Cursor's servers, so a loopback proxy is
  unreachable without a public tunnel.
- **Gateway values.** The Base URL on the proxy's own listening port (from its runtime record,
  so a reverse-proxied dashboard still shows the port Cursor on this machine can reach), with a
  Copy button. The API Key row depends on the bind: when it needs no credential the row is
  `opencodex-loopback` with Copy; when API auth is on, or any opencodex API key is configured,
  the row tells you to use one of your own keys and links to the API Keys tab. Any configured
  key works, not only `OPENCODEX_API_AUTH_TOKEN`.
- **Connection.** The last `/v1/models` request whose User-Agent is exactly `Cursor/<version>`
  (the header Cursor's local-agent runtime sends), with the time and the version. It reads
  "never seen" until Cursor calls the proxy; pressing
  **Refresh model list** in Cursor is what makes it flip. The card refreshes every 15 seconds
  while the tab is open.
- **What Cursor will show.** A Model / Reasoning / Context table for the models opencodex
  advertises (disabled models and provider allowlists apply, the same as the raw list),
  following the rules in the next section. It is a prediction: Cursor picks the Reasoning
  ladder from its own table.

## Models and reasoning effort

The picker is opencodex's raw `/v1/models` list. Two things decide whether a model row gets
a **Reasoning** control:

1. opencodex must advertise capabilities on the row (`api_types` plus a `capabilities`
   object). It does, from v2.41. Older proxies show the models but no effort control.
2. The model id, after stripping everything up to the last `/`, must match Cursor's own
   effort table. Cursor decides the ladder, not opencodex:

| Model id (after the last `/`) | Ladder Cursor shows | Wire field |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Low, Medium, High, Extra High | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Low, Medium, High, Extra High | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Low, Medium, High, Extra High, Max | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Low, Medium, High, Max | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Minimal, Low, Medium, High, Extra High | `reasoning_effort` |
| `gemini-*` (needs `supports_reasoning`) | Minimal, Low, Medium, High | `reasoning_effort` |
| anything else, including `claude-fable-5-1`, `kimi-k3` | no control | — |

So `anthropic/claude-opus-5` works, and opencodex's `max`/`ultra` tiers for GPT-5.6 are not
reachable from this picker. For a model with no control, set a default in opencodex instead
(`modelDefaultReasoningEfforts` on the provider); that default applies when Cursor sends no
effort.

### "Max" is two different things

Regular Cursor shows a **Max** toggle next to some models. That is Max Mode, a larger context
window, not a reasoning tier. In the local-agent build the same idea appears as a **Context**
entry in the model menu, and opencodex lights it up for the native GPT-5.6 family: **272K**
(default) or **922K** (the 1M opt-in, marked as costing more). The value you pick caps that
turn's context. Routed models show a single window and no Context entry; a provider context
cap below 922K removes the entry for the native rows too.

Reasoning-effort **Max** (opencodex's `max`/`ultra`) is the other meaning, and that one is
not reachable: Cursor takes the effort ladder from its own table rather than from the gateway,
and the GPT-5.6 entry stops at Extra High.

Because opencodex advertises `responses` in `api_types`, this build sends agent turns to
`/v1/responses` with `reasoning.effort`, not to `/v1/chat/completions`.

## Verify

`ocx observe logs` shows the turns as `inboundProtocol: responses` with `admissionKind: loopback`.

| Symptom | Check |
|---|---|
| 401 from the gateway | the API Key does not match `OPENCODEX_API_AUTH_TOKEN`; for a loopback bind without API auth any value works |
| picker is empty | opencodex is not running, or the Base URL is missing `/v1`; press Refresh model list after fixing |
| models listed but no Reasoning control | opencodex older than v2.41, or the model id is not in the table above |
| a schema change is not picked up | Cursor caches `/models` per Base URL string; restart the app, or temporarily save a different spelling of the URL (`localhost` vs `127.0.0.1`) and refresh |
| 23k-token first turn | expected; that is Cursor's local system prompt |
