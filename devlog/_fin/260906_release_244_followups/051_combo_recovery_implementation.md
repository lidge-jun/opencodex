# Mixed combo recovery implementation

The carry changes only combo selection in core and provider usability in the
combo resolver. A selectable native target keeps priority. If native candidates
are unavailable or exhausted, an available routed target may be selected after
one explicitly enabled encrypted-task recovery. Existing caller admission,
fixed recovery backend, attempt exclusions and plaintext no-persistence remain.

Canonical native quota belongs to account/model selection; cached summaries keep
filtering third-party and noncanonical providers. Both initial and late recovery
failures recheck caller cancellation, including cancellation during target waiting,
before returning an unreadable-task or prior native error.

Original contributor tests cover disabled/cooldown/native-401, failed recovery,
unavailable targets, canonical/noncanonical quota and eligibility. The new paired
abort fixture waits for the recovery fetch to start, then cancels its actual signal;
499/client_cancelled, no routed call and empty cache/continuation stores are asserted.
No local suites/typecheck/build or live Kiro request are used. Hosted exact-head CI
and independent source/security/final reviews supply integration evidence.

## Verified composition

- Source fd5e90f1b and regressions cd054d926 passed independent source/security
  and final reviews. The initial full hosted run was CI34019564577.
- Parent #3753 required a separate repair cycle for preflight read failures and
  tee EOF account outcomes. That repair is merged on dev as b9f2acc82; source
  cd6d4d346 passed CI34020474748 and its two review threads are resolved.
- The resulting child e1f5a5b8d passed full CI34020475627. Stable patch ID
  8b62ad9ebb675f63a6dd4933e22663b48e1d95f2 matches the original combo delta,
  and a fresh composition review passed. This documentation closeout changes
  no runtime or tests. Final PR-head checks remain visible on #3754.
- #3706 remains open until #3754 actually merges. Closure requires a fresh
  merged-state and dev-ancestry check; a successful merge command is not assumed.

No local suite, typecheck, build or live Kiro call was used for these results.
