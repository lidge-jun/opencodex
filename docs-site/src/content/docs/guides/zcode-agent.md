---
title: ZCode local agent provider
description: Run the official ZCode app server as an explicitly enabled OpenCodex provider with optional isolation.
---

## Direction and tool ownership

The **ZCode (local agent)** provider sends OpenCodex requests to the official ZCode CLI's
`app-server`. This is the reverse of the existing **Integrations → ZCode** feature, which
exports OpenCodex models into ZCode Desktop. Enabling one does not enable the other.

ZCode executes its own file and command tools. OpenCodex streams text, reasoning and
informational tool progress; it never sends those native actions back to the calling client
as executable function calls. Client tool catalogs, tool-result input and explicit
`tool_choice` constraints are not supported by this first version.

This is an optional local transport, not a hosted API or a subscription-token bridge.
Only the official ZCode runtime communicates with Z.AI. Protocol compatibility was verified
with ZCode CLI **0.16.5**, shipped in ZCode Desktop **3.10.2** on Linux. The app-server
protocol is private and may change; unsupported framing fails closed.

Attached images are described by the **vision sidecar configured in OpenCodex** before the
main request reaches ZCode. This helper can consume quota on its own configured provider;
the main GLM request still runs through official ZCode, never a direct Z.AI API fallback.
Search, image-generation and video-generation sidecars remain disabled for this native agent.

The ZCode bridge itself accepts text, including for GLM-5.3-Flash: selecting Flash does not
make this transport image-capable. Neither model is offered as its own vision describer.
Configure an image-capable helper under **Dashboard → Vision sidecar**; existing backend/model
selection is respected. If vision is disabled, unavailable, capped or fails, images are replaced
with explicit unavailable-description markers rather than being silently passed to GLM or
presented as successfully analyzed. Unsupported video input and client tool results are not
converted into fabricated descriptions.

 This describes the technical path, not a guarantee of promotion eligibility, billing
or subscription terms; those remain the vendor's policy.

## Connect from the dashboard (Linux)

1. Install the official **ZCode Desktop**, open it on the **same computer as the proxy**,
   and sign in/configure your Z.AI models there. Keep Desktop open during initial detection.
2. Use a browser session on a loopback-bound dashboard or a paired hub. An admin-token login on a public listener does not authorize Desktop setup. In OpenCodex, choose **Providers → Add Provider → ZCode (local agent)**.
3. Click **Detect again** if needed. OpenCodex finds running Desktop installations and standard
   installation folders. For portable/extracted installations, the advanced folder field lets
   you select the application directory; it never accepts a shell command.
4. Choose a **workspace folder** with the folder browser. The default is a private disposable
   folder. Do not select your entire home or a credentials/configuration directory.
5. Review the native file/command execution notice, check the consent box and click
   **Connect Desktop**. OpenCodex constructs the native launcher, verifies the protocol, enables the ZCode provider and updates the Codex catalog;
   no environment variables, API-key entry, token import or separate CLI login is required.
6. Optionally select a model and click **Test with one request**. This sends one brief prompt
   through the official ZCode runtime and consumes account quota. Connecting alone checks the
   local protocol and catalog, **not** account entitlement or inference.
7. The provider is now available immediately. Select a ZCode model in your
   calling client. Only configured, enabled built-in Z.AI profiles are exposed by this workflow;
   custom Desktop providers and routes back to OpenCodex are not imported.

For an existing provider, the same panel is in **Settings**. **Disconnect** revokes the managed
connection and closes its owned app-server children. It does not log out of Desktop, delete
Desktop conversations, or change its configuration. A saved disconnected state also prevents
an older environment-based setup from silently reactivating. Reconnect to refresh the model
catalog after changing Desktop's model configuration.

The proxy host needs a Node.js version compatible with the installed ZCode
runtime. Missing prerequisites and unsupported platforms are shown in the panel. Managed setup
is currently Linux-only; Windows/macOS need the advanced launcher flow below. A remote browser's
local Desktop is not the proxy host's Desktop: detection and workspace selection operate on the
computer running OpenCodex.

### Add another account (manual selection)

In **Providers → Add Provider → ZCode (local agent)**, or the existing provider's
**Settings**, scroll to **Saved ZCode accounts**. This is separate from **Connect Desktop**:
connecting Desktop continues to use its current local sign-in; saved accounts retain
independent official ZCode profiles.

1. Select the installed Desktop runtime and working directory above the accounts section.
2. Give the account a recognizable name, such as **Personal** or **Work**.
3. Read and check the saved-account consent, then choose **Add account**.
4. Open the **Sign in with ZCode** link. Sign in to the intended account on ZCode's official
   page; use a private browser window or switch accounts there when adding a second identity.
5. Return to the panel. OpenCodex waits for ZCode's own OAuth polling, verifies the local
   protocol, enables a separate provider and publishes its models automatically. It never
   asks you to copy tokens or API keys. Do not close the panel before this finishes.
6. Select the desired **account name / model** in your client's model picker. Adding an
   account does **not** select it as the default and does not run inference. If an existing
   Codex process still shows the old picker, restart Codex yourself after its tasks finish.

