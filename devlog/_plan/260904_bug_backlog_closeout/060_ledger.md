# 060 — disposition ledger

Append-only record of every bug-labeled item and how it terminated. wp2 through wp6
each write their rows here as they close, so the goal-level DONE claim is checkable
against posted artifacts instead of memory. Terminality rule: `000_research.md`
§"What terminal means".

Columns: item, work-phase, outcome, evidence (merge sha / issue state / posted URL).

## Bug PRs

| PR | Author | wp | Outcome | Evidence |
|----|--------|----|---------|----------|
| 3430 | ChickenBreast-ky | wp2 | MERGED | dev 4b53e1044f52e8e045db44c8b52613174cf64a23, 2026-09-04T06:51:20Z |
| 3420 | ildunari | wp2 | MERGED | dev fc70555f3692400a6054d1d1aebf9e30bbd08868, 2026-09-04T06:53:36Z |
| 3405 | adtumk | wp2 | MERGED | dev 20011a1c482c1e4051c2ec1c52d0ee9ca9164d6c, 2026-09-04T06:54:29Z |
| 3401 | agentHits | wp2 | MERGED | dev 0f2e1209937ffae9d0c6c30837ce770b3c7cd73c, 2026-09-04T06:52:48Z |
| 3403 | ianlyoo | wp3 | FIX PUSHED to author branch | e7fe8dc6e with Co-authored-by; awaiting author ack + CI |
| 3432 | luvs01 | wp3 | REVIEW POSTED | whitespace-normalized `file:` scheme still evades FILE_URI_RE |
| 3407 | turin-dev | wp3 | REVIEW POSTED | GET reads stale startup config; toggle snaps back |
| 3394 | kremnyi | wp3 | REVIEW POSTED | enforce-target red is a cancelled run, not a failure |
| 3388 | zleo-ai | wp3 | REVIEW POSTED | sound; needs rebase + hosted CI attribution |
| 3348 | RHODIZSECURITY | wp3 | AUTHOR CHOICE OFFERED | split-it-yourself or carried with Co-authored-by |
| 3332 | full999 | wp3 | REVIEW POSTED | vendor maxTokens -> maxInputTokens shrinks a 1M window |
| 3325 | luvs01 | wp3 | SPONSORED | maintainer security review done; `maintainer-sponsored` applied |
| 3439 | lidge-jun | wp2 | MERGED | dev 8401b68db; repairs the two post-merge regressions |

## Bug issues

| Issue | wp | Outcome | Evidence |
|-------|----|---------|----------|
| 3428 | wp2 | CLOSED completed | closed after 4b53e104; comment quotes the merge sha |
| 3400 | wp2 | CLOSED completed | closed after 0f2e1209; launcher-coverage follow-up noted |
| 3378 | wp2 | CLOSED completed | closed after 20011a1c; absorbed #3344/#3362 already closed |
| 3402 | wp3 | pending | closes on #3403 merge |
| 3406 | wp3 | pending | tied to #3407 |
| 3425 | wp4 | DIAGNOSED, posted | routing.ts:2195 generation drop + :2455 5-min reset; one question asked |
| 3352 | wp4 | NEEDS-HUMAN | security-review class; hit live by this session's own subagent dispatch |
| 3433 | wp5 | NEEDS-HUMAN, posted | confirmed asymmetry; blanket synthesis rejected, provenance decision required |
| 3424 | wp5 | NEEDS-INFO, posted | opencode-go is adapter openai-chat; re-test asked, #3394 is the precedent |
| 3441 | wp2 | FILED | new: intermittent Windows npm-global cancellation |
| 3320 | wp6 | NEEDS-INFO, posted | comment 5537325501: SID form is already accepted, so the suspect is identity resolution |
| 3279 | wp6 | NEEDS-INFO, posted | comment 5537346000: named 3 captures; origin mismatch is the lead hypothesis |
| 3255 | wp6 | RECLASSIFIED enhancement | comment 5537334610; label bug -> enhancement applied |
| 3245 | wp6 | NEEDS-INFO, posted | comment 5537342024: filed on 2.39.0, dev is 2.43.0; re-test asked |
| 1527 | wp6 | CLOSED completed | reporter confirmed non-reproduction on 2.41.0; cache finding routed to #3433 |

## Rules for writing a row

- `merged` requires the dev merge sha from `gh pr view --json mergedAt` plus the issue
  showing CLOSED afterwards (these PRs target `dev`, so GitHub does not auto-close).
- `superseded` requires the successor PR number AND the `Co-authored-by` trailer text,
  quoted, so the credit claim is verifiable in git rather than asserted in prose.
- `needs-human` / `blocked` / `unsafe` requires the posted comment URL. An outcome with
  no artifact on the item is not a disposition.
- A Windows-only failure discovered while working an item gets its own filed issue number
  recorded in the row, per the goal's scope rule.

## wp2 execution record

Merged in the audited order 3430 -> 3401 -> 3420 -> 3405, squash, targeting `dev`.
Each PR was approved by the maintainer as an ordinary review rather than through the
admin `pull_request` bypass, because the maintainer authored none of the four and
MAINTAINERS.md treats a bypass as something that must be recorded rather than assumed.
Each approval carries the substantive finding from the independent review lane, including
the two MERGE-WITH-NOTE caveats: #3405's suite failures attributed to its `dev` baseline
(recorded, not re-litigated, since hosted CI on the PR was green and the local suite was
off-limits) and #3401's partial launcher coverage.

