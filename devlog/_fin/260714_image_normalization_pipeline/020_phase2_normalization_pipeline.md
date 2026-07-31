# 020 — Phase 2: tiered normalization pipeline (Bun.Image)

## Behavior contract

Any base64 image of any real-world dimension/size is RESIZED/RE-ENCODED to fit Anthropic
limits instead of being dropped. Age-tier pyramid keeps every image visible:

| Tier | Which images (newest-first index) | Max long edge | Encode | HARD base64 cap |
|------|-----------------------------------|---------------|--------|-----------------|
| 0 | newest 6 | 2000px | keep format if fits, else JPEG ladder 80/60/40 | 2MiB (ladder continues to q30 until under) |
| 1 | next 14 (7-20) | 1024px | JPEG q70→q50 ladder | 512KiB |
| 2 | rest (21+) | 700px | JPEG q60→q40 ladder | 192KiB |
| floor | demotion target | 500px | JPEG q40 | 100KiB soft; terminal ladder below |

**Terminating ladder (audit round 2, blocker 1):** the floor is not a single encode —
it is a deterministic sequence 500px/q40 → 400px/q30 → 320px/q25 (terminal). An image
whose TERMINAL encode still exceeds 100KiB (incompressible noise) keeps its measured
terminal size and counts as "floored" at that size. The aggregate loop therefore always
terminates: every demotion strictly reduces the ladder position, and the loop ends when
Σ(measured) ≤ budget or all images are terminal-floored. Zero-textify claim, stated
honestly: guaranteed when Σ(terminal-floored measured sizes) ≤ budget — true for
photographic/screenshot content ≤ ~180 images; a noise-fixture test asserts termination
and the either-fits-or-textifies contract (no hang, no spiral).

**Aggregate invariant (audit rounds 1+3):** per-tier caps are enforced by continuing the
quality/dimension ladder until the tier's HARD base64 cap is met (or the terminal step is
reached — see terminating ladder above). After per-tier encoding, an aggregate pass runs:
while Σ(measured base64) > Rule 4 budget (20MiB), demote the OLDEST not-yet-terminal
image one ladder position (re-encode, distinct cache key). Textify fires only when every
image is terminal-floored AND Σ(measured) still exceeds budget. Zero-textify is therefore
CONDITIONAL, not universal: it holds iff Σ(terminal-floored measured sizes) ≤ budget —
which representative screenshot/photo content satisfies comfortably at 100 images
(typical terminal encodes ≤ 100KiB ⇒ Σ ≈ 10MiB). The 100-image activation test uses
representative fixtures and asserts zero textify + Σ ≤ budget for THAT corpus; N7 covers
the adversarial incompressible case (either-fits-or-textifies, terminates).

Guards (unchanged philosophy, now BEFORE decode) — single consolidated rule (audit round
3 blocker 2; C-gate rounds 1-2): input base64 > 64MiB (compressed-file proxy) or sniffed
pixels > 100MP (decoded-RGBA proxy) → textify (decode-bomb guard, no decode attempt);
URL sources pass through untouched; valid sniffed GIF/WebP animations within the
per-image cap are pass-through-exempt from RE-ENCODING (re-encode would drop animation)
but, like every pass-through, are decode-VALIDATED once (resize-forced pixel decode,
cached); any decode/validation FAILURE means corrupt/unsupported → textify with the
distinct "[image omitted: undecodable]" note (N6/N6b assert it). Over-cap animations are
re-encoded (first frame).

## New file `src/adapters/anthropic-image-normalize.ts`

