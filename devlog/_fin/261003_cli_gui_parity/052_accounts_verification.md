# wp5 — Account policies and runtime settings from the terminal

Eighteen assigned task rows now have CLI coverage, retaining the documented human-only reset-grant consumption boundary. Pool policy and account-specific thresholds, paid-credit permission, display preferences and quota-window activation remain distinct operations. New login flags describe the selected OAuth flow; live logout never falls back to deleting local credentials.

Memory-model and compaction-routing commands accept strict full-block overrides and explicit null clears. Injection/guidance default synchronization, web streaming and vision timeout settings use their existing management owners. System switches expose their actual saved state. V2 keeps local operation as the default and uses explicit --live for runtime management; --json does not change the target. Surface acknowledgment is always explicit.

## Results and verification

The approved 050/051 design was checked by the same architect and independent functional/security reviewers. Bounded workers implemented account policy, login/logout, agent blocks and V2; main integrated identity selection, settings results, dispatch, metadata, layout and structure ownership. Independent functional review found that the guidance alias missed the new default-sync handler. The shared interception was repaired, and public-entrypoint on/off/invalid-input tests passed independently. Functional and security re-reviews both ended PASS. A separate metadata/document review found the old login-pending success-exit claim; English and six contradictory translations were corrected to the implemented exit-1 contract.

The independent functional run passed 474 tests across eight files before the alias repair; the focused repair run passed 22 tests with 126 assertions. Independent security review passed 452 tests across seven files, followed by three alias-delta checks. Integrated discovery/dispatch/skill/route/structure checks passed 241 tests across nine files. The separate V2/layout compatibility group passed 153 tests. These counts describe overlapping scoped runs, not a summed unique-test total.

Final typecheck, structure ownership, generated skill surface and privacy checks passed. The documentation build produced 561 pages and checked 77,997 internal links. New test files are registered in both layout maps without increasing size caps. The full local suite was not repeated across concurrent worktrees; broad coverage remains the exact-head hosted CI obligation for this PR.

Thirty-seven actual CLI subprocess scenarios passed with separate stdout/stderr/exit and request/state artifacts. They exercised unsupported pool fields, explicit false/null, one/all credit scope, quota-window spelling, read-only grants, login applicability, local/live logout, pending settings, alias dispatch, sidecar field ownership, memory/compaction replacement, V2 target selection, literal hints and native partial outcomes. QA blocked all sockets, used synthetic homes and a management fixture, verified configuration hashes, and removed its temporary tree after every child exited. No live proxy, account, browser, provider call or native application was exercised.

Evidence is retained under `.tmp/cli-parity/wp5-*` and `.codexclaw/evidence/01a10024-8d6f-7500-b528-38212c4bc396/qa/parity-wp5/`. The work-phase receipt binds final verification to the source tree; GitHub CI receipts are recorded separately at publication.

## Limits and next phase

A stored setting does not prove client convergence. Pending or missing apply evidence remains nonzero; unknown local V2 synchronization is not success. Login fixtures prove parser/flow/transport contracts, not a live OAuth login. Grant inspection can call the existing upstream status service but never consumes a grant. Pool and generic settings writes do not gain revision CAS.

The disproved assumption was that adding the canonical injection interception automatically covered the established guidance alias. Future equivalent spellings must exercise public dispatch. Any observed cross-target fallback, paid-policy change from a display setting, or success without required confirmation reopens this phase. Next is wp6, revalidating integration preview/recovery, maintenance and Hub reads from its own P/A cycle.
