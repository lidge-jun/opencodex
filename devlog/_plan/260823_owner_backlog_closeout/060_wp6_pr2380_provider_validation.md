# 060 — wp6: PR #2380 and issue #2379, provider validation boundary

## Item

`Ingwannu` PR #2380 `ingw/refactor-provider-validation` -> `dev`. Closes issue
#2379, "extract provider validation from config persistence".

Moves 11 pure provider-validation helpers and three supporting constants into a
focused leaf module.

## Reviewer verdict

`gpt-5.6-sol` high, read-only:

- VERDICT PASS, disposition MERGE, risk low, no actionable findings.
- `bun test tests/provider-config-validation.test.ts tests/management-provider-validation.test.ts tests/management-origin-tls.test.ts tests/server-auth.test.ts tests/core-lab-boundary.test.ts` -> 187 pass / 0 fail.
- `bun test tests/config.test.ts` -> 153 pass / 0 fail. `bun run typecheck` -> pass.
- `gh pr checks 2380` -> 23 pass, 1 skipped, 0 failures.
- All function bodies match the originals. `src/config.ts` retains every
  compatibility re-export while direct consumers take the narrower dependency.
  Auth/CORS behavior, logging, persistence, response shapes, and the core/Lab
  boundary are unchanged. The current dev merge tree is clean.

This PR touches provider validation, which sits next to the auth surface, so the
reviewer was asked to trace it as a security-adjacent change. It found no
behavior delta in auth or CORS handling.

## Disposition

Merge, then close #2379 by hand.

