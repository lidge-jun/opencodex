# 010 — Phase 1: Rule 1b unit fix (base64 length, not decoded bytes)

## Why

The API's 5MiB per-image cap is measured on the base64 STRING LENGTH (001 §1). Rule 1b
currently textifies when the DECODED estimate exceeds 5MiB (base64 ≈ 6.99MiB), so images
with base64 length in (5,242,880 .. 6,990,506] slip through and 400 upstream.

## Diff plan

### MODIFY `src/adapters/anthropic-image-guard.ts`

- `MAX_IMAGE_FILE_BYTES` doc comment: state the unit is base64 chars, cite 001 §1.
  Rename to `MAX_IMAGE_BASE64_LENGTH` (export kept: add deprecated alias
  `MAX_IMAGE_FILE_BYTES = MAX_IMAGE_BASE64_LENGTH` to preserve the existing export
  per dev §5 safety rules — tests migrate to the new name).
- Rule 1b condition: `b64.length > MAX_IMAGE_BASE64_LENGTH` (drop the decoded estimate).
- `base64DecodedBytes` helper: DELETE if no remaining caller (verify with rg before
  removal; it was introduced this session and is not exported).
- `PER_IMAGE_TOO_LARGE_TEXT` stays accurate ("5MB per-image limit" — still true, the
  unit note lives in the constant comment).

### MODIFY `tests/anthropic-image-guard.test.ts`

- B3: fixture sized so base64 length > 5,242,880 but decoded < 5MiB (e.g. decoded
  4,194,304 bytes → base64 5,592,408) — proves the GAP case now textifies (this test
  FAILS on the old code: activation grounding).
- B4 boundary: fixture with base64 length exactly 5,242,880 (decoded 3,932,160, no
  padding) survives untouched.
- Update any test importing `MAX_IMAGE_FILE_BYTES` to the new name.

## Accept criteria (criterion c2)

- New B3 red-on-old-code / green-on-new-code (state in attest).
- Targeted file + full `bun test --isolate ./tests/` + `bun x tsc --noEmit` all exit 0.
