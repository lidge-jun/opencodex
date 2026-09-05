# 801 — Cutoff regression evidence matrix

This is the shared verification matrix for the distinct810and820 work-phases.
Each has a full P/A/B/C/D history and its own fresh evidence. All rows are
currently pending; no prior split CI certifies a rebased candidate.

| Comparison/surface | Required proof | Failure disposition |
|---|---|---|
| Each old stack → rebased stack | range-diff, moved declaration/body/export/state identity, original assertions retained, dependency direction and newly landed behavior carried | Resolve the actual conflicting logic; do not choose a side wholesale |
| Pinned dev → aggregate | Every one of14 manifest entries represented, no duplicate Cursor parent, no unrelated source reversal, reviewed docs precedence | Missing or duplicated delta blocks publication |
| Pinned main → final candidate | Review change categories including mechanical test relocations; map common contract cases across paths; distinguish intended feature changes from regressions | Add a concrete regression case or document intentional contract difference; never infer from pass counts alone |
| Runtime protocols | Responses/chat/Claude translation, image reference and tool-output preservation, streaming/terminal behavior, error contracts | Preserve landed fixtures and fix only observed regressions |
| Config/CLI/native clients | Config export bytes/order/auth representation, prompt encoding/TOML/EOL, shell ownership and status/install contracts | Same contracts at pinned baselines or explicit intended migration |
| Catalog/routing/state | Destination trust checks, combo cooldown/default/cancellation behavior, provider config fields and cache/singleton ownership | No permission/selection/state-loss regression |
| Privacy/optional boundaries | Project privacy scan, preserved redaction behavior, no new core→Lab reachability, explicit security review | Findings go to ignored scratch; no public working vulnerability notes |
| Dashboard/package | Pinned build, existing component tests/lint, isolated served smoke where the main→dev UI delta requires runtime proof | No global service changes or real user account mutation |
| Final exact head | Remote build/typecheck/full-suite and relevant focused gates, negative controls for changed guards, clean source-bound receipt; actual hosted CI | Failure/cancellation is not PASS; no intermediate publication to obtain evidence |
| Actual merged dev | Expected-head admin merge, tested-tree equality, fetched ancestry, normal post-merge CI and final review disposition | Any new discrepancy remains work; do not announce completed regression closure |
| Two-cycle requirement | Cycle1 baseline/current-dev/candidate comparison; cycle2 independent main-export guard plus adversarial second comparison and actual merged-dev proof | Repeating one CHECK or replaying old logs does not count |

The main baseline uses its own package/lockfile and test runner, not a silently
substituted dev harness. At the pinned main, Bun is1.4.0, `bunfig.toml` roots
discovery in tests and preloads tests/preload.ts, and scripts/test.ts creates
isolated homes and honors the test-run lock. Read the matching guards before
execution, retain complete outputs and verify cleanup. No local test runs.

The interval already contains substantial work beyond these14 splits. Full
baseline/final checks and this matrix are separate from split-focused checks.
No claim of overall regression safety is earned solely from clean rebases or
fourteen old CI statuses. Baseline failures need evidence-backed classification.

Prepare documentation before final publication. Record source and verification
identities explicitly; final hosted/merge evidence may be attached to the PR
and durable ledger without changing tested source merely to embed its own SHA.
