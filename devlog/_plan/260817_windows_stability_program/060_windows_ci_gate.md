# 060 — Stage Windows back into CI (F3)

**Depends on:** stages 3 and 4 want 010-051 landed, because that is when a
Windows failure starts costing someone a merge or a release. Stage 1 needs only
the runner-policy decision below — which is a decision, not a phase, and should
be made today. Nothing else blocks it, and delaying it delays every phase that
wants its data.

## What "gate" can and cannot mean here

`dev` has no branch protection. `MAINTAINERS.md:121` is explicit that CODEOWNERS
requests reviews rather than enforcing them, and line 125 records that enforcing
any of it through branch protection is a separate decision that has not been
taken. `AGENTS.md` says the same about approval policy: enforced by convention.

So this phase cannot make Windows block a merge, and claiming otherwise would be
writing a plan against a repository that does not exist. What it can do:

- make Windows **run** on `pull_request` and `push`, so a red result is visible
  before a merge rather than never;
- make Windows **required by the release preflight**, which is real enforcement
  because `release.yml` reads run conclusions directly (stage 4);
- leave actual merge blocking as an explicit, separately authorized branch-
  protection change — out of scope for this unit and not something to configure
  without the maintainer deciding it.

Stage 3 below is therefore a convention gate. Stage 4 is a real one.

## Stages

**Stage 1 — run it, block nothing.** `platform-windows` runs on
`pull_request` and `push` with `continue-on-error: true`. Collect duration and
failure rate across at least a week of normal merges. Start now.

**Stage 2 — resize the shards.** The matrix is 4 shards over ~806 files, about
200 each. The 806/806 result came from batches of ~60 files because Bun 1.3.14
panics near 3.5GB RSS on larger runs, and CI-shaped shards have reproduced that
panic. Shard nearer the batch size that actually worked. This is a prerequisite,
not an optimization: a leg that fails on a runtime panic instead of a test
failure teaches everyone to ignore it.

**Stage 3 — remove `continue-on-error`.** Windows failures now fail the run and
are visible on the PR. Convention, not enforcement, per above.

**Stage 4 — close the release hole.** The aggregation job accepts `skipped` for
every job (`.github/workflows/ci.yml:769-772`). Once Windows runs on push, that tolerance must not
apply to it: assert `platform-windows` reached `success`. Without this,
`release.yml:181-201` keeps accepting a push-event run in which Windows did
nothing.

## Runner policy — the one decision stage 1 waits on

`select-windows-runner` (`ci.yml:85`) routes to a persistent self-hosted runner
when the repo variable `OCX_SELF_HOSTED_WINDOWS` is set, and push events are
exactly the trusted events that routing applies to. Push runs are also exactly
what the release preflight consumes. So "gate on hosted `windows-latest`" and
"keep the self-hosted selector as-is" cannot both hold.

Resolve it explicitly, one of:

1. **Hosted only for the gated legs.** Constrain the selector so `push` runs
   land on `windows-latest` regardless of the variable, and leave self-hosted
   for `workflow_dispatch` investigation. Clean, slower, costs more.
2. **Self-hosted allowed, with hygiene.** Keep the selector, and make the
   existing "Clean workspace (self-hosted only)" step (`ci.yml:571`) a hard
   requirement with a verified-clean assertion, since a persistent runner
   carries state between runs and that is what makes a green result untrustworthy.

Option 1 is the recommendation, and it is the only one that closes the
contradiction outright. Option 2 narrows it rather than closing it: the existing
cleanup step removes stale checkout files, not installed services, registry
state, tool caches, or anything else a previous run left on the machine — and
this product installs services and writes registry state as its normal
behavior. The `ci.yml:109` comment already says the variable is an operational
switch and not a security boundary; a release gate wants the boundary.

## Verify

```powershell
bun run prepush
gh workflow run ci.yml --ref <branch>
```

`bun run prepush` is required for CI and packaging workflow changes
(`.github/AGENTS.md:25`). Workflow edits also require the security review named
in `MAINTAINERS.md` — release automation and workflow permissions are on that
list. Each stage is verified by its own run history.

## Risk

High if rushed, low if staged. The failure mode is a red leg everyone learns to
override. Stage 1's data is what says whether stage 3 is safe.
