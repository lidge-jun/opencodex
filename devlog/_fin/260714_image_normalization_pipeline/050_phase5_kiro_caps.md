# 050 — Phase 5: kiro (CodeWhisperer/Bedrock-Claude) image caps

## Limits research (P, 2026-07-14; audit round 1 correction)

Kiro calls `AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
(src/adapters/kiro.ts:34,539) whose payload limits are UNDOCUMENTED. The nearest
grounded references are adjacent Bedrock surfaces: 20 images per `Message`
(Converse/ConverseStream, AWS API_runtime_Message) and 25,000,000 bytes per
`InvokeModel` request (AWS API_runtime_InvokeModel); Bedrock-Claude per-image 3.75MB
raw / 8000px. Since none of these provably bind GenerateAssistantResponse, the caps
below are CONSERVATIVE POLICY derived from those adjacent surfaces, not provider hard
limits — documented as such:

- Per-MESSAGE image cap 20 (mirrors Bedrock Message semantics; kiro wire carries
  images per userInputMessage).
- Request-wide total base64 budget 18MiB (policy headroom under the 25MB adjacent cap;
  text/tools share the same body, so this bounds the image share, not the whole body).
- Per-image/dimension: our tier ladder (≤2MiB base64, ≤2000px) already sits far inside
  any cited per-image bound.

## Gap

`extractKiroImages` (src/adapters/kiro-images.ts) inlines data-URL images into
CodeWhisperer wire (`{format, source:{bytes}}`) with NO size/dimension/count handling;
`buildKiroPayload` assembles them into history + current message (src/adapters/kiro.ts:224-302).

## Diff plan

### MODIFY `src/adapters/anthropic-image-normalize.ts` — generalize (single owner, c3)

- NEW exported `interface NormalizeTarget { base64: string | null; mediaType: string;
  replace(data: string, mediaType: string): void; drop(note: string): void }`.
  `mediaType` is the canonical lowercased MIME ("image/<format>") — cache identity and
  pass-through decisions depend on it (audit blocker 5); wire-specific conversions
  (kiro subtype) happen inside the target's replace, never in the core.
- Extract the existing algorithm body into
  `export async function normalizeImageTargets(targets: NormalizeTarget[], opts:
  NormalizeOptions & { budget?: number; overflowAction?: "none" | "drop"; processLimit?: number }): Promise<void>`
  preserving semantics EXACTLY (audit blocker 2): the core receives the COMPLETE
  ordered target sequence (n and newest-first positions unchanged, URL targets keep
  their positional effect). The newest-N processing skip becomes `processLimit?: number`
  (audit round 2, blocker 1): anthropic wrapper passes/defaults 100 (today's behavior,
  byte-identical); kiro passes NO limit so every image is normalized and counted —
  otherwise >100-image kiro histories would leak unaccounted bytes past the 18MiB drop.
  Bomb/undecodable note strings stay owned by the core, byte-for-byte; the count-cap
  drop note and the aggregate-overflow drop note are DISTINCT strings so tests prove
  which branch fired (audit round 2 residual).
- `overflowAction` (audit blocker 3): "none" (anthropic default — terminal overflow is
  the guard's Rule 4 backstop, unchanged) vs "drop" (kiro — after all-terminal, drop
  OLDEST targets until Σ ≤ budget, since kiro has no downstream guard).
- `normalizeAnthropicImages` becomes a thin wrapper building block-based targets from
  `collectImageRefs` (textify = drop note). BEHAVIOR MUST BE BYTE-IDENTICAL: existing
  normalize/guard/retry/passthrough tests stay green UNMODIFIED (criterion c3).

### MODIFY `src/adapters/kiro-images.ts`

- NEW `export async function normalizeKiroImages(payload: unknown, opts?: Pick<NormalizeOptions, "encode" | "validate">): Promise<void>` —
  walk history entries + `conversationState.currentMessage` (oldest→newest; structured
  pendingImages and fallback tool-result paths both land in these carriers —
  kiro.ts:237,288), build targets over each image: `mediaType = "image/" +
  canonicalFormat` (blocker 5); replace = mutate `{format: outputSubtype,
  source:{bytes}}`; drop = locate by OBJECT IDENTITY at execution time (never captured
  index — blocker 4), remove it, DELETE the `images` field when it empties (builder
  omission contract, kiro.ts:224), and append the note to that message's `content`
  string (valid wire — content is a plain string, kiro.ts:50).
- ORDER (audit round 2 residual): (1) per-message PRE-pass enforces the 20-image cap
  (drop oldest within the message, count-cap note); (2) THEN collect targets over the
  survivors only; (3) `normalizeImageTargets(targets, { budget: KIRO_IMAGE_BASE64_BUDGET,
  overflowAction: "drop", ...testSeams })`. `normalizeKiroImages(payload, opts?)`
  forwards optional encode/validate seams into the core (audit round 2, blocker 3) so
  K4 traverses the REAL kiro wiring including its overflowAction choice.
- Constants `KIRO_IMAGE_BASE64_BUDGET = 18MiB`, `KIRO_MAX_IMAGES_PER_MESSAGE = 20`,
  each commented as conservative policy with the adjacent-surface citations above.

### MODIFY `src/adapters/kiro.ts`

- `buildRequest` → async; after `buildKiroPayload`, `await normalizeKiroImages(built.payload)`
  BEFORE `JSON.stringify` (debug bodyBytes then reflects normalized size). Callers
  already await (base.ts contract); SYNC TEST consumers in kiro-adapter/kiro-stream/
  kiro-images tests (~50 sites) migrate via the same codemod used for anthropic.

## Tests (`tests/kiro-images.test.ts` extensions + migration)

- K1: real 4000×3000 PNG data URL → wire bytes re-encoded jpeg ≤2000px, `format:"jpeg"`.
- K2: 21 tiny images in ONE message → oldest dropped with the COUNT-CAP note, exactly
  20 survive (activation: remove normalize call ⇒ fails).
- K2c (empty-field deletion): a message whose SOLE image is undecodable → image dropped,
  `images` field deleted (not left as []), undecodable note appended to content.
- K2b: tool-result image paths — one structured (pendingImages) and one fallback carrier
  image are both normalized (reachability protection, audit residual).
- K3 (regression, NOT activation evidence — audit blocker 6): survivors keep
  `{format, source:{bytes}}` pure-base64 shape; small in-cap image passes through
  byte-identical (cache/MIME mapping proof: no needless re-encode).
- K4 (seam THROUGH normalizeKiroImages, not the bare core): over-budget total → the
  OLDEST entry specifically is demoted/dropped (assert which, overflow note distinct
  from count-cap note), Σ ≤ 18MiB; all-terminal overflow drops oldest — fails if kiro
  stops passing overflowAction:"drop".
- K5: 48 kiro sync buildRequest consumers migrated (incl. rejects.toThrow for
  sync-throw assertions like kiro-adapter.test.ts:47); anthropic suites green
  UNMODIFIED (c3).

## Accept criteria (criteria c2, c3)

K1-K5 + full gates green + reviewer verdict recorded.
