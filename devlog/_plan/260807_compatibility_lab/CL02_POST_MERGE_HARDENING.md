# CL-02 Post-Merge Hardening

CL-02 merged to `dev` in upstream PR #1333 at merge commit `025c37916225dd685d9217e5b40190600f06d278`.

A final CodeRabbit review batch arrived immediately before that merge and identified additional post-merge hardening work. This follow-up stays within CL-02 implementation and regression coverage; CL-03 is not started here.

## Confirmed remediation scope

- Preserve UTF-8 byte ordering and ownership across chunked ledger replay.
- Bound memory and corruption accounting for oversized unterminated JSONL lines.
- Keep content-addressed artifact publication idempotent under concurrent writers while preserving symlink/hardlink rejection and final digest verification.
- Classify malformed contract artifacts as artifact mismatches rather than generic harness failures.
- Reject embedded raw POSIX filesystem paths in persisted event strings.
- Include `export` in the default sensitive-evidence purge action set.
- Fail closed on unmapped conformance failure classifications.
- Make execution timestamps a typed `ScenarioRunResult` producer output instead of relying on a cast at the CL-02 persistence seam.
- Add focused regressions for each behavior above and reconcile the remaining post-merge review findings without changing frozen CL-00 semantics.

## Base

- Upstream base: `dev`
- Base commit: `025c37916225dd685d9217e5b40190600f06d278`
- Follow-up branch: `fix/cl-02-post-merge-hardening`
