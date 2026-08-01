# Anthropic many-image 2000px 400 fix

## Problem
User hit on live anthropic routing:

```
Provider error 400: messages.5.content.105.image.source.base64.data:
At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels
```

## Root cause (Tier-2 proven, docs.anthropic.com Vision docs, 2026-07-06)
- Normal requests allow up to 8000x8000 px per image.
- When a request carries MORE THAN 20 images ("many-image request"), the per-image
  cap drops to 2000px on either dimension; any single offender 400s the whole request.
- Hard cap: 100 images per API request.
- Models internally downscale to ~1568-2576px long side anyway, so nothing above
  2000px carries usable extra signal. LiteLLM ships the same pre-downscale default
  (MAX_LONG_SIDE_FOR_IMAGE_HIGH_RES=2000).

Codex sessions accumulate browser-comment/screenshot images in history; long threads
easily exceed 20 images, and any one retina screenshot (>2000px wide) kills the turn.

## Strategy (no new deps)
Bun has no native image resizer and we will not add sharp/jimp for this. Instead of
resizing, restore the 8000px allowance by keeping the request at <= 20 images:

1. After `messagesToAnthropicFormat` builds wire messages, collect every image block
   (user/developer content AND nested tool_result content arrays), oldest first.
2. Rule 1 (audit fix): any image sniffed >8000px on a side is textified
   unconditionally — it 400s at any request size.
3. Rule 2: if surviving count > 20 AND at least one surviving image exceeds 2000px
   on a side -> textify OLDEST image blocks in place until count <= 20, restoring
   the 8000px allowance.
4. Rule 3: hard cap — trim to <= 100 images (conservative; docs allow 100 for
   200k-context models, 600 for others).
5. Unknown formats / URL-source images count toward totals but are never treated
   as oversized (conservative). Textification is always in-place block replacement
   ({type:"text"}), never block/message removal, so tool_use/tool_result adjacency
   and the assistant-tail guard are untouched.

Rationale: newest screenshots are the ones the model actually needs; oldest history
images are usually already-described context. Textifying preserves position info.

## Files
- `src/adapters/anthropic-image-guard.ts` (new): dimension sniffers + guard.
- `src/adapters/anthropic.ts`: call guard in buildRequest after format step.
- `tests/anthropic-image-guard.test.ts` (new): crafted PNG headers, count/dimension
  matrix, tool_result nesting, 100-cap.

## Success criteria
- C1: >20 images with one >2000px -> request trimmed to 20 images, oversized newest kept.
- C2: <=20 images (any size) and >20-but-all-small -> byte-identical passthrough.
- C3: images inside tool_result blocks are counted and trimmable.
- C4: >100 small images -> trimmed to 100.
- C5: `bun test ./tests/` 0 fail, `bun x tsc --noEmit` exit 0.
- C6 (audit fix): a single >8000px image is textified even in a small request.

## Audit
gpt-5.5 reviewer (Laplace) verdict: PASS-WITH-FIXES. Fixes adopted: unconditional
>8000px pass (was missing from plan), nested tool_result traversal with in-place
textification only, JPEG SOF scan skipping APPn/EXIF segments by length and
accepting all SOF variants except DHT/JPG/DAC.
