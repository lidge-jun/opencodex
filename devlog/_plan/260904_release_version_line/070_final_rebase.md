# Final integration on current dev

The four original PR #3481 commits were rebased without moving the original
managed checkout. Workflow conflicts retain current trusted dispatch checks,
immutable action references and permissions while replacing post-publish repair
with the planned pre-move sequence. No release workflow was dispatched.

The new version-line algebra test now lives in `tests/ci-workflows/` and is
registered in both layout manifests. Existing workflow assertions and generated
PR text use the current domain paths.

`--bump` now reads origin tag refs directly instead of trusting the local tag
cache. Regression cases cover stale local/npm versions, a newer remote preview
closing the old patch line, and lookup failure before version/commit/push/dispatch.
The eight contributing pages state pre-move, reviewed merge, promotion and exact
release-commit CI prerequisites. The dispatch-guard note distinguishes protected
ref review from administrator/deploy-key bypass and an independent environment.

No local suite, typecheck, build, lint or privacy scan was executed. The maintainer
requested admin landing followed by exact-head dev CI observation. Source review
is not a claim that CI passed; the final run and merge evidence will be recorded
after the actual integration result is known.
