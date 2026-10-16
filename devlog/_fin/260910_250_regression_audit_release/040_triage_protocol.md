# Triage and remediation protocol (wp3)

wp2 returns six lane reports. This is how they become a release decision.

## 1. Normalize

Each lane return is split into individual findings. A finding is only admitted with an
exact `path:line` anchor or a literal command and its output. An unanchored or misanchored
assertion is recorded as **unsubstantiated** and the main session **must** re-derive it
against the tree. Dropping it undecided is not an option: a real blocker described with a
wrong line number is still a real blocker, and the anchor rule exists to make triage cheap,
not to discard findings.

Findings from different lanes that name the same defect are merged, keeping every anchor.

## 2. Classify

Apply the eight-clause blocker definition in `010_audit_lanes.md`. Each finding gets
exactly one disposition.

| Disposition | Meaning | Action |
| --- | --- | --- |
| `BLOCK` | Matches a blocker clause | Must be fixed and landed on `dev` before promotion |
| `SHIP` | Real but does not match a clause | Recorded here, filed as an issue if it deserves one, released as is |
| `PRE-EXISTING` | The same user-visible failure was reachable on `2f3f73629` | Not this release's problem; requires the proof below |
| `RUNTIME-CHECK` | Plausible but only decidable by running something | Must be resolved before promotion, by a targeted test, a CI job, or a reasoned rebuttal — never left as a confidence label |
| `WRONG` | The lane misread the code | Rebutted with the anchor that disproves it |

A finding is `PRE-EXISTING` only when the **user-visible failure** was reachable on the
baseline — not merely that some function it touches already existed. Showing that an old
helper is unchanged proves nothing when a new caller reaches it under new conditions;
clause 3 exists precisely for that case. Acceptable proof is byte identity of every file on
the failure path (`git rev-parse 2f3f73629:<path>` equal to `git rev-parse origin/dev:<path>`
for each), a test that fails on the baseline, or a baseline CI run showing the same failure.

`BLOCK` may never be downgraded to `SHIP`, and it may only become `PRE-EXISTING` under the
proof above. Weak-proof downgrade is the same evasion as reclassifying to `SHIP`, taken by a
longer route.

## 3. Remediate

Every `BLOCK` fix follows the repository's normal contribution path — a branch off the
current `dev`, a focused regression test next to the existing tests for that subsystem,
a pull request against `dev` using `.github/PULL_REQUEST_TEMPLATE.md`, and the exact-head
CI evidence the branch policy requires. No direct push to `dev`; the ruleset rejects it
regardless of `--no-verify`.

Landing a fix **moves the candidate**. When that happens:

1. Record the new `dev` SHA as the freeze SHA, superseding `12c248f52`.
2. Re-run the candidate-tree CI dispatch on the new SHA. Green on the old head proves
   nothing about the new one.
3. Re-run only the lanes whose read scope intersects the fix, not all six.

## 4. Escalate rather than weaken

A `RUNTIME-CHECK` finding that cannot be resolved is treated as a `BLOCK`, not as a
`SHIP`. An unfalsified hang or teardown risk is not evidence of safety.

If a `BLOCK` cannot be fixed inside this scope — it needs a design decision, an external
credential, or a change the user has not authorized — the release stops and the outcome is
`BLOCKED`. Reclassifying a blocker to `SHIP` to reach a release is the one move this
protocol forbids. The alternative that *is* allowed: revert the offending commit range from
the candidate and release without that feature, which is a smaller change than shipping a
known defect.

## 5. Record

Every finding lands in the wp2 findings table in `030_evidence.md` with its ID, lane,
anchor, failure mode, disposition, and — for `BLOCK` — the PR and merge SHA that resolved
it. A finding with no row in that table did not happen.
