# Lane C: independently reviewable 2.48 preparation fixes

Scope: satisfy-spec HOTL requested by the owner on 2026-09-08. Goal: independently land #3953, #3899 and the timezone-only part of #3950 into dev, retaining original authors. This returned/stored roadmap is the memory artifact. Baseline dev: `514350e6f79ed4539378388bc39d3fc79ff2c70c`. No resource budget was specified; native host limits apply. Tool scope: local Git/source/artifact checks, GitHub repository/Actions, and explicitly authorized A/B coordination; astra high read-only auditors. No local product tests, typechecks, builds or dependency installation, including incidental Git-hook execution. Use per-command `git -c core.hooksPath=/dev/null` for mutating Git operations, and `push --no-verify`; do not modify shared Git configuration.

## Work phases and ownership

`roadmap` (this docs-only full PABCD) precedes three independent delivery cycles: `privacy`, `release_notes`, `timezone`. `reconcile` depends on those deliveries and lane B's JWT evidence. The processing order is scheduling, not a code dependency: each delivery remains a separate dev-targeted PR. Reuse original #3953 if unchanged and reviewable; carry #3899 onto current dev if needed; timezone gets a new PR sourced from only commit 1d8f6ff7e8d48f33c3ce7a1b7118068754bbbe83. Never create a combined code-delivery PR or squash different bugs together. Local roadmap/outcome commits stay on this coordination branch until a separate documentation-only closeout is appropriate. A separately audited evidence-only workflow branch may add supplemental hosted platform proof without entering any delivery PR or changing its required CI.

## Boundaries

No JWT changes, provider/routing work, main/preview promotions, version changes, deployments, release execution, live-account/service probes, history rewriting or public reproduction of removed material. Confidential investigation stays in ignored `.tmp/c248/`. The public docs describe only approved correction scope, not sensitive values. No new runtime type/enum/field is added, so creation/serialization/deserialization/consumer field-chain work is N/A.

## Verification contract

The roadmap uses actual file and source-object inspection plus `git diff --check` (run in this checkout before the roadmap close). Delivery uses the repository's existing hosted CI on each PR's current head; source-sensitive suites and the actual workflow scope must be checked. Local product commands are explicitly NOT RUN. No blind retries, cancelled/skipped/pending-as-pass, broad test weakening or artificial screenshots. A docs-only scope check is not a product-suite pass. Head rewrites require fresh current-head evidence. If dev moves, classify the actual delta and do not claim an unexecuted integration tree was tested. Before merge, validate required gates and exact head; preserve unrelated destination changes and prove the landed source diff.

## Integration coordination

The active A and B workstreams agreed on `<common-git-dir>/ocx-248-dev-merge.lock`: atomic mkdir, owner.json with sessionId/pid/hostname/PR/SHA/acquiredAt, owned only from final refresh through landed verification. Never hold it while waiting for CI or delete another owner's lock. This is a cooperative serialization convention, not a security boundary; an uncooperative actor can bypass it. The main thread resolves collisions, missing permissions or contradictory evidence without expanding worker scope; a new worker slice requires a plan amendment, and two distinct failed workers return the slice to main.

Use the repository PR template and MAINTAINERS.md. Explicit maintainer integration is allowed only after checking live identity/role, outstanding objections, required CI, and required security review. Existing PR head authors remain attributed; carried commits use cherry-pick provenance and a Co-authored-by trailer surviving squash. After landing, verify merge SHA ancestry, actual file delta, destination preservation, and authors. Close original carry PRs only then. #3950 stays open until both timezone and B JWT fixes are proven on dev; C owns final closure. A/B status contributes to a readiness report, not release authority.

## Stop and outcomes

DONE requires all three delivered/proven already present and #3950 reconciled; final report lists source PR, delivery PR, landed SHA, actual CI results, authors and residuals. A blocked item does not stop independent work. Missing authority or unsafe evidence is unresolved, not a successful criterion. Read goalplan/ledger after each D and continue remaining cycles. Scope does not include a fixed cost/time budget or new paid service purchases.

## Roadmap audit and completion

Independent astra high roadmap audit: PASS, no blocking findings. The timeout prose was aligned with the dedicated child marker used in the exact patch. The roadmap-only check is Git diff whitespace plus independent source/semantic audit; no product suite was run. Next cycle: adopt and validate the unchanged #3953 correction.

## Final reconciliation

Privacy and release-note cycles completed before the timezone cycle. All delivery evidence and residuals are in050_outcome.md. Original3950 closed after both BJWT and Ctimezone landing proof. This unit archives to_fin through a separate docs-only PR; no product commit is combined with this record.
