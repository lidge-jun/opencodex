# 010 — Verification record (D close, 2026-07-14)

## Outcome: DONE

## Changed files

- `src/adapters/anthropic-image-guard.ts` — Rule 1b (per-image 5MiB cap, padding-exact
  `base64DecodedBytes`) + Rule 4 (20MiB total base64 budget, oldest-first base64-only eviction
  with live-set bookkeeping); constants `MAX_IMAGE_FILE_BYTES`, `TOTAL_IMAGE_BASE64_BUDGET` exported.
- `tests/anthropic-image-guard.test.ts` — `pngHeaderBytes`/`bigPngBase64` fixtures + byte-limit
  suite B1-B6 (multi-eviction, under-budget dormancy, per-image cap, exact-5,242,880-byte boundary,
  dimension-rule interaction, URL-never-evicted).

## Evidence

- Targeted: `bun test --isolate ./tests/anthropic-image-guard.test.ts` → 20 pass / 0 fail / 55 asserts.
- Full gates: `bun x tsc --noEmit` exit 0; `bun test --isolate ./tests/` → 2415 pass / 0 fail (230 files).
- A gate: sol reviewer (Banach) GO-WITH-FIXES blockers=6 → all folded (see 000_plan.md §Audit round 1).
- C gate: fresh sol reviewer (Archimedes) VERDICT: PASS, blockers none; independently confirmed
  activation grounding (Rule 1b deletion → B3 fails; Rule 4 deletion → B1/B6 fail) and reran tests.
  Two prior C reviewers lost to transient ocx stream disconnects (proxy health verified: /v1/models
  200, pid alive); retried per DISPATCH-RETIRE-01.

## Residuals (documented, out of scope)

- A request dominated by non-image content can still 413 (guard bounds the image share only;
  rationale comment at `src/adapters/anthropic-image-guard.ts` TOTAL_IMAGE_BASE64_BUDGET).
- Non-canonical base64 (whitespace/excess padding) conservatively overestimates size — safe direction.
- The RUNNING /opt/homebrew/bin/ocx (pid 25337) still serves the old code; fix takes effect on
  rebuild/restart or next release (release explicitly out of scope for this goal).

## What did not change / hypothesis check (LOOP-PESSIMIST-01)

- Local decompress-cap theory rejected early: 256MiB cap (`src/server/request-decompress.ts:21`)
  produces a different error message than the observed "Provider error 413".
- Full-body measurement alternative rebutted (would need post-serialization re-trim loop);
  falsifier: if 413s recur with <20MiB image share, that rebuttal was wrong — revisit two-pass trim.
