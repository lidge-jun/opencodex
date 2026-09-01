# 031 — wp3 outcome: #3134 landed, and two premises corrected

`b14b741dc`, merged 2026-09-01, squash. Seven commits from #3104 rebased onto `dev`,
content-identical by `git range-diff` (all seven `=`), `tests/service.test.ts` 191 pass / 0 fail.

Closed: issues #3009 and #3064, PR #3104. Credit comment left on #3067 (already closed).

## Correction 1 — #3128 did not fix the WebSocket flake

`000_plan.md` built its central argument on this: that #3104/#3109/#3112 were red only
because of `server local API auth > websocket passthrough refreshes pool auth for each
response.create turn`, and that #3128 (`33d32b6a3`) had fixed it, so any rebased head would
be green.

The first half held. The second did not:

```
$ git merge-base --is-ancestor 33d32b6a3 HEAD && echo "3128 IS in carry base"
3128 IS in carry base
```

and PR #3133's first run failed that exact assertion anyway.

#3128 changed three lines of `tests/server-auth.test.ts`: it pinned the account namespace so
both turns route through `ws-refresh/gpt-test`. That addresses account selection. The failure
is a **clock** race:

- the credential is saved with `expiresAt: now + 120_000` (`tests/server-auth.test.ts:2239`)
- `REFRESH_SKEW_MS` is `60_000` (`src/codex/account-store.ts:22`)
- the refresh predicate is `cred.expiresAt > Date.now() + REFRESH_SKEW_MS` (`:717`)
- `startServer(0)` runs at `:2247`, and `Date.now` is not pinned until `:2251`

So the server does real work while reading the real clock, with only 60s of margin. When the
first turn's read lands on the wrong side, the refresh fires early and `seenAuth[0]` is
already the new token. **The failure diff is always the first element only** — never the
second — which is the signature of an early first refresh rather than a missing second one.

`260901_release_train_2390/070_outcome.md` diagnosed this correctly and named the ordering as
the mechanism. What was wrong was concluding that #3128's account pin implemented that
diagnosis. It did not; the pin and the diagnosis are about different things.

Still open. Not this train's to fix — but it must stop being cited as fixed, because that
citation is what let a red matrix read as expected noise.

## Correction 2 — `windows-schtasks` was infrastructure, and proved something else

The rebased branch failed `windows-schtasks` on its first Service-lifecycle run. This is the
one job where a failure could plausibly be the change, since the change is the Windows service
path. It was not:

| head | `windows-schtasks` |
| --- | --- |
| `181795b13` | success |
| `5ea32ad00` | failure |
| `5ea32ad00` (rerun) | success |

`git diff 181795b13 5ea32ad00 --stat` is `base.txt | 1 -`. Nothing under `src/`. The same
tree failed and then passed.

The log is worth keeping for a different reason:

```
⚠️  Service installed, but no proxy answered on port 10199 within 45s.
```

That is the new Windows budget running on a real runner — direct activation evidence for the
#3009 fix, from a job that was failing. It is also live evidence for the #3039 residual:
the message prints the **constant**, not the measurement.

## #3039 closed itself

`030` was amended to keep #3039 open, since #3134 replaces its elapsed-time diagnostic
(`Math.round((elapsed() - startedAt) / 1000)`) with the configured budget
(`Math.trunc(healthBudgetMs / 1000)`).

The author closed it at `2026-09-01T04:17:43Z`, by their own hand — the timeline names
`ntdatt812`, not this train. The comment recording what was not carried landed anyway, so the
residual is on the record where someone picking it up will find it. Their PR, their call.

## Contamination, twice

Both carry branches picked up a commit authored `OpenCodex Test <test@opencodex.invalid>`
adding `base.txt`, and both times it rode along on the first push. Root cause:
`tests/test-runner.test.ts` calls `commitFixture(cwd, "n", "base\n", "base")`, which makes a
**real commit in whatever worktree the suite runs in**. Running the full suite inside a carry
worktree therefore mutates the branch under test.

Both were reset to the clean tip and force-pushed before review. Worth fixing at the source —
a test that commits into the developer's checkout is a trap that will catch someone else.
