# Failure semantics

What each exit code means, which failures are worth retrying, and which mean stop.

## Exit codes

Set in one place (`runCliAction`), so every verb agrees:

| Code | Cause | Retry? |
|---|---|---|
| 0 | success | — |
| 2 | usage error: bad, missing, or unknown arguments | no; nothing was sent |
| 4 | HTTP 404 — the named account, provider, key, or route does not exist | no |
| 5 | HTTP 409 — conflict; a lock is held or state moved under you | usually yes |
| 1 | everything else: transport failure, 5xx, unexpected errors | depends on `reason` |

Two consequences worth internalizing:

**Exit 0 means no error was reported, not that a mutation happened.** Preview verbs
(`storage cleanup` without `--yes`) exit 0 after a read-only preview. Parse `--json` (or the
human summary) to see whether anything was written. A command that failed will not exit 0.

**Exit 2 means nothing was sent.** A usage error is rejected locally, before any request. Retrying
the same arguments produces the same result; fix the arguments.

## Distinguishing "not running" from "failing"

```bash
ocx ready --json
```

`ready` is the discriminator. If it fails or reports `ready: false`, nothing else will work and the
answer is to start or wait for the proxy. If `ready` is true and one specific verb fails, the
problem is that route or its arguments — not the proxy.

A transport failure exits 1 and names the underlying cause (connection refused, DNS, TLS). Those
used to be indistinguishable; they are now reported separately, so read the message.

## Named reasons worth branching on

| Reason / code | HTTP | Meaning | Action |
|---|---|---|---|
| `oauth_mutation_busy` | 503 | another credential write is in flight | wait `Retry-After` (1s), retry once |
| `catalog_busy` | 503 | a model-catalog gather is in flight | wait `Retry-After` (1s), retry once |
| config-mutation lock reason | 503 | a config write holds the lock | retry shortly |
| credential-conflict reason | — | the install is structurally broken | run `ocx doctor`; do NOT retry |
| `stale_preview` | 409 | a storage cleanup digest no longer matches | re-run the preview |
| `dest_exists` | 409 | a trash restore target already exists | resolve the file, then retry |
| `codex_busy` | 409 | Codex is holding `state.sqlite` | retry after Codex quits |
| `storage_mutation_busy` | 409 | another cleanup or restore is running | retry shortly |

The two 503s carry `Retry-After: 1` from the server, so the wait is specified rather than guessed.

The credential-conflict case is the one to stop on. It is not contention — it is a broken install,
and repeating the call produces the same error indefinitely.

## A retry policy that does not spin

1. Exit 2 → fix arguments. Never retry unchanged.
2. Exit 4 → the target does not exist. List first (`account list`, `provider list`, `access key
   list`) rather than retrying.
3. Exit 5 or a 503 with `Retry-After` → wait the stated interval, retry **once**. If it fails the
   same way twice, report it instead of looping.
4. Exit 1 with a credential-conflict reason → run `ocx doctor` and report. Do not retry.
5. Exit 1 otherwise → read the message. A transport failure may be worth one retry; an unexpected
   5xx is worth reporting.

The rule behind all of it: retry contention, never retry a broken state. A loop that retries a
credential conflict looks like progress and produces nothing.

## Service and launchd semantics (macOS)

Two states that read as failures and are not. Both come from the same change: a repair of a
healthy job must not be an outage.

**`ocx service repair` printing `service is already loaded from the current plist; nothing to
do.` is success.** The repair renders the plist first and compares it. When the rendered
bytes match the file, the token file is unchanged, and `launchctl print` reports the job
loaded from that plist, launchd is not touched at all. Do not retry it, and do not escalate
to `ocx service uninstall`.

**`ocx service restart` is NOT an alias of `repair` — it always restarts.** It runs the same
refresh, and when nothing was reloaded (the healthy, unchanged job above) it restarts the
loaded job in place with `launchctl kickstart -k gui/<uid>/com.opencodex.proxy`, verifies the
job with the same probe, and prints `service restarted (launchctl kickstart -k …)`. So when a
restart is the actual requirement — after a change to `unauthenticatedLoopbackListener`,
`hostname` or `port` — tell the operator `ocx service restart`, not a hand-written launchctl
command. Linux restarts through `systemctl --user restart` and Windows stops then starts the
task, on either verb.

A bare `ocx service` still selects `repair`, so it will not bounce a healthy hub. Reserve
`ocx service repair` for a job loaded from an older plist, or not loaded at all.
`launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy` is still a correct manual fallback
and the failure path names it, but do not lead with it. `ocx restart` is a different verb
entirely: it restarts a proxy process, not the service the manager supervises.

`ocx service status` has four launchd verdicts, and only two of them call for a repair:

| Summary | Meaning | Repair? |
|---|---|---|
| `installed and loaded` | A domain answers and runs the command this plist bakes | no |
| `installed and loaded from an OLDER plist` | Running, from a definition that no longer matches | yes |
| `installed, not loaded` | Every domain answered "absent" — proof the job is gone | yes |
| `installed; launchd state could not be verified` | `launchctl` could not be asked | **no** |

The last row is the one to get right. It is not evidence the service is down: the command
itself recommends nothing, and a probe that could not run never marks a running proxy as
dead. Reporting it as "not loaded" is what used to send operators to repair a serving hub.
If the proxy answers `ocx ready`, the hub is up regardless of what the probe could see.

## A hub-gated skip is not a failure

`ocx sync`, `ocx sync-cache`, `ocx ensure` and `ocx restore back` on a `runtimeRole: "hub"`
can exit 0 having deliberately written nothing:

> This machine is a hub; it does not rewrite its own Codex/Grok/Claude configs unless
> unauthenticatedLoopbackListener is enabled.

That is the hub gate, not the operator's `clientIntegrations` toggle, and not a lock
conflict — there is nothing to retry. Either enable the listener and restart the proxy
(`ocx service restart` on a service install), or
report that this hub leaves its own clients native. Details:
[05_remote_hub.md](05_remote_hub.md#the-hub-gate-on-the-hubs-own-clients).

## Destructive verbs fail closed

`storage trash restore` and `storage policy run` exit 2 without `--yes` and send no mutating
request. `storage cleanup` without `--yes` previews and exits 0; only `--yes` deletes.

`storage cleanup` also refuses locally if the preview returned no digest, rather than sending an
empty one and getting a 400 that looks like a bug in the verb.

## What no exit code will give you

Starring the repository has no CLI verb and no failure code, because it has no CLI path at all. It
spends the user's GitHub identity and the server requires a dashboard session for exactly that
reason. `ocx inspect star` reads status; if starring is wanted, ask the user.