Repeat for each account (up to 20). Accounts do not form a pool: there is no automatic
rotation or fallback to another ZCode account or the Desktop profile. Combos may target
explicit account providers if you configure those routes yourself. Quota bars remain
specific to each provider/account.

**Sign in again** replaces only the matching account's sign-in, retaining its provider ID
and custom settings. A different identity is rejected; use **Add account** for it instead.
Duplicate saved identities are rejected too. **Rename** updates generated picker labels,
not customized model names. **Remove** deletes OpenCodex's saved profile and provider, not
ZCode Desktop's original profile. Remove references from defaults/combos before removing an
account, and wait for its active tasks. No task is stopped automatically.

A protocol/registration/catalog failure is displayed as pending, not complete success.
Use **Retry provider activation** for a saved connection whose catalog is pending. For a
failed or expired login, cancel the draft and start again. Saved accounts and provider
bindings persist across OpenCodex restarts; pending OAuth jobs do not. If a restart or
closed panel leaves an unfinished account, remove that draft before trying again.

Native OAuth and Coding Plan credential setup run in the official installed ZCode host.
The bridge only carries a short-lived authorization URL and safe status codes to the
browser. Profiles stay in the proxy's private configuration directory; they are not
imported into the browser or pooled. The same host-access / optional-sandbox policy described
below applies. Setup is Linux-only and needs a dashboard-session principal, not just an
admin API token.

### What “connect Desktop” means

ZCode's app-server is a stdio child, not a public Desktop TCP endpoint. OpenCodex uses the
**official runtime bundled with the selected Desktop installation** and its existing model
configuration. It starts an owned native session; it does not attach to a conversation already
open in Desktop. The original **Integrations → ZCode** configuration export remains separate.

By default, the managed runtime runs **without an OpenCodex OS sandbox**, with the
permissions of the proxy's operating-system user. It can read and modify files outside the
selected working directory, including sensitive files accessible to that user. Absolute
paths retain their host meaning. The selected workspace is a starting directory, not a
filesystem boundary. This default also applies to previously connected installations after
upgrading. No root elevation or permission-skipping flag is used.

Any isolation must be applied by the harness/operator **where the native ZCode process
executes**. A sandbox in a remote calling client does not automatically constrain this
server-side process. Only use trusted callers and projects.

OpenCodex still separates bridge-owned runtime state from the Desktop profile to avoid
overwriting Desktop settings. Temporary compatible configs are private and removed when
the child exits normally; the session database remains private and persistent. Separate
state directories do not prevent native tools from accessing other host files. Only official
ZCode handles account and inference traffic; no direct-API fallback is introduced.

### Optional OpenCodex sandbox

Set the following in the environment of the OpenCodex service or terminal, then restart
OpenCodex at a safe time:

```sh
export OCX_ZCODE_SANDBOX=1
```

Bubblewrap is required only when this option is enabled. The existing restricted workspace
mounts and real sandbox preflight apply; failure never falls back to host execution. In this
mode the selected workspace appears as `/workspace`; other host files are not mounted.
Unset the variable to restore the default host execution. Environment changes apply to
existing managed connections without requiring another connection. They do not reconfigure
an advanced operator-supplied launcher.

Managed consent and installation/workspace paths are stored privately under
`$OPENCODEX_HOME/zcode-desktop/`, separately from provider configuration. Data-plane requests
cannot choose an executable or override these paths. Connecting, disconnecting and the optional
quota-spending test require the dashboard's authenticated GUI session, not a raw API/admin token.

## Advanced: operator-supplied isolated launcher

This remains available for existing deployments and environments without managed Linux setup.
A saved managed connection takes precedence over these environment variables.

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

- Native execution requires either a persisted, explicitly consented Desktop connection or all
  four advanced environment settings. Disconnecting revokes managed execution.
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

## Usage-time notices

