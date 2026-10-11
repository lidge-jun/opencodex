# wp3 — omit historical images from translated compaction summaries

Carries #6150 by luvs01 (`47a1b7e039`).

## Changes

1. `git cherry-pick 47a1b7e039`: NEW `src/responses/compaction-images.ts` (replace user and
   tool-result image parts that precede a later non-empty explicit `final_answer` with a
   reopening note); MODIFY `src/server/responses/response-effects.ts` (apply only to routed
   compaction's parsed messages); MODIFY `src/lib/errors.ts` (HTTP 400 "input token count
   ... exceeds the maximum number of tokens allowed" classifies as
   `context_length_exceeded`); tests in `tests/responses/responses-compaction*.test.ts` and
   `tests/adapters/google/*.test.ts`; structure transport docs; docs-site
   `guides/codex-integration.md`.
2. Wording fix in `structure/transports/responses-failover.md` on the same line, adding no
   line: "classifies Google's HTTP 400 input-token-count overflow" becomes "classifies an
   HTTP 400 input-token-count overflow (Google's wording, matched for any provider)".

## Acceptance

- Images before a later final answer become notes; unphased, commentary-only, and pending
  images (after the last final answer) are kept.
- A 400 with the input-token wording classifies as `context_length_exceeded`; 401/403/429
  and output-token wording keep their categories.

## Verify

`bun test tests/responses/responses-compaction.test.ts tests/responses/responses-compaction-recovery.test.ts tests/adapters/google/google-errors.test.ts tests/adapters/google/google-adapter.test.ts`,
typecheck, test:changed, structure:check (600-line budget), privacy:scan, docs-site build.
