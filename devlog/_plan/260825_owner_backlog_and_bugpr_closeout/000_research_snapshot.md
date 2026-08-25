# 000 — Research snapshot: owner backlog + bug PR closeout

Unit opened 2026-08-25. Base: `origin/dev` at `b33d82dc3`.

## Scope

Two populations, 31 items at open:

- **A. Maintainer-authored open issues (15):** #2569 #2568 #2566 #2565 #2558 #2557 #2491
  #2472 #2465 #2464 #2463 #1478 #1049 #1048 #820
- **B. Open `bug`-labelled community PRs (16):** #2567 #2563 #2555 #2550 #2542 #2532
  #2528 #2515 #2513 #2512 #2510 #2503 #2497 #2490 #2488 #2474

## Method

Six read-only investigation lanes (`gpt-5.6-sol`, medium) were dispatched in parallel
against a worktree pinned at the then-current dev head. Each lane was required to verify
the claim in the issue/PR body against the actual line cited, and to return a verdict
with file:line evidence rather than a plausibility judgement. Lane reports are
summarized per item in `010`-`080`; this document records only the classification and
the dependency order.

## Classification

| Item | Verdict | Effort | Risk | Owner phase |
|---|---|---|---|---|
| PR #2528 | MERGED (verified, 41 focused tests) | S | LOW | wp1 |
| PR #2555 | MERGED (verified, 11 GUI tests) | S | LOW | wp1 |
| PR #2532 | MERGED (verified, 46 focused tests) | M | MED | wp2 |
| PR #2515 | MERGED (verified, 88 focused tests) | M | MED | wp2 |
| PR #2474 | MERGED (Linux-only regression, skipped on macOS) | XS | LOW | wp2 |
| PR #2550 | MERGED (verified, 138 focused tests) | XS | MED | wp3 |
| PR #2563 | NEEDS-FIXUP (returned to draft on new commits) | M | HIGH | wp2 |
| PR #2503 | NEEDS-FIXUP (53 commits behind; capability lost via combo/trusted/live paths) | M | MED | wp3 |
| PR #2488 | NEEDS-FIXUP (2 correctness blockers: policy-code overwrite, envelope selection) | M | HIGH | wp5 |
| PR #2542 | NEEDS-FIXUP (51 commits behind; red focused test) | S | MED | wp5 |
| PR #2513 | NEEDS-FIXUP (eviction not applied to AI Studio; test lacks HOME isolation) | S | MED | wp4 |
| PR #2512 | NEEDS-FIXUP (substring model match caps unknown models) | M | MED | wp4 |
| PR #2510 | NEEDS-FIXUP (`retry-after` spelling omitted from transient guard) | XS | MED | wp4 |
| PR #2567 | NEEDS-FIXUP (hygiene: missing_regression_test) | S | MED | wp5 |
| PR #2497 | NEEDS-FIXUP (unsponsored_surface; auth boundary needs maintainer sponsorship) | L | HIGH | wp5 |
| PR #2490 | NEEDS-FIXUP (unsponsored_surface only; code reviewed sound) | S | MED | wp5 |
| Issue #2565 | IMPLEMENT (formatter mismatch, renderer already exists) | XS | LOW | wp8 |
| Issue #2566 | IMPLEMENT (CLI never passes `quota=1`) | M | MED | wp8 |
| Issue #2558 | IMPLEMENT (no destination-authority field on tier observation) | S | MED | wp9 |
| Issue #2557 | IMPLEMENT (PowerShell statement join + probe failure is not absence) | S | HIGH | wp9 |
| Issue #2491 | IMPLEMENT (four relations confirmed with file:line) | M | MED | wp10 |
| Issue #2472 | INVALID/WONTFIX (envelope owned by the Codex host, not this proxy) | XS | LOW | wp11 |
| Issue #2465 | IMPLEMENT (GUI surface) | L | MED | wp12 |
| Issue #2464 | IMPLEMENT (GUI surface) | L | HIGH | wp12 |
| Issue #2463 | IMPLEMENT (GUI surface) | L | HIGH | wp12 |
| Issue #2569 | IMPLEMENT (live roster drift, measured) | M | LOW | wp6 |
| Issue #2568 | IMPLEMENT (generalize OAuth account failover) | M | MED | wp7 |
| Issue #1478 | IMPLEMENT (config provenance still absent) | L | HIGH | wp13 |
| Issue #1049 | IMPLEMENT (legacy homes still `legacy-uncoordinated`) | L | HIGH | wp13 |
| Issue #1048 | IMPLEMENT (disposable-host runner absent) | L | HIGH | wp13 |
| Issue #820 | IMPLEMENT (session-lane scheduler absent) | L | HIGH | wp13 |

## Key findings that change the plan

**#2472 is not our bug.** `wall_time_seconds` and `exec_command` appear nowhere under
`src/` or `tests/` — that result envelope belongs to the Codex host. The lane also
rejected the Cursor call-ID theory: live bridge calls pass `allowEmptyArgs: true`
(`src/adapters/cursor/live-transport.ts:243`) and duplicate call IDs are deduplicated
deliberately (`src/adapters/cursor/protobuf-events.ts:1044`). Closing with evidence
rather than implementing.

**The four old architecture issues are genuinely open.** #1478, #1049, #1048, and #820
were each checked against `_fin` units and against `src/`. All four are real remaining
work, all L, all HIGH risk. They are not stale-but-done, and they cannot be honestly
closed by adjudication alone. They form wp13 and are the largest single risk to the
DONE criterion.

**Three hygiene-blocked PRs fail for two different reasons.** #2567 fails
`missing_regression_test` — a real, satisfiable gap. #2497 and #2490 fail
`unsponsored_surface`, which is a maintainer-sponsorship gate on the auth/quota
surface, not a code defect; #2490's code was reviewed sound.

**The three Google PRs do not conflict.** #2510 changes `google-errors.ts`; #2512 and
#2513 change `google.ts`. No merge-order dependency, but #2512 and #2513 will textually
conflict with each other and must be sequenced.

## Dependency order

wp1 → wp2 → wp3 (merge train, ordered by base freshness) runs first because every later
implementation phase rebases on a moving dev. wp4/wp5 are independent of each other.
wp6-wp12 are implementation phases on issues; wp12 is the only GUI-bearing phase and
routes through cxc-dev-uiux-design before cxc-dev-frontend. wp13 is last because it is
the only phase whose scope can force a plan amendment.

