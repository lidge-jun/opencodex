# Deterministic anti-slop CI — Design

**Stack:** 4/5, based on `agent/pr-trust-lane`

This layer rejects concrete defect patterns rather than guessing whether code was AI-generated.

Blocking checks:

- runtime or dashboard behavior changed without a test change;
- newly added TypeScript/lint/formatter suppressions;
- newly focused or skipped tests;
- empty catch blocks;
- committed generated build output;
- `bun.lock` churn without `package.json`.

Narrow exception labels exist for cases that genuinely need maintainer judgment. Empty catches have no bypass because swallowing errors without behavior is not an acceptable implementation choice.

The workflow reads PR patches through GitHub APIs using trusted default-branch code and never executes the PR head.

Empty-catch detection scans hunk context as well as additions when a hunk deletes lines, so removing a catch body cannot bypass the rule. Removed generated files and removed test files are excluded from the generated-output and regression-coverage checks respectively. Exception labels are head-specific: a `synchronize` event revokes them so approvals cannot cover unreviewed new commits.
