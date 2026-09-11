---
title: ZCode local agent provider
description: Run the official ZCode app server as an explicitly enabled, isolated OpenCodex provider.
---

## Direction and tool ownership

The **ZCode (local agent)** provider sends OpenCodex requests to the official ZCode CLI's
`app-server`. This is the reverse of the existing **Integrations → ZCode** feature, which
exports OpenCodex models into ZCode Desktop. Enabling one does not enable the other.

ZCode executes its own file and command tools. OpenCodex streams text, reasoning and
informational tool progress; it never sends those native actions back to the calling client
as executable function calls. Client tool catalogs, tool-result input, images and explicit
`tool_choice` constraints are not supported by this first version.

This is an optional local transport, not a hosted API or a subscription-token bridge.
Only the official ZCode runtime communicates with Z.AI. Protocol compatibility was verified
with ZCode CLI **0.16.5**, shipped in ZCode Desktop **3.10.2** on Linux. The app-server
protocol is private and may change; unsupported framing fails closed.

OpenCodex's vision, search, image and video sidecars are not used for this provider: they must
not replace an unsupported native operation with a direct API call. There is no direct-API
fallback. This describes the technical path, not a guarantee of promotion eligibility, billing
or subscription terms; those remain the vendor's policy.

## Isolate before enabling

Install/extract the official runtime from [ZCode](https://zcode.z.ai/en/docs/install) into a
separate location. Do not replace your main ZCode or global OpenCodex installation.

Create an **operator-owned executable launcher** that accepts ZCode arguments and starts
the runtime inside an OS sandbox (for example, Bubblewrap on Linux). Its contract is:

- Expose only runtime/system files read-only, a separate writable ZCode home and the approved
  disposable workspace. Do not mount the real home, main OpenCodex/ZCode data, host sockets,
  SSH agents or production project directories.
- Set `HOME` and XDG directories inside that sandbox. The launcher must translate paths if
  the sandbox home differs from its host path.
- Start `node /runtime/zcode.cjs "$@"` directly, without evaluating request text as shell code.
- Kill all sandbox descendants when the launcher exits; never reuse a desktop app-server.
- Permit the network access needed by your chosen provider. Filesystem isolation alone is
  **not network isolation**: apply egress restrictions separately if untrusted commands must
  not reach host-local services or the Internet.

The bridge does not construct or attest an OS sandbox for you. Its native-execution opt-in
authorizes the launcher you configured. A plain, unsandboxed `zcode` executable is not a safe
replacement for that launcher.

Run your launcher with `login --no-browser`, open the generated OAuth URL yourself and complete
login. Credentials remain in the **isolated** ZCode home; OpenCodex does not import credentials
from the main desktop installation. The official CLI creates its initial model configuration.
Additional models must be configured in that isolated profile, not just in Desktop's v2 file.

## Configure OpenCodex

Set these variables in the trusted environment that starts your isolated proxy (not a project
`.env` file or an incoming request):

```bash
export OCX_ZCODE_NATIVE_TOOLS=1
export OCX_ZCODE_COMMAND='["/srv/opencodex-zcode/zcode-sandbox"]'
export OCX_ZCODE_HOME=/srv/opencodex-zcode/zcode-home
export OCX_ZCODE_WORKSPACE=/workspace
```

`OCX_ZCODE_COMMAND` is a JSON argv array, not a shell command. The bridge appends `app-server`.
`OCX_ZCODE_HOME` is the **host-side** isolated home containing `.zcode/cli/config.json`;
`OCX_ZCODE_WORKSPACE` is the approved absolute path **inside** the launched environment.
Keep the proxy's own `HOME`, `CODEX_HOME`, `OPENCODEX_HOME`, XDG directories and listening port
separate from your main installation too.

Add **ZCode (local agent)** through Providers, or add this provider to the isolated config:

```json
{
  "providers": {
    "zcode": {
      "adapter": "zcode",
      "authMode": "local",
      "baseUrl": "https://zcode.z.ai",
      "liveModels": true
    }
  }
}
```

The base URL is an identity marker; inference uses stdio, never HTTP to that URL.
Models come from the isolated `.zcode/cli/config.json`, with selectors such as
`zcode/zai/glm-5.1`. Disabled entries and obvious local proxy destinations are excluded to
avoid recursive routing. Do not configure indirect routes or DNS aliases back to OpenCodex.
The existing catalog refresh flow reloads these settings; no primary client configuration is
rewritten. **Test connection** checks the local catalog only, not account entitlement or quota.

## Safety and limitations

- Native execution is off unless all four environment settings are present. Removing the
  opt-in makes new requests fail before a process starts.
- Sessions use ZCode's `edit` permission mode. Interactive permissions are denied; user-input
  requests are cancelled rather than answered automatically. Continue such work in the isolated
  ZCode client. No permission-skipping flag is passed.
- Each turn owns a child process. A profile has one active turn at a time because ZCode writes
  model selection to shared settings; at most 32 active/queued bridge calls are admitted.
- `previous_response_id` uses OpenCodex's owner-fenced private continuation state. Client thread
  identity also supports process-local continuity. A different model/profile or an uncorrelated
  request gets a separate session. If a saved session cannot resume, the bridge reports failure
  rather than silently replaying work in a new session.
- The default turn deadline is five minutes. Cancellation/deadline closes the owned child.
  The launcher is responsible for terminating descendants. `Task`, `TaskOutput` and `TaskStop`
  are denied; work cannot keep an owned sandbox running after its turn ends.
- Once a task is sent, failures become non-retryable `zcode_agent_interrupted` incomplete
  responses. Automatic empty-completion replay is disabled for this adapter. Do not manually
  retry a failed mutation without checking the workspace first.
- Vendor errors and stderr are not forwarded. No raw credentials or protocol traces are
  included in discovery/management results. Token usage is currently unavailable, not measured
  as zero; model access still consumes your ZCode account quota.
- Linux was tested. Windows/macOS require an equivalent isolated launcher and are not yet
  live-validated. Streaming reasoning is supported, but caller-selected reasoning levels are
  not yet advertised or mapped; ZCode owns the model's configured defaults.

## Verification

Start the isolated proxy bound to loopback on an unused port, then check `/healthz` and
`/v1/models`. Explicitly submit a short request to a `zcode/...` model before claiming that
authentication works. Test a harmless file write in the disposable workspace and verify it
on disk. Do not use private projects or publish account-bearing logs as fixtures.
