# Lane A recovery

Repair two demonstrated edge cases in the carried train: split CRLF completion repair and a discarded web-search recovery request at the iteration ceiling. Align Portuguese decode-window wording with the existing generation metric. Preserve the working carries from `da40c734a558ea32ce391613f5a0309d14cfce81`.

- Satisfy-spec, single bounded implementation cycle, authorized by the coordinator after roadmap `995dee54a0`.
- Scope: existing terminal-repair and web-search owners, adjacent regressions, owning contracts, one locale string. No new abstraction or configuration.
- Non-goals: pushes, PRs, merges, installs, CI dispatch, releases, live account/provider mutation, full suites, broad typechecks, builds. Coordinator owns final integration and cross-platform proof.
- Verifiers: explicit focused Bun test files, GUI `--isolate`, structure/layout/privacy checks and independent inherited review. Baseline two-file regression suite recorded privately before implementation.
- Stop: local commits with passing focused checks, independent findings addressed, and private report in `.tmp/train-recovery/`. Unavailable live/native proof remains explicit, not a success claim.
- Resource envelope: bounded sequential test batches, at most eight files each; no user-specified token/time budget. Escalate scope growth or blocked dependencies to the coordinator; do not weaken acceptance.
- Detailed change map and activation scenarios: `010_repairs.md`. Security working notes remain ignored scratch only.

## Consultation

The coordinator's audited roadmap assigns these existing surfaces to Lane A. Local architect consultation and independent review evidence are recorded in the private recovery report; this plan retains the bounded repair decisions and public verification scope.

Architect `01a10042-39d1-7980-a06f-f60df848a3ee` proposed A1/A2/A3; main accepted all three without changing owners or contracts. The same architect reviewed `010_repairs.md` after those decisions were recorded and returned ALIGNED with no gaps.
