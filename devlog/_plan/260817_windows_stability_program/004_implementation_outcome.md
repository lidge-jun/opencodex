# 004 — Implementation outcome, phases 010 / 020 / 030 / 031

Shipped as a stacked chain against `dev` on 2026-08-18. This records what
landed, what the code review changed, and what the plan got wrong.

## The stack

| PR | Phase | Base | Commit |
|---|---|---|---|
| [#1949](https://github.com/lidge-jun/opencodex/pull/1949) | this unit | `dev` | `f9cb0fcd4` |
| [#1944](https://github.com/lidge-jun/opencodex/pull/1944) | 010 | `dev` | `393d72a77` |
| [#1945](https://github.com/lidge-jun/opencodex/pull/1945) | 020 | #1944 | `a3169db77` |
| [#1946](https://github.com/lidge-jun/opencodex/pull/1946) | 030 | #1945 | `c5c6644d7` |
| [#1947](https://github.com/lidge-jun/opencodex/pull/1947) | 031 | #1946 | `fcc9e5022` |

Each guard was driven red before its fix. 010's sweep reported
`["service.ts"]`; 020's no-private-matcher assertion failed for both files.

## What the code review changed

An independent reviewer took three rounds and found six blockers. Every one was
verified against the tree before acting, and every one was real.

**The counters lost the error code.** The first implementation keyed them by
publisher alone, so EBUSY from a scanner, EACCES from a permissions problem and
EPERM from a lock collapsed into one number. That defeats the reason the
counters exist. Now keyed `publisher:CODE`.

**Phase 031 leaked into phase 030.** The extracted module arrived carrying
`ReplacePublisher`, the counters and the read/reset API — telemetry behavior in
the PR that was supposed to be a pure move, and without its tests. Stripped back
out; 030 is now the loop and nothing else.

**The wrapper tests proved nothing.** They asserted the generated PowerShell
*contained* `IndexOf`, `before` and `after`. A broken substring matcher would
keep all three tokens and pass. Rewritten to port the rule to JS and run real
command lines through it — this home's wrapper, another home's path, a longer
path ending with ours, an unrelated process naming the file — with a separate
test pinning the port to the shipped script so it cannot silently diverge. The
old `-like` rule kills all three negative cases; the token rule kills none.

**The sweep was half done.** `030` said to convert every durable publisher and
converted two. Six more were left: `claude/agents-inject.ts`, both Lab
automation writers, `lab/ledger/purge.ts`, and — found only in the second round
— `storage/cleanup.ts` and `tray/windows.ts`. All eight now use the helper. The
three remaining `renameSync` calls in `storage/cleanup.ts` are directory
relocations, a different problem, and the commit says so.

**One publisher was mislabelled.** `storage/cleanup.ts` called the helper
without a label, so its retries would have been reported as `config`. Caught
only because the reviewer read the default argument rather than the call site.

## What the plan got wrong

`031` claimed `privacy:scan` would enforce the fixed-literal publisher label.
The plan audit had already corrected that once — the scanner reads file text and
cannot see a runtime value — and the closed union is what actually enforces it.
Worth noting that the same claim had to be caught twice, in the plan and again
in the code.

`030`'s instruction to "sweep `src/` for remaining `renameSync` calls" read as
complete and was not. A phase that says "sweep" should name the expected count
or the command that produces it, or the sweep silently becomes whatever the
implementer happened to notice.

## Verification

- `bun run typecheck` clean at every commit
- `bun run privacy:scan` passed
- Full suite in 60-file batches over 809 files: 3 residual failures, all
  pre-existing or contention-only. `codex-app-server-processes` memo case
  reproduces on clean `origin/dev`; `command-code-provider` and
  `issue-452-empty-503` pass in isolation. `native-codex-toggle` panics Bun
  1.3.14 at teardown after all four of its tests pass, also on clean `dev`.
- CI: #1944 and #1949 fully green; the stacked children green apart from slow
  macos legs still running at time of writing.

## Not done

Phases `040`, `050`, `051`, `060`, `070`, `080` remain open. `050` needs its
implementation shape decided (state file vs delayed expansion) and the CI phases
need the runner and gating decisions `060` names. Nothing here changes the
central point in `000`: Windows still does not gate a merge or a release.
