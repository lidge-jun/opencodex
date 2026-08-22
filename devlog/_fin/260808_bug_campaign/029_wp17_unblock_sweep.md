# WP17 — the queue refilled

The goalplan read `complete: true`, all 16 work-phases done, 6/6 criteria met.
A live sweep said otherwise.

## What the completion flag was measuring

Twenty-four open bug-class PRs. Of those, **nine had never had CI executed**:

| PR | State | Author |
|----|-------|--------|
| #1304, #1300, #1294, #1264, #1260, #1258, #1256 | `action_required` | XIQIXIQIXIQI, hanbinnoh, luvs01 |
| #1192 | `cancelled` | luvs01 |
| #1155 | **no runs at all** | myrosla |

WP1 did exactly this work for 27 PRs earlier in the campaign. The queue refilled
while the later phases ran, and nothing in the goalplan measures that — the
criteria track the items the plan enumerated, not the items that exist.

That is worth stating plainly: **`complete: true` meant "the recorded work is
done", not "the repository is in the state the objective describes".** A
campaign whose objective is "give every open item a disposition" cannot be
closed against a snapshot taken at its start.

## The sweep

Approved every `action_required` run on every open PR, SHA-matched, logged to
`.tmp/ocx_approval_ledger.tsv`: **37 approvals**, zero SHA mismatches.

The repository had **735** runs sitting at `action_required` overall. Most
belong to superseded heads of PRs already handled, which is why the sweep is
scoped to the *current head of each open PR* rather than to the queue. Approving
by queue would have released runs for commits no PR points at any more.

### A fail-closed check that worked

The first attempt at the loop mis-quoted a shell variable, so the run id became
a JSON error blob and every row logged as `SKIP` with a 404. Nothing was
approved. That is the ledger doing its job: the comparison is between the PR
head and the *run's* head, so a malformed id cannot pass it. Rewritten as a
script and rerun cleanly.

## #1192 — cancelled, rerun issued

`rerun-failed-jobs` on run `31157296632`. The branch is 325 commits behind, so
a green result there is weaker evidence than it looks; that is the author's
rebase to make, not mine.

## #1155 — nothing to approve

The interesting one. Zero workflow runs against `307045c55`, and zero for the
branch in this repository's Actions history. The only status on the head commit
is CodeRabbit.

It is a fork PR (`myrosla/opencodex`), and the first-time-contributor gate never
produced a queued run the API could release. So this is not a case of me
forgetting to approve it — there is no run object to approve.

Told the author exactly that, including the part I cannot do: pushing any commit
(an empty one, or the rebase the 429-commit gap warrants) usually re-triggers
the workflows and creates a run I *can* approve.

Also worth recording: this PR already carries two of my comments — one
retracting a wrong close-as-unreachable assessment, and one correcting an error
*in that retraction*. The patch is not blocked on analysis. It is blocked on
never having been tested.

## What this says about the goal

The objective is a terminal disposition for every open bug issue and PR as of
2026-08-08. Items keep arriving — #1292, #1295, #1296, #1297 during the
campaign, #1308 and #1310 after. Two honest readings:

1. the cutoff is the campaign's start, and post-cutoff arrivals are out of
   scope by construction; or
2. the objective is a standing state, in which case it is never complete.

Reading (1) is what the objective literally says, and the resweeps recorded in
`023` and `027` are what make the boundary checkable. But the completion flag
flipped while nine PRs from *before* the cutoff had never been unblocked, and
that is not a boundary question — it is work the plan enumerated and the
tracking lost.

---

# Audit fold

## An approval is not a disposition

The sharpest correction: I described 37 approvals as if they closed something.
They did not. Approving a pending workflow run **starts** CI; it produces no
outcome. #1256 was created at `2026-08-08T04:35:05Z` — squarely pre-cutoff —
and its Cross-platform CI is still executing as this is written.

So the completion bar is not "every pre-cutoff item was unblocked". It is
**"every pre-cutoff item has a recorded outcome or an explicit hold"**, which
requires a final resweep *after* those runs finish. Recorded as the gate on
closing the goal.

Verified since: #1192's rerun at `b50f23943` is `completed/success`, and the
seven approved PRs are running rather than queued — so the approvals did what
they were supposed to do. That is evidence the sweep worked, not evidence the
work is finished.

## The scope check held

Independently confirmed: 712 runs sit at `action_required`, and **zero** of them
match any current open-PR head. The current-head rule is what kept 675-odd
superseded-commit runs from being released, and scoping to the queue would have
done exactly that.

## #1155 — plausible is not proven

I wrote that the first-contributor gate caused the missing runs. The evidence
supports "there is no run object to approve" and nothing stronger: its diff does
touch `src/` and `tests/`, which match `ci.yml`'s PR paths, so path filtering is
ruled out — but the *cause* of the absence is inferred.

The comment I posted already says a push "usually re-triggers" rather than
promising it. What that comment should also have said, and what belongs here:
**if the author pushes, the next step is to verify a run was actually created**,
not to assume one was.

## Where I overreached about the objective

I wrote that a campaign with this objective "cannot be closed against a snapshot
taken at its start". That contradicts the campaign's own plan, which explicitly
freezes the inventory at the cutoff (`000_plan.md:21`).

The correct definition, and the one this campaign is actually held to:
**complete = every item open at the recorded cutoff has a final disposition.**
Not "the repository currently has no open bug work" — that is a standing
condition no campaign can satisfy, and holding myself to it would be a way of
never having to close anything.

The real defect was narrower than my framing: the plan had no *final* live
resweep step, so nine pre-cutoff PRs went untracked. That is a plan gap, not a
reason to redefine completion.

---

# Final resweep — `FINAL_SWEEP=2026-08-08T19:09:36Z`

The gate the audit set: not "unblocked" but "has a recorded outcome". Every one
of the nine now does.

| PR | Author | Outcome |
|----|--------|---------|
| #1304 | XIQIXIQIXIQI | CI **success**, awaiting author checklist |
| #1300 | hanbinnoh | CI **success**, awaiting author checklist |
| #1294 | luvs01 | CI **success**, awaiting author checklist |
| #1264 | luvs01 | CI **success**, awaiting author checklist |
| #1260 | luvs01 | CI **success**, awaiting author checklist |
| #1258 | luvs01 | CI **success**, awaiting author checklist |
| #1256 | luvs01 | CI **success** after rerun, awaiting author checklist |
| #1192 | luvs01 | CI **success** after rerun; 325 commits behind, rebase offered |
| #1155 | myrosla | **no run object exists**; author push required, then verify one was created |

All eight with runs are green. All nine are drafts held by the contributor's own
four-box checklist, which stays theirs — the maintainer half of the blockage is
cleared and the PRs say so.

## #1256 produced the best evidence yet for #1302

Its first run had **two shards hang in the same run**:

```
test 4/4  cancelled  18:44:24Z → 18:59:39Z   (15m15s)
test 3/4  cancelled  18:42:18Z → 18:57:33Z   (15m15s)
```

Both killed at the job timeout to the second, matching every prior instance
including #1301's `test 4/4` at 15:28:02Z → 15:43:17Z. Tally is now **eight
occurrences across six branches plus `dev`**, with the shard varying between
2/4, 3/4 and 4/4.

Two shards hanging at once makes "one bad test" harder to sustain. And the
15m15s figure matters on its own: these are not long tests finishing late, they
are shards that stop emitting and get killed at the deadline — consistent with
the orphaned `bun` process cleanup reports. Added to #1302.

The triage cost is the part worth recording: of eight approved runs, one needed
a rerun purely for this, and a genuine hang from a real change would look
identical.
