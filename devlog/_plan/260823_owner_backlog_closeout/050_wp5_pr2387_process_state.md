# 050 — wp5: PR #2387 and issue #2378, proxy process-state ownership

## Item

`Ingwannu` PR #2387 `ingw/refactor-process-state` -> `dev`. Closes issue #2378,
"extract proxy process-state ownership from config persistence".

Extracts OpenCodex-home paths, atomic writes, and PID/runtime-port ownership into
three acyclic config leaf modules, keeping `src/config.ts` compatibility exports.

## Reviewer verdict

`gpt-5.6-sol` high, read-only:

- VERDICT PASS_WITH_NITS, disposition SQUASH_MERGE, risk medium.
- Eight suites (`process-state`, `config`, `process-control`, `proxy-liveness`,
  `port-reclaim`, `service`, `update-job`, `core-lab-boundary`) -> 472 pass / 0 fail.
- `stale-state-purge` -> 4 pass / 0 fail.
- Synthesized current-`dev` merge -> 473 pass / 0 fail, `bun run typecheck` passed.
- `gh pr checks 2387` -> 29 pass, 1 skipped, 0 failures.
- Lifecycle, management, service, OAuth, and update callers import process state
  directly without changing their destructive identity checks. No request-body or
  API-key logging, no dropped runtime export, no import cycle, no core-to-Lab edge.

## Nits, recorded not held

- `tests/process-state.test.ts:6` — the dedicated suite does not exercise
  `readAlivePid()`, `verifyPidIdentity()`, or the `EPERM` behavior #2378 asks for.
- `tests/config.test.ts:2216` — process-state characterization is duplicated;
  owner behavior should move fully to `process-state.test.ts`.

Both are test-ownership improvements on a behavior-preserving extraction whose
coverage already runs 472 green. Recorded as follow-up rather than blocking a
maintainer refactor that is otherwise clean.

## Disposition

Squash-merge, then close #2378 by hand.


## Execution record

Squash-merged 2026-08-23 as `b6c7c0afe` on `origin/dev`, branch deleted.
Issue #2378 closed by hand with the merge SHA, the reviewer's evidence, and the
two test-ownership follow-ups stated openly rather than quietly dropped.
