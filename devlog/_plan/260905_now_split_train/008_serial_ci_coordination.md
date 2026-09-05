# 008 — Closed historical cross-task CI coordination

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

The user requested conversational coordination among active tasks: one
non-Windows CI run at a time, with the separate Windows maintenance work left
alone. This is scheduling, not a repository concurrency-setting change and
not a transfer of merge authority between tasks. Local suites remain banned.

## Confirmed handoff

PR #3582, head `0efd0c1594dfbcbf46002a2af38a269367619713`, completed workflow
33949918771 successfully. Its owner returned the first slot without starting
the next stacked layer, retargeting, or merging.

Owners saved complete exact-head/job snapshots and cancelled their own other
unfinished non-Windows runs. Image runs33949975196/33949974086/33949974578/
33949973937/33949973996 reached completed/cancelled with zero unfinished jobs.
Provider3584/3598 and registration3636 likewise stopped. Coordinator's fresh
workflow inventory showed only the explicitly excluded Windows run active
before granting the next slot. No foreign run was cancelled by this task.

PR #3589, head `5060ac8910eff1877bd2ee6bdcb2b6d063f26b79`, then received its
dedicated slot. A single `--failed` resumption advanced workflow33949975196
from attempt1 to2. Actual execution is limited to cancelled test2/4, macos1/2,
macos2/2 and keyring-macos, followed by aggregation. Ten successful jobs were
carried forward with their original execution timestamps and steps, although
the API assigned new job database IDs. IDs alone cannot prove a job reran.

## Retired queue

The historical queue ordered3582,3589,3578,3584,3636 and remaining dependencies.
It was retired by the user's later direction that tasks proceed independently.
No owner reporting, live recheck, slot grant, cancellation, pause or peer
communication is authorized by this record. Do not restart coordination.

## Subsequent handoffs

- #3589 attempt2: SUCCESS at the recorded head; owner returned slot.
- #3578: one normal push of ae3e1aea8a22f63ad05e7df4efd123220e5d0bc5,
  CI33951393329 SUCCESS (18success/2configuredskip), governing checks also
  passed. Review replies/resolution and landing remain separately scheduled.
- #3584: original/current merge commits differed but their parent IDs and
  treeba1232aa812ceb8e660a528b4b5b66a9e8092db8 matched. Partial attempt2 of
  CI33949917919 passed with12successful jobs preserved. Owner returned slot.
- #3636: original/current mergeeb25dc0742fa3a335f95b7bea7b6a86b5e72d20b and
  tree68b480c7cb3b4259ad3b2aced2054e5245a2b7d7 matched. Attempt2 resumed11
  cancelled jobs and preserved6passes. macos2/2 job101269594430 failed;
  aggregation failed honestly. Owner returned slot for read-only RCA; no
  repeated run or silent waiver.
- WP445 then owned the verification slot. Source
  f47a8e39885a6c79ffdb7b50fb4594aae199a2da was published; isolated exact-head
  SSH full verification was running at that checkpoint before PR creation. No hosted CI overlaps
  that full suite. New source/receipt remain bound to a2c0.

Investigation and detailed control records are retained in ignored scratch.
This public document records scheduling and verification status only.

Windows-owned development-branch CI arising from its own merge was also left
alone. Task ownership—not merely a `win-` branch-name filter—determines the
user's exception. A diagnostic-only Astra task later gained upstream-WS
implementation authority; its prospective slot request is historical, not active.