Providers → Usage / current account limits and the overview rate-limit section
show time-based Coding Plan notices for ZCode. The browser's timezone is used
(not the proxy server's timezone), including date changes and daylight saving.
These notices never change routing, recorded usage, or estimated costs, and make
no direct provider API calls.

Official rules verified September 11, 2026:

- [Coding Plan rates](https://docs.z.ai/devpack/overview): peak hours are Monday
  through Friday, 14:00–18:00 Singapore (UTC+8). Other hours, including weekends,
  receive 50% off the standard **model credit** rate, not necessarily MCP charges.
- [Flash campaign](https://docs.z.ai/devpack/notice/event-glm-5.3-flash): September
  3–20, 2026, daily 23:00–09:00 Singapore, including weekends. GLM-5.3-Flash via
  ZCode 3.10+ has zero quota consumption for paid Coding Plan subscribers only
  while **both** the 5-hour and weekly quotas have remaining allowance. An
  exhausted quota must reset before participating. Other agents receive a
  different benefit, not zero consumption; GLM-5.3 is excluded.

The notice distinguishes an active time window from account eligibility:
OpenCodex does not verify the subscription balance or Desktop version here.
Campaign notices expire automatically. Since the announcement does not specify
whether the final overnight window extends into September 21, OpenCodex
conservatively stops advertising it at midnight ending September 20 Singapore.
Source links and this boundary caveat are visible in the notice. Exact Z.AI
Coding Plan HTTP endpoints also show peak/off-peak notices, but never the
ZCode-only free-window alert; ordinary pay-as-you-go endpoints are excluded.

## Remaining subscription quota

The provider overview and Usage tab reuse the same quota-bar component as OpenAI.
For ZCode, the fill and label show **remaining** model credits in the 5-hour and
weekly windows, with localized reset times. Warning colors still reflect high
consumption. Unknown or failed readings do not appear as a full balance.

Quota comes from the **official ZCode Desktop host service**, not from locally
counted tokens or a proxy-made Z.AI API request. OpenCodex starts the trusted
Desktop executable in its Node runtime mode and calls its existing read-only
entitlement RPC. Native ZCode owns authentication and network requests. This
separate short-lived host uses a disposable private profile copy so native normalization
does not rewrite Desktop settings. The copy is removed after the process exits.
When `OCX_ZCODE_SANDBOX=1` is enabled, this host additionally uses Bubblewrap and tmpfs.
No credential material is returned in the quota response. No model prompt, quota-reset action, or
purchase is requested. Tested with Desktop 3.10.2 on Linux; other private host
protocol versions can return unavailable instead of a fabricated quota.

Managed Desktop connections need no extra quota configuration. For the advanced
operator-launcher setup, explicitly set `OCX_ZCODE_DESKTOP_RUNTIME` to the trusted
installed/extracted Desktop directory (the directory containing `resources/`).
The native quota host then uses the Z.AI key from the **same isolated CLI config**,
not the user's unrelated Desktop login. The source provider is the configured
default model's provider prefix, or `zai` when none is set; an absent key or
unsupported profile is reported as unavailable. This opt-in does not change
inference routing or migrate your model IDs.

The dashboard's existing quota cache and Refresh quotas controls apply. Concurrent
reads share one native probe. Account/configuration changes invalidate snapshots;
errors clear the ZCode report rather than leaving a misleading full balance.
These bars are informational and do not enable quota-based automatic rerouting.
The native session app-server's token accounting remains unavailable; subscription
quota is a distinct measurement. See [ZCode Usage Stats](https://zcode.z.ai/en/docs/usage-stats)
for the distinction between App Usage and Coding Plan statistics.

### Desktop Node compatibility

Managed Desktop setup requires **Node.js 24.0.0 or newer**, with working
node:sqlite, on the **OpenCodex process PATH**. This is the bridge's supported
floor, not a claim that every earlier Node version is incompatible with every
ZCode release. Selection checks each absolute PATH directory in order and skips
incompatible Node binaries, including an older npm/nvm prefix ahead of a modern
installation. Relative and empty PATH entries are not searched. It does not
assume that the Node which launched OpenCodex is the Node resolved by Bun.

If no suitable executable is found, setup reports node_incompatible (or
node_missing when none exists) before reading the Desktop profile or starting
the app server. Add a compatible Node directory to the PATH used by your terminal
**or systemd service**, restart that process, and choose **Detect again**.
No global Node replacement is required. Capability checks discard stderr and
inherit neither credentials nor NODE_OPTIONS. Connection still requires explicit
consent and a successful official workspace/readState protocol check; the
bootstrap's model catalog alone does not prove readiness.

The quota reader launches Desktop's own Electron executable with
ELECTRON_RUN_AS_NODE, not the external Node selected from PATH. Managed account
settings still pass the same Desktop prerequisites; advanced quota reads do not
use this external Node selection.


### One-step activation and recovery

**Connect Desktop** includes protocol verification, idempotent provider registration
and the normal Codex catalog convergence. No separate **Use this provider** action is
required. It does not change default provider/model selections or execute inference.
Reconnection enables the existing ZCode provider without replacing custom options,
aliases, model filters or pricing; conflicting provider registrations are not overwritten.

Success is shown only when the provider is enabled and the connected models are visible
in the actual Codex catalog. A protocol-only connection, failed config write or failed,
skipped or incomplete catalog refresh remains a partial state. **Retry activation**
finishes registration/catalog publication without sending a prompt or reconnecting the
runtime. Review the activation consent again before retrying. Existing visibility filters
are preserved; if they hide the connected models, the catalog state remains incomplete.

If a running Codex instance does not pick up the models, restart it after its tasks
finish. OpenCodex does not terminate or restart Codex processes automatically.


### Sandbox policy and cold starts

When OCX_ZCODE_SANDBOX=1 is set, detection runs a minimal Bubblewrap sandbox from the OpenCodex server itself, without
loading your profile or sending inference. If it reports `sandbox_unavailable`, ask
your administrator to review user namespace and AppArmor policy for that service.
A successful probe from a terminal or another application does not prove that the
server has the same permissions. OpenCodex never disables isolation or changes host
security policy automatically. After a policy correction, select **Detect again**.

Managed Desktop native model IDs also supply routing after a cold restart, before
live discovery fills the cache. You do not need to add them manually to provider
settings. Existing model filters and defaults remain unchanged; ambiguous aliases
are still rejected instead of guessed.
