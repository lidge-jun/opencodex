# 020 — wp2: PR #2437 and issue #2436, history manifest contract

## Item

`Ingwannu` PR #2437 `ingw/refactor-history-manifest-boundary-2436` -> `dev`,
head `f1774833`. Closes issue #2436, "extract the Codex history manifest
contract into a shared leaf".

Extracts manifest types, provenance validation, path identity, and backup IDs
into a pure builtin-only leaf module.

## Reviewer verdict

`gpt-5.6-sol` high, read-only:

- VERDICT PASS, disposition MERGE, risk low, no nits.
- `bun test tests/codex-history-provider.test.ts tests/codex-native-residue.test.ts tests/core-lab-boundary.test.ts` -> 142 pass / 0 fail.
- `gh pr checks 2437` -> 23 passed, 1 expected matrix job skipped, 0 failed.
- Both callers keep their filesystem, SQLite, mutation, and diagnostic
  responsibilities. No dropped export, no import cycle, core/Lab boundary intact,
  no request-body or credential logging change.

## Disposition

Merge, then close #2436 by hand. PRs here target `dev`, so GitHub does not
auto-close the linked issue.


## Execution record

Squash-merged 2026-08-23 as `81474259e` on `origin/dev`, branch deleted.
Issue #2436 closed by hand with the merge SHA and the reviewer's test evidence.
