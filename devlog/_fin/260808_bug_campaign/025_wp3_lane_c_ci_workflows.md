# WP3 — lane C: the CI/workflow stack

Three PRs, and the interesting result is that the two open ones needed opposite
treatment despite looking similar on the board.

| PR | State entering WP3 | Outcome |
|----|--------------------|---------|
| #1255 harden comment-driven review workflows | merged (`0993c53ae`) | already done |
| #1185 bind Windows shard assertion | draft, CI **failure**, 324 behind | **republished** as #1301 |
| #1259 fail-closed aggregate-check evidence | draft, CI `cancelled`, 20 behind | **held** with a blocker |

## #1185 — a red PR that was right

Its Cross-platform CI at `bff31d1e0` genuinely failed, which is the kind of
signal that gets a stale draft closed. It should not have here.

The PR touches exactly one file, `tests/ci-workflows.test.ts`, and that file
only reads workflow YAML as text. The crash was somewhere else entirely:

```
##[group]tests/autostart-health.test.ts:
# Unhandled error between tests
error: EEXIST: file already exists, epoll_ctl
      at new WriteStream (internal:fs/streams:244:58)
# then
error: Cannot call describe() after the test run has completed
      at tests/autostart-health.test.ts:23:1
```

2142 pass / 1 fail / 2 errors. A Bun-level failure while loading a file the
diff cannot reach, with the `describe()` error as collateral.

My first write-up called this "an fd leak from a preceding test file". The
audit removed that: the log shows *where* the crash happened, not *why*, and I
had asserted a mechanism the evidence does not carry. Recorded as an unrelated
Bun/runner load failure, root cause unknown.

### What the patch actually buys

The existing assertion used `.includes()` on the Windows step's `run` text, so
the command counted as present anywhere in the script — inside an `echo`, or in
a comment. Measured on current `dev` by mutating `.github/workflows/ci.yml:492`
so the Windows leg prints instead of runs:

| Mutation | `dev` today | with #1185 |
|----------|-------------|------------|
| `run: bun test …` → `run: echo bun test …` | 125 pass / 0 fail | 124 / **1 fail** |
| add `if: false`, command unchanged | 125 pass / 0 fail | 124 / **1 fail** |

The second row is mine. The audit pointed out that binding the assertion to an
executable *line* still permits an unreachable *step*: the exact command under
`if: false` runs nothing and satisfies the contributor's check. Both mutations
leave `dev` green today, which is the whole argument for landing this.

Published as #1301 with the two commits separated — `364b358` carries luvs01's
`Co-authored-by`, `f09ef15` is mine with no trailer and is called out in the PR
body.

## #1259 — the right idea with a hole in its central claim

#1259 removes `pull_request.paths` and moves scope gating into the existing
`changes` job, so a docs-only PR gets an explicit passing `ci` check instead of
no check at all. That problem is real: no check is harmless until the check
becomes required, and then it is a PR that waits forever.

The blocker is in the property the PR is named for. `changes` exposes
`ci: ${{ steps.filter.outputs.ci }}` with no validation, and every expensive job
gates on `needs.changes.outputs.ci == 'true'`. If `changes` **succeeds** while
that output is empty or malformed — an action upgrade renaming an output, a
filter-syntax slip — then:

1. every expensive job evaluates `'' == 'true'` and is skipped;
2. the aggregate gate treats `skipped` as a pass, deliberately, because that is
   how it recognises trigger-scoped jobs;
3. `ci` reports green having tested nothing.

`changes` *failing* is handled — the aggregate catches it. It is `changes`
succeeding with an unusable output that slips through, and today's `paths:`
trigger makes that unreachable, so the PR turns a non-issue into the single
point of truth without hardening it.

I suggested a validation step on the PR — and got it wrong on the first pass by
writing `case "${{ steps.filter.outputs.ci }}"`, interpolating the expression
straight into shell. That is the injection shape this repository's workflow
hardening exists to prevent. Low risk from a SHA-pinned action, but wrong, and
corrected publicly to pass the value through `env:` so bash sees data.

I also claimed #1265 and #1259 would conflict in `enforce-pr-target.yml`. I had
compared branch positions, not hunks. Corrected to "may conflict; decide the
integration order".

**Disposition: held, not approved.** It changes when CI runs at all, which
`MAINTAINERS.md` puts in the security-review class, and I offered to implement
the validation step rather than making the author respin.

One thing the audit checked that I had not: whether removing the path filter
widens exposure on the self-hosted Windows runner. It does not — PR Windows
stays `workflow_dispatch`-only. But it does make the aggregate check
security-critical, which is exactly why the output needs validating.

## Faults recorded

- Asserted a mechanism (fd leak) the log did not support, when "root cause
  unknown" was the honest reading.
- Suggested a workflow snippet with an expression-injection shape while
  reviewing a security-class change.
- Claimed a conflict from branch divergence without looking at the hunks.

---

# The "flake" I called five times

#1301's CI came back `cancelled` with `test 4/4` hung. I issued
`rerun-failed-jobs`, as the four-state rule says, and asked the reviewer whether
I was now pattern-matching to "flake" too readily. The answer was yes, with a
detail I had not checked: attempt 1 was **not** a superseded run. `test 4/4` ran
its Test step for a full 15 minutes and was killed by the job timeout.

The retry then did the same thing — 15:28:02Z to 15:43:17Z, cancelled at 15
minutes 15 seconds. Two real timeouts at the same head.

So I stopped rerunning and investigated instead. The shape is identical every
time: output stops immediately after a test that starts a proxy listener,
silence for ~14 minutes, then `Terminate orphan process: pid (NNNN) (bun)` in
cleanup. In #1301 the last line was

```
[web-search-loop] cancelled — 1 real searches, 0 placeholders, 13ms
(pass) routed Claude requests give OpenAI sidecars main auth without leaking it to the routed provider
```

from `tests/claude-messages-endpoint.test.ts` — which passes locally in 2.7s
(38/38), and the full suite is 10009 pass. The stall is *after* the assertion,
so teardown or the next file's setup is the suspect, not the test.

Five occurrences today across four unrelated branches **and `dev` itself**:

| Run | Branch | Shard |
|-----|--------|-------|
| 31263738953 | `codex/260808-1185-windows-shard-assertion` | `test 4/4`, twice |
| 31255199569 | `fix/windows-powershell-popup` | `test 2/4` |
| 31258815611 | `codex/260808-1195-unbound-quota-unknown` | `test 3/4` |
| 31152916419 | `agent/test-windows-ci-shard-command` | `test 3/4` |
| 31259450263, 31259447622 | `dev` | various |

The varying shard argues against one bad test. The one instance that did not
hang is the clue: it crashed with `EEXIST: file already exists, epoll_ctl` in a
Bun `WriteStream` — a descriptor registered with the event loop twice, which is
the same resource-lifecycle fault a deadlocking registration would produce.

Filed as **#1302** with the run inventory, and #1301 is **held** rather than
rerun to green.

## Why this is the fault worth recording

Three of the four cancelled runs *did* go green on retry, so "rerun until green"
worked every time and produced merges I still stand behind. The problem is that
it works equally well on a genuine hang introduced by a real change. I applied
the rule correctly — `cancelled` means rerun — and used it to avoid looking at
five instances of the same failure.

What broke the loop was being asked to justify the call rather than state it.
"It's flake" was a conclusion I never had evidence for; I had evidence that
retrying made it go away, which is a different claim.
