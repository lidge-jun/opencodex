---
title: Composer Usage-Gate Fallback
description: Queue text to an existing Codex thread on demand, without changing OpenCodex routing or desktop authentication, while preserving server-side quotas.
---

A desktop **composer-only** usage gate can prevent new input even when a thread's configured
OpenCodex route has available capacity. On a compatible installation, `codex queue` submits
through Codex's native app-server queue without using that input box. It does not patch the app,
intercept TLS, install a certificate, or change authentication.

This is **not a fix for every usage-limit state**. It neither restores exhausted quota nor
unlocks the model picker. A thread already using `gpt-reserve` keeps that model; queueing text
does not switch it to another provider. Server-side authorization, provider quotas, approvals,
and the thread's execution settings still apply.

## Identify the blocked layer

A disabled composer before dispatch is different from an actual provider rejection after
submission. A custom model label does not prove an independent provider or available capacity.
Use this fallback only for a deliberately selected thread with an otherwise usable route;
check pending approvals, active turns and app-server connectivity separately.

The main-account hard lock remains authoritative. It is a pre-exhaustion admission guard,
not a way to restore an already exhausted account. This helper neither disables that guard nor
changes which provider a thread uses. Do not change quota responses or turn off the guard to
make a queued native-account request execute.

## OpenCodex integration and ownership

Keep the existing [Codex integration](/guides/codex-integration) and
[model routing](/guides/model-routing) configuration. The path is:

```text
helper -> native Codex queue -> the selected thread's app-server
       -> the thread's configured provider -> OpenCodex, when already routed there
```

The helpers do not implement another provider router. They send only the target and text, not
model, account, service-tier, approval, sandbox or base-URL overrides. A built-in `openai`
provider routed to OpenCodex and a custom `opencodex` provider keep their existing configuration.
Pool/Direct selection, account bindings, provider credentials and admission checks remain owned
by OpenCodex and the serving daemon. Queue acceptance alone does not prove a provider was called.

Use the **same `CODEX_HOME` and compatible CLI/app-server** as the desktop installation.
`CODEX_HOME` defaults to `~/.codex`; another home can discover another daemon and thread store.
`OPENCODEX_HOME` is the proxy's home, not a substitute for `CODEX_HOME`. The helpers leave both
variables and both applications' configuration files unchanged. On PowerShell, native children
inherit the shell's filesystem location, including when `CODEX_HOME` is relative.

The proxy must already be running and the target thread must already use the intended route.
The helper does not start/sync/reconfigure OpenCodex, re-enable a disabled integration, or
silently replace a direct OpenAI route. It does not require toggling `codexDesktopAuthless`.
A remote OpenCodex provider URL is not the same thing as a remote Codex app-server: these helpers
use local daemon discovery, not automatic routing to a conversation on another computer.

These are **on-demand repository helpers**, not an installed `ocx queue` command or a dashboard
control. The npm package's file allowlist does not include `scripts/`; use a matching repository
checkout or the native `codex queue` command. This narrow fallback avoids adding a second
transport, persistent listener, account-state cache or usage-limit monitor to OpenCodex.

## On/off and normal-usage behavior

There is **no persistent enable/disable switch**: running the helper is the opt-in for one
submission. Merely installing/updating OpenCodex or keeping the scripts on disk does not run them.

| Situation | What this fallback does |
| --- | --- |
| Not invoked, whether quota is available or exhausted | Nothing: no process, timer, polling, background listener or helper-originated request. |
| Invoked normally while usage is available | Queues one ordinary message. It does not skip it just because the desktop composer is working. Normal provider usage/billing can apply when dispatched. |
| Invoked while only the composer is blocked | Attempts the same native queue submission. The configured route must still be authorized and available. |
| The actual provider has no capacity or authorization | Does not bypass that restriction or change provider/account; upstream execution can still fail after queue acceptance. |
| `-DryRun` / `--dry-run` | Selects a target and probes CLI help, but never submits text or checks account quota, daemon health or provider availability. |
| The usage gate later lifts | Use the normal composer again. There is no helper-specific setting to revert. |

To stop using the fallback, stop invoking it. Do **not** run `ocx restore` or disable the Codex
integration just to turn this helper off; that changes the normal OpenCodex routing too.
If you independently scheduled the command, disable that external schedule. Already accepted
queue items belong to Codex and may still execute: removing the script, exiting its process or
recovering quota does not cancel them. Inspect/remove unwanted items through the normal queue
controls in the same conversation. Do not send the same prompt in both the helper and composer.

## Check compatibility before sending

Prefer the app-bundled CLI; a separately installed `codex` on PATH may be older. Check
`codex queue --help` for `--thread` and `--message`. The helpers probe this CLI capability,
but only an actual request can verify the daemon's `thread/queue/add` support. If Codex reports
an unsupported queue method, save ongoing work before updating/restarting the matching
installation. The helpers never restart a daemon or retry with another server. Do not add
`--no-daemon` to a queue command. App/CLI updates can still change compatibility.

First open the intended conversation and confirm its project, model and provider. Prefer its
**explicit UUID**; the native CLI also accepts an exact session name:

```powershell
codex queue --thread 'my-project-review' --message 'continue with the next step'
```

