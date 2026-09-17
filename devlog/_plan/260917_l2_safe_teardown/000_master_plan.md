# 000 — Safe teardown and honest settings application

- Unit: `260917_l2_safe_teardown`
- Opened 2026-09-17
- Base: `origin/dev` = `f1dfda8e48`
- Issues: #4812 (parent), #4809 (child)
- Class C4 — writes `$CODEX_HOME/config.toml`, decides teardown outcome, and
  touches the conversation-history safety boundary.

## Objective

Close the question "can a user turn OpenCodex off and get their original
environment back?" Today they cannot, in two different ways.

#4812 is a deadlock. The Codex history preflight refuses the whole config
restore whenever the Codex state store has a `history_mode` column, which
every current Codex build has. `ocx restore`, `ocx stop`, and `ocx uninstall`
all funnel through that refusal, so the proxy can be removed while
`~/.codex/config.toml` still routes at `127.0.0.1:10100`. The guard exists to
keep `opencodex`-tagged threads resolvable, but once the proxy is gone those
threads fail at request time anyway — and now every native Codex invocation
fails too. The protection protects nothing and costs everything.

#4809 is a configuration lie. `--desktop-authless` and `--client-compaction`
persist to `config.json` and report success, but the injected
`~/.codex/config.toml` does not change until a separate `ocx sync`. On a
non-loopback bind the authless flag is silently dropped altogether while the
API still reads back `true`. Nothing tells the user that the flag also moves
the auth source — whether the Codex app presents `~/.codex/auth.json`.

Both are the same underlying defect: **the stored value, the effective value,
and the work still owed are collapsed into one answer.** This unit separates
them.

## Delivery shape

Two stacked pull requests, in order:

| PR | Issue | Branch | Base |
|---|---|---|---|
| parent | #4812 | `codex/restore-routing-without-history` | `dev` |
| child | #4809 | `codex/settings-apply-and-effective-state` | the parent's head branch |

`enforce-target` admits a stacked child whose base is an open parent's head
branch. The child is retargeted to `dev` after the parent squash-merges; the
host directs that step, not this lane.

## Constraints

- **No local verification of any kind.** `bun test` (in any form),
  `bun run test`, `bun run test:changed`, `bun run typecheck`, `bun x tsc`,
  `bun install`, `bun run build:gui`, and running `ocx` are all forbidden for
  this unit. A local suite has previously deleted a real `~/.opencodex`.
  Verification is static reasoning plus hosted CI at the exact head.
- Pushes use `git push --no-verify`; the pre-push hook runs the local suite.
- This lane never merges, never pushes to `dev`, and never rebases unasked.
  The lane ends at "PR open with exact-head CI evidence".
- No flake management. No widened timeouts, added retries, platform skips, or
  masking. The Windows job is dispatch-only; a Windows-affecting change is
  reported to the host rather than dispatched here.
- **Paginated rollout bytes and thread rows stay untouched.** The native
  writer remains the only writer of that shape. Nothing in this unit relaxes
  `history_paginated_requires_native_writer` as a guard on *history*.
- Repository artifacts — commits, PR bodies, issues, reviews, these docs — are
  English. Security analysis that is not already public goes to `.tmp/`, never
  here.

## Work-phase map

| wp | Doc | Output |
|---|---|---|
| wp0 | this file | objective, topology, completion criteria |
| wp1 | `010_upstream_resolution_facts.md` | what codex-rs actually does with a provider id, and what that forces |
| wp2 | `020_issue_4812_contract.md` | the degraded-restore contract and its seam |
| wp3 | `030_issue_4809_contract.md` | stored / effective / pending separation for the two switches |
| wp4 | `040_verification.md` | static-proof obligations and hosted-CI evidence plan |

## Completion criteria

Shared across both pull requests:

1. Every surface that reports one of these settings distinguishes three
   things: the **stored** value, the **effective** value actually in force,
   and whether **further action** is required to reconcile them.
2. Repeating `restore`, `stop`, and `uninstall` in any order never damages
   user-owned configuration and never mutates Codex conversation history.
3. A partial outcome is never reported as full success, and no path ends with
   a failed restore that leaves the client pointed at a dead address.

Parent (#4812):

- `history_paginated_requires_native_writer` no longer refuses the config
  half of a restore. It selects a **degraded restore**: OpenCodex-owned root
  routing comes out, `[model_providers.opencodex]` stays, history is skipped
  rather than attempted.
- Every other preflight reason keeps its hard refusal and its compensating
  rollback, unchanged.
- `ocx restore --remove-codex-provider-table` performs the full removal for a
  user who accepts that `opencodex`-tagged threads stop opening. It is never
  the default, and it states the consequence before acting.
- `ocx uninstall` on a paginated home completes with native Codex working,
  names the retained table and the exact lines, and exits 0. It no longer
  records the config restore as a failure that blocks local-state cleanup.
- `ocx status` reports retained-table residue instead of leaving it invisible.

Child (#4809):

- Flipping either switch through the settings API or the CLI applies the
  injected `config.toml` inline when the proxy is live and the integration is
  enabled; the response says whether it applied and, if not, exactly why.
- The response reports the **effective** `codexDesktopAuthless`, not only the
  configured one, with the reason when the two differ.
- Both surfaces state the auth-source consequence — whether the Codex app will
  present `~/.codex/auth.json` — at the moment of the change.
- The stale comment at `src/server/management/config-routes.ts:600-601`, which
  asserts the opposite of what the code does, is corrected.

## Terminal outcomes

- **DONE** — both PRs open, exact-head CI recorded, criteria above hold.
- **BLOCKED** — recorded here with the blocking evidence; the lane does not
  work around a gate by weakening it.

## Prior art in this repository

`devlog/_plan/260914_codex_history_preflight_scope/` narrowed the same guard
on the apply direction and explicitly left this open:

> "The uninstall deadlock on an already-paginated home remains open follow-up;
> a later fix needs a keep-the-table seam on the restore path."

That is what `020` specifies.
