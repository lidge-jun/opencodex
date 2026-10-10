# Platform verification follow-up

Baseline: dev `137d6a7270e7ecfb1c791993800a17c0e30022d9` (2026-09-07).

## Objective and authority

Satisfy the existing platform contracts for #3383, #3449, #3522 and #3573. The owner requested ordinary manual PRs, top-of-stack CI first, lower-layer CI only to diagnose a failed final run, no local test suites, push with --no-verify, admin merge after verification, and original contributor credit in commit trailers. No native GitHub stack registration. No publish, release, global settings changes, admission-limit increases, ACL relaxation, or speculative recovery policy.

The initial assigned checkout contains unrelated dirty work and is preserved. Work lives in an isolated worktree. No SessionStart FSM binding is available in the supplied context; this record documents the work without claiming automatic loop continuation is armed.

## Evidence and scope

Dockerfile, compose.yaml, docker/bootstrap-token.ts and the source-build guide already exist. Cross-platform CI has no real image build/start/recreate check. #3522 requires same-process Windows recovery evidence; #3573 requires actual rejected compact-byte evidence. Existing diagnostics must be checked before adding anything. PR #3383 is a mixed historical source: only Windows temp/teardown residuals are in scope, not picker controls.

Original Docker contributor: Buseong Kim <flight@skyline23.com>, verified from original #3421 commit metadata. Carry this identity in commit trailers.

## Dependency map

1. `010_oauth_teardown.md`: drain the asynchronous ACL fixture before deletion.
2. `020_container_smoke.md`: executable isolated container acceptance probe.
3. `030_container_ci.md`: CI consumes that probe and gates its result.
4. `035_body_diagnostics.md`: distinguish declared size, observed lower bound, and decoded size without changing admission.
5. `040_residual_evidence.md`: settle the Windows/spill/compact residuals; implement only a proven narrow gap through a plan amendment, otherwise preserve open status.

The manual review chain contains the independent OAuth fixture carry, bounded body diagnostics, the container probe, then its dependent CI integration. Independent code is prepared in disjoint files; the top CI validates their combined tree. Existing workflow triggers remain honest: final branch workflow_dispatch supplies the complete integration result; lower PR runs are not represented as passed if skipped/cancelled. Every implemented layer is reviewed, and final head is pinned before CI. After successful final CI, merge bottom-up using merge commits so reviewed commit ancestry survives. Revalidate the resulting integration and distinguish unrelated concurrent dev changes.

## Verification and completion

Local suites and typecheck are NOT RUN by owner instruction. Syntax and read-only diff checks are allowed. The real verifier is GitHub Cross-platform CI on the final branch, including the new Docker job. A failed final run is diagnosed on the smallest affected scope; do not repeatedly run passing gates. Independent Astra high review covers functionality and workflow/security boundaries. Security working notes remain in scratch, not this public unit.

Completion means verified deliverable PRs merged with commit attribution, plus explicit no-op/blocked disposition for unavailable field evidence. It does not mean every original issue is fixed. New product/security policy choices remain outside scope. Evidence and final outcome are appended to this unit; workflow run URLs and SHAs are preserved.
