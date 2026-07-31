# Plan: Consolidate duplicate abort/sleep helpers into upstream-retry

**Date:** 2026-07-03 · **Class:** C2 (behavior-neutral refactor, 2 files) · Follow-up from
`260703_chatgpt-upstream-reset-retry` (audit item: google/cursor duplicates deliberately deferred).

## Diff-level plan

### MODIFY `src/adapters/google-http.ts`
- Delete local `abortError` (:25-27) and `sleepWithAbort` (:29-39) — byte-identical to the
  canonical copies in `src/upstream-retry.ts`.
- Add `import { abortError, sleepWithAbort } from "../upstream-retry";`.
- No other changes; `retryAfterMs`/`retryDelayMs` stay local (their constants differ from
  upstream-retry's and parameterizing them is behavior-affecting scope creep).

### MODIFY `src/adapters/cursor/transport-retry.ts`
- Delete local `abortError` (:39-41) and `abortAwareSleep` (:43-62) — same semantics as the
  canonical helpers.
- Add `import { abortError, sleepWithAbort } from "../../upstream-retry";` and call
  `sleepWithAbort` at the former `abortAwareSleep` call site (:108).
- Preserve the public export surface: `export { sleepWithAbort as abortAwareSleep } from "../../upstream-retry";`
  (search evidence: no importer of `abortAwareSleep` outside this file in src/ or tests/, but
  the export is kept per preserve-existing-exports rule).

## Non-goals
- Consolidating `retryAfterMs`/`retryDelayMs` (kiro/google share constants 250/2000; upstream-retry
  uses 150/1000 — merging requires parameterization, separate slice if ever).
- Any behavior change. Import direction is adapters → upstream-retry (leaf), so no cycles.

## Verification
- `bun test ./tests/` full suite (google-vertex-http, cursor transport tests included) + `npx tsc --noEmit`.
