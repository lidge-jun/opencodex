# 011 — WP1: release-candidate selection under a moving branch

> **SUPERSEDED for the shipped release. The RC below (`dc4dd45b0`) was the
> WP1 choice while the train was blocked on the security gate. After the
> fix-first decision, WP4/WP5 remediation landed and `dev` was pushed to
> `9c051342d`, which is the RC this train actually released.** The analysis
> below is kept because its root cause is still true and still constrains any
> future train. What changed, and what it invalidates, is recorded in
> "Re-pick after remediation" at the end of this file.

The RC rule in `010` is "the newest `dev` commit holding a completed successful
Cross-platform CI run on its exact SHA". Applying it required understanding why
the newer heads keep failing to produce one.

## What actually happened

`dev` moved four times during this unit, roughly every twenty minutes:

| # | SHA | Merge | Exact-SHA Cross-platform CI |
|---|-----|-------|------------------------------|
| 1 | `dc4dd45b0` | #1368 | run **31352564082 SUCCESS** — 4/4 Linux shards, macOS `10526 pass / 0 fail` |
| 2 | `277354073` | #1398 bounded live sideband websocket frames | run 31354347276 FAILURE (macOS only) |
| 3 | `0a76ee854` | #1396 bounded reset-credit lookup responses | run 31355442090 FAILURE (macOS only) → rerun → **CANCELLED** |
| 4 | `2beeea654` | #1010 per-model cost overlay | run 31356461382 in progress |

## Root cause of the cancellation

The authorized rerun of run 31355442090 did not fail on its merits. It was
killed by policy:

```yaml
# .github/workflows/ci.yml:52-54
concurrency:
  group: cross-platform-ci-${{ github.ref }}
  cancel-in-progress: true
```

The group key is `github.ref` — the *branch*, not the commit. When #1010 merged
at 04:44:57Z, the new `dev` run superseded the in-flight rerun on the older
commit. On a branch merging a PR every ~20 minutes, and with a macOS suite that
takes longer than that, **an older `dev` commit can rarely be re-driven to
green**: any rerun races the next merge and loses.

This is not a defect to fix in this unit, and it is not #1302 (that is the
15-minute shard hang; this is an immediate supersession). It is a property of
the branch policy that any release train has to plan around.

## Consequence for the RC rule

"Prefer the live head" is unachievable on a branch this active unless the
maintainers freeze merges for the duration of a release. This train has no
authorization to freeze `dev` or to ask contributors to stop.

Two honest options remain:

1. **Release from `dc4dd45b0`** — the newest commit with a genuine green
   exact-SHA gate. Cost: omits #1398, #1396, #1010.
2. **Wait for a head that goes green on its own first run** — unbounded in
   time, since the macOS Bun 1.3.14 segfault is currently hitting a majority of
   runs and each failure needs a rerun that the next merge cancels.

Option 1 is chosen. **RC = `dc4dd45b04b2564a207b72f9c761a93e631b5299`.**

## Why omitting three commits is acceptable here

Audit blocker 2 correctly objected to calling #1398 negligible. Re-examined
with the full set:

- **#1398** — byte/frame ceilings on live sideband websocket frames. Defensive
  bound; no linked user issue.
- **#1396** — 64 KiB cap on reset-credit lookup responses before parsing. Same
  class: hardening a parse path against an oversized upstream response.
- **#1010** — per-model cost overlay. A user-facing *feature*, contributed by
  harryzhou2000, not a fix.

None resolves an open user-reported defect: no open issue in `020` names any of
them as its fix. They are hardening and enhancement, and they ship in the next
train, which will be small and fast precisely because this one drains the
backlog.

Against that, the alternative is publishing from a red gate or waiting
indefinitely. `release.ts` would refuse the first, and the second is not a
release.

**Risk accepted and recorded here for the owner:** v2.12.0 ships without
#1398, #1396, and #1010. If the owner would rather hold the train for those,
the correct sequence is to freeze `dev` merges, let one head go green, and
re-run this work-phase against that head — the rest of the runbook is
unchanged.

## Verification of the chosen RC

```
$ gh run list --commit dc4dd45b04b2564a207b72f9c761a93e631b5299
Cross-platform CI       success   31352564082
Enforce PR target       success   31353241031
PR hygiene              success   31353240929
PR Labeler              success   31353240939
```

Per-job (independently confirmed during the round-1 audit): all four Linux
shards passed; the macOS suite reported `10526 pass / 7 skip / 0 fail`; the
Windows full shards were skipped by the runner-selection job, while the
separate Windows keyring and npm-global smoke jobs passed. Local gates on the
same tree: `bun run typecheck` exit 0, `bun run test` 10,526 pass / 0 fail,
`bun run privacy:scan` passed.

## Re-pick after remediation — RC = `9c051342d`

The security gate returned BLOCK, the owner chose fix first, and the
remediation work-phases (WP4 SEC-02, WP5 SEC-01) plus eight rounds of
re-review produced 20 new local commits. Pushing them moved `origin/dev` from
`0de4fd2d7` to `9c051342d`, and a release must ship the remediated tree — the
whole point of the fix-first decision. So the RC is re-picked:

**RC = `9c051342d7ff7ad81b71911e359ad5935eaaf235`.**

Delta against the superseded RC: `git rev-list --count dc4dd45b0..9c051342d`
is **41 commits**, `git diff --shortstat` is **120 files, +8,520 / −225**.

### This voids the omission risk acceptance above

The section "Why omitting three commits is acceptable here" asked the owner to
accept shipping without #1398, #1396, and #1010. That acceptance is now **moot**
— all three are ancestors of the new RC:

```
$ git merge-base --is-ancestor 277354073 9c051342d   # #1398  -> exit 0
$ git merge-base --is-ancestor 0a76ee854 9c051342d   # #1396  -> exit 0
$ git merge-base --is-ancestor 2beeea654 9c051342d   # #1010  -> exit 0
```

Nothing is being omitted from this train, so no risk acceptance is required for
it. `010`'s "Out of scope" line about #1398 is stale for the same reason.

### Evidence that does NOT carry over

Every gate result recorded against `dc4dd45b0` — the exact-SHA CI run
`31352564082`, the `10,526 pass` suite, the merge dry runs — describes a tree
that is 120 files different from what ships. None of it is reused. The RC's own
gates are captured in `013_release_record.md`.

### What still holds from the analysis above

The branch-keyed `concurrency` group is unchanged, so an older `dev` commit
still cannot reliably be re-driven green while merges continue. The difference
this time is that the RC *is* the live head rather than a commit behind it.
