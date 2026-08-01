# Done — Anthropic many-image 2000px 400 fix

## What shipped
- `src/adapters/anthropic-image-guard.ts` (new): header-only dimension sniffers for
  PNG (IHDR), JPEG (SOF scan, APPn/EXIF skipped by segment length, all SOF variants
  except DHT/JPG/DAC), GIF (logical screen), WebP (VP8/VP8L/VP8X), plus
  `enforceAnthropicImageLimits(messages)` which mutates wire messages in place:
  - Rule 1: any image >8000px per side -> textified unconditionally.
  - Rule 2: if >20 images survive AND any exceeds 2000px per side -> textify oldest
    image blocks until 20 remain (restores the <=20-image 8000px allowance).
  - Rule 3: hard cap 100 images.
  - In-place `{type:"text"}` block replacement only; tool_use/tool_result adjacency
    and the assistant-tail guard are untouched. Unknown formats/url sources count
    toward totals but are never judged oversized.
- `src/adapters/anthropic.ts`: guard called in `buildRequest` right after
  `messagesToAnthropicFormat`, before tools/system/caching assembly.
- `tests/anthropic-image-guard.test.ts`: 12 tests, synthetic PNG/JPEG/GIF headers.

## Evidence (fresh, 2026-07-06)
- `bun test ./tests/`: 1517 pass, 0 fail, 158 files, exit 0.
- `bun x tsc --noEmit`: exit 0.
- Audit: gpt-5.5 reviewer (Laplace) PASS-WITH-FIXES; all fixes adopted (unconditional
  8000px pass, nested tool_result traversal, JPEG APPn skipping).

## Residual risk
- Trimming textifies oldest history screenshots; the model loses old visual context
  in >20-image threads (they are usually already described in text by then).
- No real downscaling: a request with >20 images where the NEWEST 20 still include a
  >2000px image is fixed by the trim (count drops to 20 so the 8000px cap applies),
  but a request needing >20 large images simultaneously loses the oldest ones.
- Sniffers are header-only; a malformed header means "unknown", never a drop.
- The RUNNING ocx instance must be restarted to pick this up.

## Terminal outcome: DONE
