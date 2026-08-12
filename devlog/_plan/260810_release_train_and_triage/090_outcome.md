# 090 — unit outcome

> **SUPERSEDED. The outcome below was written while the security gate held the
> train. The owner chose fix first; WP4/WP5 remediated SEC-01 and SEC-02, WP6
> obtained a `READY TO SHIP` re-review, and WP7/WP8 completed the train.**
>
> **Current terminal outcome: `DONE`.** v2.12.0 and v2.12.0-preview.20260810
> are published from RC `9c051342d`; 2 issues closed with cited evidence.
> The record of what actually shipped is `013_release_record.md`, and the
> closure sweep is `014_post_release_closure.md`. Everything below is kept as
> the state of the unit at the moment it was blocked.

**Terminal outcome at time of writing: `BLOCKED` (release) + `NOOP` (closure sweep).**

The block is an authorization boundary, not a mechanical failure. Every gate
that a machine can decide is green.

## What is done

| Work-phase | Outcome |
|-----------|---------|
| WP0 roadmap cycle | DONE — 9 docs, two audit rounds, 10 blockers folded, 0 rebutted |
| WP1 release execution | **BLOCKED** — awaiting an owner security decision |
| WP2 issue disposition | NOOP — zero closable, independently falsified |
| WP3 PR disposition | NOOP — zero superseded, subsumed into WP2's pass |

## Release readiness, as verified

| Gate | Result |
|------|--------|
| Exact-SHA Cross-platform CI on `dc4dd45b0` | success (run 31352564082) |
| `bun run typecheck` | exit 0 |
| `bun run test` | 10,526 pass / 7 skip / 0 fail (651 files) |
| `bun run privacy:scan` | passed |
| `tests/repo-hygiene.test.ts` | 11 pass / 0 fail |
| RC → `preview` merge dry run | clean |
| RC → `main` merge dry run | clean |
| Security review | **BLOCK (critical=1)** |

The last row is the only red one.

## Why the train stopped

The user authorized deployment. That authorization was given before an
independent security review — a review this loop added because the round-1
audit proved the delta's credential-boundary changes had never received one —
returned `BLOCK` on two findings the release would carry:

- **SEC-01** (Critical) — repository automation; excluded from the npm tarball;
  already live on `dev`, so releasing changes nothing about it.
- **SEC-02** (High) — shipped runtime code under `src/lab/`, newly introduced
  by this release, reaching users on an opt-in path.

Mechanism detail for both is held in scratch, never in this repository, per
`AGENTS.md`.

Publishing on a `BLOCK` verdict would make the gate decorative on the same day
it was added. The decision belongs to the owner, and the options are laid out
in `012_security_gate_record.md`: fix first, informed acceptance naming SEC-02
as user-reaching, or fix only the shipped one.

## What the next cycle inherits

1. **The runbook is ready.** `010` is executable as written once the gate
   clears: pinned SHAs, sibling promotion, the resume path for a red CI gate,
   and clean worktrees.
2. **The RC may need re-picking.** `dc4dd45b0` was chosen because newer heads
   could not be driven green — `ci.yml`'s concurrency group is keyed on the
   branch ref, so a rerun on an older commit dies at the next merge (`011`).
   If `dev` has since produced a head with its own green run, prefer it.
3. **#1366 closes when the release publishes**, and nothing else does.
4. **`#1302` is unresolved** and will likely cost one rerun per release gate.

## Corrections this unit made to its own work

Recorded because they are the substance of the two audit rounds:

- The release delta was measured from the local branch instead of the released
  v2.11.1, understating it as 195 files with zero direct commits when the truth
  is 373 files and 44. That error also produced a false "no workflow changes"
  claim, which is what triggered the security gate in the first place.
- Promotion was planned as a chain through `preview`, contradicting
  `MAINTAINERS.md`; it is now sibling promotion of the same RC.
- The claim that no finding reaches npm was false: `package.json` ships `src`
  whole.
- Undisclosed security detail was written into this public unit and had to be
  moved to scratch before any commit existed. `AGENTS.md` says seniority is no
  exemption from that rule; neither is authorship of the gate.
