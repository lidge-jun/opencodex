# 003 — Audit record

Seven review rounds over this unit, two independent reviewers. Recorded because
the corrections are more instructive than the plan, and because a unit that
claims "every finding was verified" should show what verification cost.

## Rounds

| Round | Reviewer | Verdict | Findings |
|---|---|---|---|
| r1 | A | FAIL | 6 blockers, 4 citation defects |
| r2 | A | FAIL | 5 blockers |
| r3 | A | NEAR-PASS | 2 |
| r4 | A | (inconclusive) | verdict lost — reviewer closed before the hook recorded it |
| r5 | B (fresh) | FAIL | 3 blockers, 3 citation corrections |
| r6 | B | NEAR-PASS | 1 citation defect |
| r7 | B | PASS | none |

Reviewer B was dispatched with no prior context and explicitly told not to
assume reviewer A had been thorough. It found three blockers A had passed over,
including one that would have shipped a false claim about a security control.

## Corrections worth remembering

**A verifier that could not verify.** `031` claimed `privacy:scan` enforced the
fixed-literal publisher label. It does not — `scripts/privacy-scan.ts:187` is a
textual scanner over file content and cannot see that a runtime value was
path-derived. The fix was a closed union type so the constraint fails
`typecheck` instead. This is the most valuable catch in the seven rounds: the
plan named a guard that would have passed while the invariant it claimed to
protect was violated.

**A CI assertion nobody could implement.** `031` also said CI would assert the
counters stayed zero across the Windows suite. The counters are process-local
and the suite runs across four sharded runners in many short-lived processes.
The claim was withdrawn rather than reworded — an instruction that cannot be
followed is worse than an admitted gap.

**A test verifying the wrong thing.** `051` claimed it could verify `050`'s
backoff by reverting `050`. Reverting would leave a fixed five-second loop that
still relaunches, still yields a new PID, still restores health — the test would
pass either way. Now stated plainly, with backoff verified separately by
asserting on generated script text.

**Batch arithmetic that fails at runtime.** `050` advised converting `%TIME%`
with `set /a`. `set /a` reads a leading zero as octal, so `08` and `09` are hard
errors — confirmed directly:

```text
C:\> set /a a=08
Invalid number.  Numeric constants are either decimal (17),
hexadecimal (0x11), or octal (021).
```

Four traps documented in the end: octal, space padding, midnight wrap, delayed
expansion.

**A job that did not test what it claimed.** `080`'s "self-update end to end"
used a locally packed tarball, but `ocx update` resolves its target from the
registry (`src/update/index.ts:167`) and installs a resolved version (`:106`).
There is no injection seam, so the real command was never exercised. Renamed to
a package replacement smoke, which is still worth having.

**A gate that does not exist.** `060` promised Windows would block merges. `dev`
has no branch protection (`MAINTAINERS.md:121`, `:125`). Stage 3 is now a
convention gate; stage 4 is the real one because `release.yml` reads run
conclusions directly.

**Sequencing invented after the fact.** `002` originally claimed a long
dependency chain. Only two links were structural. One was backwards.

**Six citation defects.** `job.ts:1381`→`:1383`, `ci.yml:771`→`:769-772`,
`release.yml:224-234`→`:224-241`, `service.ts:2330`→`:2340-2341`/`:2350-2355`,
`config.ts:3937`→`:3942`, and a missing `chmodSync` site the `040` seed list had
skipped entirely — which is why `040` now says to re-derive the list rather than
trust it.

## Two claims withdrawn

"Every release to date ran zero Windows tests" was false. Releases touching
`src/service.ts` and a few other paths separately require a green
`service-lifecycle.yml` (`release.yml:224-241`), which includes a Windows job.
The defensible claim is narrower: the release preflight does not require the
Windows *suite*.

`src/service.ts:1983` was cited as evidence that ACLs are authoritative for
credential writers. It says so about an elevation staging directory. Evidence
for the principle, not for any writer's coverage.

## What this says about the unit

Sixteen findings against a document that had already been written carefully.
Every one was reproduced against the tree before being acted on, and two of the
reviewer's own line numbers were off in the other direction and corrected back.

The rate at which confident-sounding planning prose turns out to be wrong is the
argument for `060`. A plan gets seven adversarial rounds; a merge to `dev`
currently gets no Windows execution at all.
