# 080 — Phase 9: vision raw-body image synchronization (PR #1047)

Credit: **Bailey** (`baileyh8 <email from PR head>`), PR #1047.
Adoption: **adapted** — one remaining leak closed.

## Defect (verified on `dev` = e9d957bf6)

`describeImagesInPlace` (`src/vision/index.ts:347`) rebuilds each message,
replacing image parts with their descriptions in `parsed.context.messages`
(`:426`), and `stripImagesInPlace` (`:453`) does the same with an
"[image omitted…]" placeholder.

Neither touches `parsed._rawBody`. The native Responses passthrough adapter
serializes `_rawBody`, while translated adapters serialize `context.messages` —
so on the passthrough path the original pixels are still sent to a text-only
upstream *after* the sidecar produced a caption. There is no
`syncRawBodyImageDescriptions` on `dev` (`rg` returns no matches); the whole
function is new in #1047.

## Why adapted

#1047 adds `syncRawBodyImageDescriptions` and calls it at the end of both
`describeImagesInPlace` and `stripImagesInPlace`. The mechanism is correct and
the E2E coverage is strong. Two conditions in the contributor's function make it
a partial fix:

- It returns early when `descriptions.length === 0`, so a caption pass that
  produced nothing leaves the raw images in `_rawBody` — the failure path is the
  one that leaks.
- When `descriptions[nextDescription++]` is `undefined` (fewer captions than
  images) it returns the original `input_image` part unchanged, so a partial
  caption pass still forwards raw pixels.

## Change

Cherry-pick #1047, then close both failure paths.

| Path | Op | Content |
|------|----|---------|
| `src/vision/index.ts` | ADOPT | `syncRawBodyImageDescriptions` (+ `isPlainRecord`) after `renderDescription` (~`:275`), called at the end of `describeImagesInPlace` (~`:506`) and `stripImagesInPlace` (~`:535`) |
| `src/vision/index.ts` | ADAPT | **Change from #1047:** drop the `descriptions.length === 0` early return so normalization runs regardless; when no description is available for an image, substitute the same "[image omitted…]" text `stripImagesInPlace` uses rather than returning the raw part |
| `tests/vision-sidecar-e2e.test.ts` | ADAPT | Bailey's +195 lines plus: zero-caption path and fewer-captions-than-images path, each asserting no `input_image` survives in `_rawBody` |

## Verification

- `bun test tests/vision-*.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 08, base = stack 07 head. Credits Bailey; names the two failure-path gaps
added on top of their patch.
