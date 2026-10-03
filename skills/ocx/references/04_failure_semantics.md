# Failure semantics

What each exit code means, which failures are worth retrying, and which mean stop.

## Exit codes

`runCliAction` maps many management failures; the whole CLI does not share one
exit contract. Its common mappings and the main exceptions are:

| Code | Cause | Retry? |
|---|---|---|
| 0 | success | — |
| 2 | locally rejected usage in management handlers; also unsupported `doctor --json` | fix arguments |
| 64 | usage validation in `capabilities`, `ready`, `resolve` | fix arguments; no discovery/request for invalid input |
| 4 | HTTP 404 — the named account, provider, key, or route does not exist | no |
| 5 | HTTP 409 — conflict; a lock is held or state moved under you | inspect first; stale baselines require review |
| 1 | everything else: transport failure, 5xx, unexpected errors | depends on `reason` |

Two consequences worth internalizing:

**Exit 0 means no error was reported, not that a mutation happened.** Preview verbs
(`storage cleanup` without `--yes`) exit 0 after a read-only preview. Parse `--json` (or the
human summary) to see whether anything was written. Read saved/applied/skipped
fields and warnings as well; a successful save can leave live convergence pending.

**A local usage refusal is not a transport failure.** Fix the arguments rather than
retrying unchanged. Unknown root commands and unavailable explicit help topics use
exit 1; a capability route miss uses 4 even when an undeclared handler exists.

## Distinguishing "not running" from "failing"

```bash
ocx ready --json
```

Use readiness before live management. `pending` permits a bounded wait; `failed`
and `unreachable` need diagnosis. Offline help, local config and local Lab reads
still work without a proxy: do not start one just to perform those tasks. A ready
proxy can still refuse a route, serve an older version, or be the wrong role.
Check `status --json` and its `versionSkew` and target information.

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

1. Exit 2 or 64 → fix arguments. Never retry unchanged.
2. Exit 4 → distinguish a missing resource from a missing declaration. For a
   resource, list first (`account list`, `provider list`, `access key list`); for
   a declaration, consult family help. Do not retry the same lookup.
3. For a read or a confirmed pre-write contention refusal, wait the stated
   `Retry-After` interval and retry **once**. An exit 5 from provider apply or profile update requires
   fresh review, not a timed retry. Never repeat an uncertain or persisted write
   merely because its exit code is nonzero.
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


## Provider save and convergence failures

Live provider lifecycle, pacing and batch operations can return `success: true`
with a nonzero exit: the configuration was saved but `catalogRefresh` failed or
was skipped as busy, stale, refused or unavailable. Preserve both facts. Read back
with `ocx provider snapshot --json` (and pacing read for pacing changes), then
inspect the reported convergence issue. Do not resend an add/remove/apply to
repair catalog refresh. Null, absent or `not-requested` refresh does not mean
client synchronization occurred, even when the command exits 0.

Local add with `--sync --json` also really attempts synchronization after saving.
No running proxy returns `sync.status: "not-running"`, `sync.ok: false`,
`needsSync: true`, and exit 1. Refused or failed sync is nonzero too; no rollback
is implied. Applied sync clears `needsSync`; policy-skipped and catalog-only
outcomes leave it true. JSON is an output choice, not a dry-run flag.

A stale batch baseline returns HTTP 409 / exit 5. Obtain a fresh snapshot from the
same intended host/context, compare concurrent changes, and rebuild the next
document for review. Do not silently replace the baseline, auto-rebase, or retry.
Pacing scalar PATCH has no baseline check and can overwrite a concurrent edit;
use snapshot/apply for compare-and-swap. Batch removal requires `--yes` and does
not include single-provider DELETE's OAuth account cleanup.

Invalid/oversized input, interactive stdin, missing removal confirmation and
conflicting flags return exit 2 before mutation. Files must be regular UTF-8 JSON;
each read has a 4 MiB cap and 30-second deadline, and the combined batch request
also has a 4 MiB cap. Fix the input rather than retrying unchanged. Provider errors
use fixed safe messages and never expose arbitrary nested server bodies. An
unusable receipt or transport failure can mean the write outcome is unknown:
inspect the target rather than claiming rollback or trying a local fallback.

## Model and routing recovery

Local custom-model saves have opportunistic sync: no proxy yields
`sync.status: "not-attempted"`, `needsSync: true` and exit 0. Do not confuse this
with an explicitly requested provider `--sync` failing because no proxy exists.
Attempted failed/refused/incomplete custom-model sync returns nonzero after saving;
policy-skipped success can still exit 0 while needing sync. Local JSON removal
requires `--yes`; live removal always requires it and never falls back locally.

New live custom, picker, display-name and profile writes, plus combo set, return
1 with the saved receipt when catalog refresh is skipped, failed or degraded.
Display-name can recognize HTTP 503 with `saved: true` and failed refresh as this
partial result. Inspect current state; a nonzero exit does not mean rollback.
Other errors print fixed stderr messages, not JSON error envelopes. Unknown write
outcomes must not trigger automatic repetition.

For manual picker order, supply each routed public ID exactly once with the
required featured prefix. Native-inclusive saved order requires an explicit
reset/default decision before replacement; do not reset merely to suppress a
refusal. A changed observation before PUT returns 409/exit 5. Re-read status and
identities, review the list and resubmit only the intended edit. This recheck is
not CAS. Most-used refuses incomplete usage rather than ranking missing data as zero.

Profile update requires the original explicit revision and an editable-only
file. A 409/exit 5 means read show again and review concurrent changes; never
silently substitute a fresh revision, retry, or fall back to create. Create/update
may activate Lab and enabled automation, including upstream probes, so retrying
is not an observational operation. Deletion has no revision protection.

Combo target files cannot be combined with `--targets`. An incompatible retained
native alias can make `--native-alias off` refuse; clear that alias too only if
that is the intended change. `set` is an upsert without CAS. Statistics with
incomplete history can exit 0: preserve coverage limits and nullable measurements;
never convert the report into unsupported cost or savings claims.

## Account, settings and v2 boundaries

Unsupported pool fields or conflicting account selectors refuse before writing.
Null stored policy, effective state and inert pooling are different; do not turn
null into false or retry an unsupported setting. OpenAI per-account auto-switch
requires `--account`; omission retains pool scope. Unavailable quota activation
may return 409: inspect window availability, never enable paid credits or consume
a reset grant as recovery. Anthropic grant GET may read upstream but never spends.

Login options depend on the actual flow. Device-only browser flags, add-account
on reauth/Codex, or either new flag on native Kiro `--method` refuse before login.
Preserve flow identity on cancellation/expiry; do not restart or verify automatically.
Live OAuth logout failure never authorizes local credential deletion.

Memory/compaction set replaces a full block, not just supplied phase/scope fields.
Memory `{}` or clear/null restores existing routing without disabling the pipeline;
compaction clear restores ordinary compaction. Read back before fixing an unintended
scope. A settings write can be accepted yet return pending/unverified and exit 1.
Missing Ultra Fast read-back must remain unverified. Sidecar saved state and native
apply are separate; inspect ownership rather than replaying a refused apply.

v2 parse failures preserve local exit 1 and live exit 2. Advisory acknowledgment
is accepted only for explicit live mode; never auto-ack to bypass refusal. A 502
from live v2 may mean partial native application, not rollback. Local sync can
actually run without a discovered proxy port; void/malformed evidence exits 1 as
unverified. Inspect `v2 status` on the same local/live target before recovery.
Unknown state, saved state and client convergence must remain separate.
