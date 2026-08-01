# 000 — Plan: Anthropic 413 image byte-budget guard

## Symptom / RCA

- Symptom: image-heavy Codex session on `anthropic/claude-fable-5` fails every turn with
  `unexpected status 413 Payload Too Large: Provider error 413` from `http://127.0.0.1:10100/v1/responses`.
- Forwarding point: `src/server/responses.ts:984` wraps the upstream non-OK body as
  `Provider error <status>: ...` — the 413 is Anthropic's, not ocx's (local decompress cap is 256MB,
  `src/server/request-decompress.ts:21`, and would produce a different message via
  `decodeRequestErrorResponse`, `src/server/responses.ts:404-410`).
- Upstream contract (verified 2026-07-14, docs + anthropic-sdk/claude-code issues):
  Messages API rejects raw HTTP bodies > 32MB with 413 `request_too_large` (Cloudflare-level,
  counts base64 chars as bytes); separately each image > 5MB (5,242,880 bytes decoded) 400s with
  "image exceeds 5 MB maximum".
- Gap: `enforceAnthropicImageLimits` (`src/adapters/anthropic-image-guard.ts:155`, wired at
  `src/adapters/anthropic.ts:598`) enforces count (20 many-image threshold, 100 hard cap) and
  per-side dimensions (2000/8000px) but never total BYTES. ~15+ screenshots at ~1.5-2MB each pass
  count/dimension rules yet push the JSON body past 32MB; history persists, so the session is
  permanently poisoned.

## Loop-spec header

- Archetype: spec-satisfaction repair (verifier defines done).
- Trigger: user-reported 413 on image-heavy fable-5 session.
- Goal: image-heavy Anthropic requests self-trim below the 32MB cap; sessions recover instead of hard-failing.
- Non-goals: other adapters (google/kiro), downscaling/re-encoding, new deps, release.
- Verifier: `bun test --isolate ./tests/anthropic-image-guard.test.ts` + full `bun test --isolate ./tests/` + `bun x tsc --noEmit`.
- Stop: all gates exit 0 + sol reviewer PASS. Escalation: LOOP-REPAIR-01 after 2 failed repairs.
- Delegation: sol reviewer at A (plan audit) and C (diff+tests adversarial review); main session owns all writes.

## Diff-level plan

### MODIFY `src/adapters/anthropic-image-guard.ts`

New exported constants (with rationale comments):
- `MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024` — Anthropic per-image decoded cap (400 "image exceeds 5 MB maximum").
- `TOTAL_IMAGE_BASE64_BUDGET = 20 * 1024 * 1024` — budget on the SUM of base64 char lengths
  (base64 chars ≈ raw HTTP body bytes for the image share). Audit amendment (blocker 2): the guard
  runs before system/tools attach and cannot see the final serialized body, so this is an
  image-share bound, not a whole-request bound. 20MiB leaves ≥11MB headroom even against a decimal
  32,000,000-byte cap; realistic non-image share (context-capped text history + tool schemas) is
  <3MB. Residual: a request dominated by non-image content can still 413 — documented, out of scope.

New omitted-texts:
- `PER_IMAGE_TOO_LARGE_TEXT` — "[image omitted: exceeds Anthropic's 5MB per-image limit]"
- `BYTE_BUDGET_TEXT` — "[image omitted: total image payload exceeded Anthropic's 32MB request limit; older screenshots were dropped]"

Helper: `base64DecodedBytes(b64)` = `(len/4)*3` minus trailing `=` padding count (audit amendment,
blocker 5: naive `floor(len*3/4)` rejects a valid image at exactly 5MiB).

`enforceAnthropicImageLimits` rule changes (mutation-in-place contract unchanged, no signature change →
`src/adapters/anthropic.ts` untouched):
- Rule 1b (after existing 8000px Rule 1): any base64 image with decoded size > `MAX_IMAGE_FILE_BYTES`
  → textify `PER_IMAGE_TOO_LARGE_TEXT`, remove from `live`. Invalid in any request, so unconditional.
- Rules 2 (many-image 2000px) and 3 (100 cap) unchanged.
- Rule 4 (new, last): `sum = Σ base64.length` over live refs with non-null base64 (audit amendments,
  blockers 1+3: URL-source refs are never candidates — they add no body weight; each eviction
  textifies the oldest live base64 ref with `BYTE_BUDGET_TEXT`, calls `live.delete(i)`, and subtracts
  its length exactly once, mirroring rules 1-3's bookkeeping). Loop until `sum <= budget` or no
  base64 candidates remain. Newest-first survival by construction (refs are wire-order).

### MODIFY `tests/anthropic-image-guard.test.ts`

Activation-grounded cases (C-ACTIVATION-GROUNDING-01 — each new branch demonstrably fires):
1. Over-budget total, multi-eviction: 6 images × 6MiB base64 (each ~4.5MB decoded — under per-image
   cap so only Rule 4 fires) = 36MiB > 20MiB → oldest 3 textified with `BYTE_BUDGET_TEXT`, newest 3
   intact; assert surviving base64 sum <= `TOTAL_IMAGE_BASE64_BUDGET` (audit amendment, blocker 4).
2. Under-budget: small images untouched (byte rule dormant).
3. Per-image cap: one image > 5MB decoded → `PER_IMAGE_TOO_LARGE_TEXT` even when total budget
   otherwise fine; siblings intact. Exact-boundary: an image of exactly 5,242,880 decoded bytes
   (with `=` padding) survives (audit amendment, blocker 5).
4. Interaction: >8000px image textified by Rule 1 does not count toward Rule 4's sum
   (budget then satisfied without further drops).
5. Mixed URL/base64 ordering: oldest ref is a URL image followed by over-budget base64 images →
   URL image survives, oldest base64 refs are evicted (audit amendment, blocker 3).
6. Existing tests unchanged and green (count/dimension semantics preserved).

## Audit round 1 (sol reviewer, GO-WITH-FIXES blockers=6)

Dispositions: 1 folded (live-set bookkeeping), 2 folded via 20MiB budget + narrowed image-share claim
(full-body measurement rebutted as disproportionate: requires post-serialization re-trim loop;
residual documented), 3 folded (base64-only candidates), 4 folded (test matrix expanded),
5 folded (padding-exact estimate + boundary test), 6 folded (line ref fixed).

## Accept criteria

- Goalplan c1-c4 (`.codexclaw/goalplans/fix-ocx-413-payload-too-large-on-image-heavy-ant/goalplan.json`).
- Gates: targeted test file, full `bun test --isolate ./tests/`, `bun x tsc --noEmit` — all exit 0, fresh output.
- Sol reviewer verdict PASS at A and C.

## Pre-write search evidence (DEV-NECESSITY-01)

- No-code options rejected: cannot configure around an upstream byte cap; deletion N/A; reuse —
  extending the existing owner (`anthropic-image-guard.ts`) IS the reuse path (no parallel helper).
- Searches: `rg 'Provider error|413|Payload Too Large'`, `rg 'input_image|base64' src/adapters/`,
  `rg 'enforceAnthropicImageLimits'` → single owner + single call site + existing test file confirmed.