- `export interface NormalizeOptions { tierBias?: number }` (tierBias consumed by 030).
- `export async function normalizeAnthropicImages(messages: unknown[], opts?): Promise<void>`
  — collect refs via the SAME collector as the guard (EXPORT `collectImageRefs` +
  `ImageBlockRef` from `anthropic-image-guard.ts` instead of duplicating; guard keeps
  its own call), assign tiers newest-first (wire order reversed), per ref:
  1. cache lookup `hash(base64) + tier` → hit: swap in cached {mediaType, data}, done;
  2. decode-bomb guard → textify;
  3. skip if already within tier bounds (dimensions from existing `sniffImageDimensions`,
     base64 length within tier target) — cache a pass-through marker;
  4. `Bun.Image` decode → resize to tier long-edge → encode (ladder per tier table) →
     replace `source.data`/`media_type` in place; store in cache;
  5. decode failure (audit round 2, blocker 2) → distinguish: formats the pass-through
     rule already exempts (valid sniffed GIF/WebP animation within caps) are never
     decoded; anything else that FAILS decode is corrupt/unsupported-by-Anthropic →
     textify with a distinct "[image omitted: undecodable]" note (a reachable one-image
     corrupt payload otherwise 400s upstream — guard's count/size rules do not catch it).
     Count a `normalize_failed` stat either way.
- Cache: module-level byte-weighted TRUE-LRU (audit blocker 2; C-gate rounds 1-2), key
  `hash:mediaType:position`, value = normalized source, validated "pass" marker, or
  "miss" marker (position's ladder cannot meet its cap for these bytes — skip to the
  next position without re-encoding). AGGREGATE cap 64MiB of stored base64; reads
  refresh recency; puts subtract any existing key first. Worst single entry 2MiB, so
  real memory is bounded at ~64MiB + overhead. Entries are immutable snapshots —
  demotion writes NEW position-keyed entries and never mutates a cached value.
- Encoder seam (audit amendment, blocker 6): the module exposes an injectable encode
  function (options field, default Bun.Image path) plus an encode-invocation counter so
  the cache-hit test asserts "second call performed 0 encodes", not a size tautology.
- Deterministic: same input+tier ⇒ identical output bytes (single encoder path, fixed
  options) — prompt-cache friendly.

## MODIFY `src/adapters/anthropic.ts`

- In `buildRequest` (current guard call site ~:598): `await normalizeAnthropicImages(messages)`
  BEFORE `enforceAnthropicImageLimits(messages)` (guard demoted to backstop). Production
  callers already await buildRequest (`src/server/responses.ts:671,920,963`,
  `src/web-search/loop.ts:265`).
- **Caller migration (audit amendment, blocker 1):** buildRequest becoming genuinely
  async breaks SYNC consumers in tests — `tests/client-fingerprint.test.ts:74-87`,
  `tests/anthropic-hardening.test.ts:29-54`, `tests/anthropic-tail-guard.test.ts:16-18`
  (property access + synchronous-throw assertions). B enumerates every
  `rg 'buildRequest' tests/` hit on the anthropic adapter and migrates them to
  await/rejects patterns as part of this phase's diff.

## MODIFY `src/adapters/anthropic-image-guard.ts`

- Export the currently-private `collectImageRefs`/`ImageBlockRef` (guard-internal today,
  `anthropic-image-guard.ts:127-139`); normalization reaches the block through
  `container[index]` or an added `source` accessor on the ref type. No rule changes.
- **Header rationale update (audit amendment, blocker 5):** the file header currently
  justifies textify with "Bun has no native resizer" (`:9-13`) — rewrite to reference the
  normalization pipeline as the primary layer and the guard as backstop, keeping the SoT
  comment accurate per 000_plan.md.

## B-phase task order

1. **Probe first** (recorded in this doc at B): `Bun.Image` API shape + decode/encode
   coverage PNG/JPEG/WebP/GIF + corrupt-input behavior, via a scratch bun script with
   generated fixtures. Coverage gap ⇒ STOP, record sharp-fallback P amendment.
2. Implement module + wiring; 3. tests.

### Probe record (B, 2026-07-14, bun 1.3.14)

- API: `new Bun.Image(buffer)`; `.metadata()` → `{width, height, format}`;
  `.resize(width, height?, options?)` (positional — options-object form rejects);
  `.jpeg({quality}|number)`, `.png()`, `.webp({quality})`, `.avif()`, `.heic()`;
  `.toBuffer()/.toBase64()`. Chainable, promise-returning.
- Decode coverage: error text enumerates "expected JPEG, PNG, WebP, GIF, BMP, TIFF,
  HEIC or AVIF" — verified live: png✓ webp✓ gif✓ jpeg✓ (roundtrips).
- Corrupt input: `.metadata()` and encode both throw clean `Error: Image: unrecognised
  format ...` — decode-failure textify path is implementable as planned.
- Conclusion: NO sharp fallback needed; proceed with Bun.Image.

### C-gate repair round 1 (fresh sol reviewer, FAIL blockers=5 — dispositions)

1. FOLDED: pass-through now runs a full-decode validation once per unique image
   (`validate` seam, default `resize(1,1).jpeg(1)` — forces pixel decode); truncated
   sniffable payloads textify (test N6b).
2. REBUTTED with doc fix: the bomb guards are, and were implemented as, (a) input
   base64 > 64MiB (compressed-file proxy) and (b) sniffed pixels > 100MP (decoded RGBA
   proxy, ≤ ~400MB transient worst case, paid once per unique image thanks to the
   cache). The earlier "decoded estimate > 64MiB" wording conflated the two; a 64MiB
   RGBA ceiling (~16MP) would reject ordinary photos and contradict the generous
   contract. This section is the authoritative wording.
3. FOLDED: entries now track sourceB64/sourceMedia (original) separately and recompute
   `size` from the block's ACTUAL current bytes after every step — accounting can no
   longer drift from reality.
4. FOLDED: cache keys are `hash:mediaType:pos` — pass verdicts cannot leak across media
   types (test added).
5. FOLDED: cachePut subtracts existing-key sizes (concurrent-miss double-count) and
   cacheGet refreshes recency (true LRU).
Residuals folded too: normalization skips images beyond the newest 100 (guard drops
them anyway — no wasted encodes); representative 100-image zero-textify test and N7b
guard-integrated either-fits-or-textifies test added.

## Tests `tests/anthropic-image-normalize.test.ts`

Real encoded fixtures (generate PNGs via Bun.Image or raw encoder at runtime):
- N1: 4000×3000 PNG (>tier0 edge) → resized ≤2000px, decodable, base64 ≤ 2MiB
  (tier-0 HARD cap, audit round 2 blocker 4).
- N2: 30 images → indices per tier; oldest are ≤700px JPEG; NO textify anywhere.
- N3: cache hit — second call with same input returns identical bytes and performs
  ZERO encoder invocations (encoder-seam counter; no size-based alternative — audit
  round 2 blocker 5).
- N4: decode-bomb guard (fake dims header claiming 20000×20000 with tiny payload →
  textified without decode attempt).
- N5: URL image untouched; N6: undecodable garbage → textified with the undecodable
  note (audit round 2 blocker 2). N7: incompressible-noise image → terminal ladder
  completes, request either fits budget or textifies per contract (termination proof).
- Integration: guard+normalize together on a 40-image over-budget set → all images
  survive as tiers, Rule 4 does not fire (activation: delete normalize call ⇒ Rule 4
  fires — assert both directions).

## Accept criteria (criteria c3, c4)

Per goalplan; plus full gates green and probe record present in this doc.
