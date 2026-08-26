# 070 — wp4b: land the exactly-once terminal recorder for PR #2433

## Why this is its own work-phase

wp4 closed with #2433 held, not merged. The blocker was real and the PR was
otherwise complete, so the correct move was to build the missing piece rather
than hand a maintainer's finished work back over a seam they had no reason to
suspect. That build is this work-phase.

## The change

Branch `codex/fix-2433-exactly-once-terminal`, based on `origin/dev` at
`ed719b568`. Three commits: the two original #2433 commits cherry-picked
(`56275ac50`, `3cc24816a`), then the fix `abdeaf8cc`.

The fix moves the once-guard off the exported callback and onto the recorder at
its creation site:

- `src/server/responses/core.ts` — `handleComboResponses` no longer wraps
  `setTerminalOutcomeRecorder` in a local `terminalOutcomeRecorded` closure.
  Instead `handleResponsesInner` guards `codexForwardTerminalOutcomeRecorder`
  where it is constructed, so the preflight callback and the eager/tee
  inspectors all receive the same guarded function.
- `tests/server-combo-failover-e2e.test.ts` — new regression asserting exactly
  one account-health failure per streamed attempt.

21 lines changed in the runtime, 43 added in the test.

## Evidence

Red-green, from the implementer:

- `bun test tests/server-combo-failover-e2e.test.ts --test-name-pattern "records one account-health failure"`
- RED before the source fix: 0 pass, 1 fail, observed `consecutiveFailures: 2`, expected `1`.
- GREEN after: 1 pass, 0 fail.

Full focused run after rebasing onto current `origin/dev`:
`bun test tests/combos.test.ts tests/combo-stream-preflight.test.ts tests/server-combo-failover-e2e.test.ts tests/core-lab-boundary.test.ts`
-> 127 pass, 0 fail, 697 assertions. `bun run typecheck` exit 0.

## The question that decides this phase

Moving a guard to a wider scope trades one bug for a possible worse one. The
guard must be once-per-streamed-attempt, not once-per-request. A combo failing
over across three targets must still record three terminals, one per attempt.
If the recorder is created once per `handleResponsesInner` call and combo retries
happen inside that scope, the new guard would swallow later attempts' terminals —
which would be a quieter and more damaging defect than the one being fixed.

An independent reviewer was dispatched specifically on that lifetime question.
This phase does not land until that verdict is in.


## Landing record

Merged as PR #2449, squashed onto `dev` as `88b7cc057`, with @Ingwannu's two
original commits preserved in the branch history.

The independent lifetime audit answered the question this phase turned on:
each combo target calls `handleResponses` afresh at `core.ts:1915`, each call
builds a new `handleResponsesInner` at `:2163`, so each attempt gets its own
guard at `:3579`. Per attempt, not per request — a three-target failover still
records three terminals. The reviewer also confirmed the regression is
load-bearing: remove the guard and the tee inspector plus preflight both record,
putting `consecutiveFailures` back at 2.

CI 23 pass on the exact head. Issue #2431 closed; PR #2433 closed as superseded
with the reasoning posted for its author.