From a repository checkout, the Windows helper can discover the bundled native `codex.exe`:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -Message 'continue with the next step'
```

On macOS/Linux, use Bash (including macOS's Bash 3.2):

```bash
bash scripts/codex-queue.sh --thread 'my-project-review' --message 'continue with the next step'
```

Pin a matching trusted binary with `-CodexExe 'C:\path\to\codex.exe'`,
`--codex '/path/to/codex'`, or `CODEX_EXE`. An invalid explicit selection fails instead of
silently picking another executable. On Windows use a native `.exe`, not an npm `.cmd` or
PowerShell shim, to keep message quoting out of `cmd.exe`. Queue-capable app bundles and
standalone layouts are tried before PATH. Automatic PATH discovery ignores empty and relative
entries rather than probing a CLI from the current project implicitly. A trusted local binary
can still be selected explicitly with `--codex './codex'` or `-CodexExe '.\codex.exe'`.
Configured installation roots and absolute PATH entries still need to be trusted by the operator;
this helper does not verify binary signatures. Discovery does not prove a matching app version.

### Private diagnostics and optional latest-thread discovery

A dry run hides executable paths, thread UUIDs/names and the message body by default:

```powershell
.\scripts\codex-queue.ps1 -Thread 'my-project-review' -DryRun
```

It reports CLI capability and target selection only, not successful server-side validation.
For legacy rollout-based stores, `-Latest` / `--latest` explicitly opts into a **latest-file
heuristic**. To see that selection, use an unredirected private terminal:

```powershell
.\scripts\codex-queue.ps1 -Latest -DryRun -ShowTarget
```

```bash
bash scripts/codex-queue.sh --latest --dry-run --show-target
```

`-ShowTarget` / `--show-target` requires a dry run and local terminal output. It reveals the
selected path and UUID/name only by this explicit request, escapes control characters, and
refuses redirected output such as CI capture. Do not use it in recorded/shared terminals or
post the output publicly. It never prints the message. Ordinary native Codex output during a
real submission is passed through and can contain identifiers; review it before sharing logs.

Latest discovery searches `CODEX_HOME/sessions` by modification time, with filename order as
a tie-breaker. It is **not the current desktop conversation** and can select another project
or a subagent. Verify the local preview, then send with the chosen explicit UUID. Latest can
also send when a message is provided, but remains a deliberate opt-in to this heuristic.

Recognized `rollout-*.jsonl` filenames contain a thread UUID, sometimes followed by
`_<rollout-uuid>`; the helper uses the first UUID. Malformed names are skipped. Missing or
unreadable stores fail without selecting from another home. Migrated/paginated-only stores
and remote-only conversations may have no matching local rollout; use an explicit UUID/name.

Keep the entire message in one argument. Bash accepts `--message '- start with this'` or
`-- '- start with this'`; PowerShell accepts `-Message '- start with this'`. Shell history and
local process listings can expose command-line text, so do not include credentials in prompts.

## Queued is not the same as executed

`Queued message ... for thread ...` confirms **queue acceptance**, not model execution or
completion. A busy thread may wait for its current turn or approval. In the inspected upstream
implementation, an unloaded saved thread can retain the message until another client resumes it.

Check the queue and activity in the **same conversation**. If it is not loaded, open it in the
app or use `codex resume <thread-id>` without adding the prompt again. Review pending approvals
and the queue state. Each queue invocation can create another item; after an ambiguous failure,
inspect before retrying. The helpers preserve the CLI exit status and never resend automatically.

The native CLI has explicit `--remote` options (see `codex queue --help`), distinct from assuming
the desktop's remote-control connection is reused. Keeping authentication configuration unchanged
does not repair unrelated authentication/network faults or guarantee remote-control continuity.

## Starting or resuming work without the composer

`codex exec '<prompt>'` starts a non-interactive task, **not** a message in the open desktop
thread. Check its working directory, provider, permissions and configuration.
`codex resume <thread-id>` resumes an explicit session. `codex resume --last` normally filters
by current working directory; `--all` disables that filter, while other eligibility filters can
still apply. A global selection is not necessarily the visible or newest filesystem session.
Prefer an explicit ID for ongoing desktop work.

## Scope and verification

This fallback leaves account entitlements and app files alone. It is not a provider-aware repair
of the composer/model picker, an automatic quota-recovery feature, or cleanup of unrelated
proxy/certificate changes from earlier experiments.

The original Windows probe (desktop `26.917.9434.0`) reported queue acceptance for a live thread
and an expected error for a nonexistent thread. That is not a general end-to-end inference,
unloaded-thread, remote-control or cross-platform guarantee. Upstream source was checked at
`7dae8c53d97e61cd774e4d6bcca5243c29ca615c`:

- [CLI queue options](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/queue_cmd.rs)
  and [app-server submission](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/tui/src/session_queue_commands.rs).
- [Loaded-thread queue dispatch](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/ext/queue/src/service.rs)
  and [resume selection options](https://github.com/openai/codex/blob/7dae8c53d97e61cd774e4d6bcca5243c29ca615c/codex-rs/cli/src/main.rs).

Run offline wrapper regressions with `node --test scripts/codex-queue.test.mjs` (Node 20+).
They use fake native CLIs and temporary homes, never real accounts or model requests. The
**Codex queue helpers** workflow runs these tests on Windows PowerShell 5.1 and PowerShell 7,
macOS system Bash, and Linux Bash; a missing required shell fails instead of silently skipping.
Configuration-preservation fixtures cover built-in/custom provider settings and both usage-state
values, not live OpenCodex routing. Validate real Desktop dispatch, provider success and
remote-control continuity separately on supported installations.