Mergeability was re-confirmed on #3405 AFTER #3420 landed, since both touch
`src/adapters/openai-responses.ts`; it stayed `MERGEABLE`, which is the empirical
confirmation of the independence the audit predicted from the hunk positions.

Not merged from the green set: #3403, held back for the dotted-alias collision and
carried into wp3 as a named item.

## Post-merge CI: two regressions, both repaired (#3439)

Cross-platform CI on the final merge sha 20011a1c failed. Four jobs went red, and the
cause was two distinct test failures -- both of which were green on their own PR head and
only failed once the changes sat on `dev` together. This is the case the PR gates
structurally cannot catch, and it is the reason the post-merge dev run is checked rather
than assumed.

1. `tests/loopback-listener-integration.test.ts` (#3430's own test) pinned the downstream
   status to `[400, 503]`. The relay answers 401 when it admits the request and then finds
   no usable credential. The neighbouring #3192 search test already allowed `[401, 503]`
   for the same reason; the images copy did not. Widened to `[400, 401, 503]` so the test
   asserts admission -- its actual subject -- rather than how far the relay gets.
2. `tests/star-deferral.test.ts` faked a TTY through `process.stdin.isTTY`. #3401 moved the
   guard to `isatty(0) && isatty(1)` precisely so the stream is never constructed, since
   constructing it dereferences a possibly-unlinked cwd (#3400). A property fake cannot
   reach a file descriptor, so the TTY decision joined the existing `depsForTests` seam.

Both were reproduced locally against `dev` before being fixed, so these are confirmed
repairs. Repaired in PR #3439 off `codex/260904-bug-backlog-closeout`, with
`Co-authored-by` trailers for @ChickenBreast-ky and @agentHits since the tests are theirs.

Worth recording as a process note: the merge train verified each PR against its own green
CI, which is what the instructions asked for, and that was still not sufficient. Nothing in
the per-PR gate models the combination. The dev run after the last merge is the only place
the interaction shows up.

## wp6 disposition record

Five needs-info issues, all dispositioned visibly on the issue itself rather than in a note.

**#1527 closed.** The reporter came back with measurements on 2.41.0 showing the
large-context collapse no longer reproduces: 99k-157k input per turn completing normally,
kimi-k3 returning 1985 tokens at 153k input across 4 tool loops, and a loopback series
running on `continuationMode=checkpoint` with every turn ending `expectedClose: true`.
That is the inverse of the reported defect on the same account, so the issue is resolved.
Their separate observation -- `cacheReadTokens=489972` direct versus `cached_tokens=0`
through the proxy -- was routed to #3433 rather than allowed to keep a closed issue alive,
because it is the same shape as the bridge finding recorded in `040_wp5`.

**#3255 reclassified.** The report argued it was "a small parameter-coupling defect". The
code disagrees: reasoning effort and service tier are already separate catalog axes, so
splitting the combined desktop control is designing a new control surface, not repairing a
coupled one. Relabeled `bug` -> `enhancement` with the three product questions that
actually block it, since answering them by inference would be inventing intent.

**#3320 kept open with a narrowed hypothesis.** The reporter supplied the `<UserId>` in SID
form. Reading `src/service.ts`, `cachedWindowsTaskUserIds()` returns BOTH `identity.sid` and
`identity.name` and the trigger validator accepts either, so a SID-form UserId and a
non-ASCII display name are not themselves the rejection. The remaining suspect is identity
RESOLUTION failing outright, which makes `resolveWindowsTaskDiagnosticUserId` return null
and fails a scoped trigger regardless of correctness. Asked for an unpatched status plus the
`<Triggers>` block, specifically whether the element is namespace-prefixed.

**#3245 and #3279 kept open with specific captures requested.** #3245 was filed against
2.39.0 while dev is on 2.43.0, so a re-test is the only honest next step. #3279 got three
named captures with the origin-binding mismatch called out as the lead hypothesis, including
the note that if that is the cause, the real defect is reporting a session problem as
"cannot connect to proxy".

## wp4 / wp5: two diagnoses that deliberately did not become patches

Both units ended with evidence rather than code, and that is the honest outcome rather than
a shortfall.

**#3425.** The planned fix was rejected by its own test suite: `tests/codex-routing.test.ts:325`
already proves a known-100% account switches away, so tightening the unknown-usage branch
would be a no-op that also breaks the never-primed case the code comments protect. The real
suspects are `routing.ts:2195`, which drops an outcome WHOLE on a stale writer generation so
`consecutiveFailures` never increments, and `:2455`, which resets the streak after five
minutes and makes the threshold unreachable for hand-retried traffic. A characterization test
now pins the first one. Which fired in the reported run depends on whether a config reload
occurred, which only the reporter knows, so that question was asked instead of guessed.

**#3433.** The Chat bridge really has no `session_id` synthesis while the Claude bridge does.
But Claude gates its synthesis on `cacheKeySource === "metadata"` precisely because a shared
cohort key's backend semantics are unproven, and the Chat path has no equivalent provenance.
Mirroring it unconditionally would bind unrelated callers onto one upstream session -- a worse
bug, and one that would fail in the same intermittent way. Posted with the suggestion that
Hermes send `session_id` directly, since it is already in `FORWARD_HEADERS` and would confirm
the diagnosis with no proxy change.

The shared lesson: a plausible fix that the existing tests already contradict is worse than a
diagnosis, because it looks like progress.
