# 070 — Flakiness detection, not retry (F3)

**Depends on:** 060 stage 1, which produces the data this policy needs.

## Change

The standing bar for this project is that flakiness is not tolerated. The usual
CI answer — automatic reruns — directly contradicts that: a rerun converts a
flake into a pass and destroys the evidence.

Policy:

- **Never auto-rerun a failed Windows job to make it green.** A rerun may be
  used to *investigate*, and both results are recorded.
- **Detect instead.** A nightly scheduled run of the Windows suite on `dev`,
  same shards as the gate. A test that passes in the gate and fails nightly, or
  vice versa, on an unchanged tree is flaky by definition.
- **Quarantine explicitly.** A test identified as flaky gets an issue and a
  named skip that states why and links the issue — never a silent
  `test.skip`, never a widened timeout to make red go away. The existing budget
  constants in `tests/helpers/test-budget.ts` are the sanctioned way to raise a
  bound, and that file documents when doing so is legitimate.
- **Quarantine is a debt, not a resolution.** Quarantined tests are listed in
  this unit and reviewed at each release.

## Verify

```powershell
bun run prepush
gh workflow run ci.yml --ref <branch>
```

The nightly workflow is a CI change, so `bun run prepush` applies
(`.github/AGENTS.md:25`), and workflow edits need the security review named in
`MAINTAINERS.md`. Beyond that, the policy is verified by its own run history:
after a month the quarantine list should be short and shrinking. If it grows,
060 stage 3 was premature.

## Risk

Low mechanically. The real risk is social — a quarantine list that is easier to
append to than to drain. The per-release review is what stops that.
