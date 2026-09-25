# L3 provider adapters — diff-level plan (wp1)

Lane L3 bundles seven independent provider-adapter fixes into one PR against `dev`
(branch `codex/260924-l3-provider-adapters`, base `be0b5294e5`). Each item has its own
writer scope, and the lane lead registers every new test file in
`scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`.

## Items and diffs

### 1. #5692 DeepSeek quota currency symbol
- `src/providers/quota/vendor-probes-key.ts` `fetchDeepSeekQuota`: read `preferred.currency`,
  map USD→`$`, CNY→`¥`, anything else → `"<CODE> "` prefix (trimmed, upper-cased; empty/missing → `$`
  keeps legacy behaviour only when the row has no currency). Both label branches use it.
- Test: new sibling `tests/providers/deepseek-quota-currency.test.ts` (provider-quota.test.ts sits at
  its 3763-line cap): CNY-only row → `API balance (¥76.88)`; USD row → `$`; CNY with granted → both
  amounts use `¥`; unknown currency (e.g. EUR) → code prefix.

### 2. #5689 Google array without items
- `src/adapters/google-tool-schema.ts` `sanitizeSchema`: after the `items` block, when
  `out.type === "array"` and `out.items` is absent (source had no items, tuple items dropped, invalid
  items widened, or budget ran out), set `out.items = { type: "string" }` and count a loss
  (`invalid-schema-widened`) only when the source had no usable items. Valid `items` untouched;
  nullable arrays keep `nullable`. Also covers `anyOf`-normalized arrays (apply after anyOf merge).
- Tests in `tests/adapters/google/google-tool-schema.test.ts` (486 lines, uncapped): issue repro
  `{type:object, required:[values], properties:{values:{type:array}}}`; nested array; tuple items;
  existing valid items byte-identical; non-array unaffected.

### 3. #5695 mimo token-plan capacity facts
- `src/providers/registry/entries-extended.ts` `mimo` entry: add
  `modelContextWindows` (all four ids 1_048_576), `modelMaxOutputTokens` (all four 131_072),
  `modelInputModalities` (v2.6-pro, v2.6-flash, v2.5: `["text","image"]`; v2.5-pro: `["text"]`).
  Source: mimo.mi.com/models/en-US/<id> (fetched 2026-09-24: 1M context, 128K output; v2.6-pro/flash
  and v2.5 input Text/Image/Video/Audio, v2.5-pro Text). Video/audio are not representable in the
  catalog's modality vocabulary, so only text/image are claimed. Keep `noVisionModels` and
  `preserveCustomDestination`; update the comment.
- Test: registry/catalog assertion in a sibling test file (e.g. `tests/providers/mimo-token-plan-capacity.test.ts`).

### 4. Carry #5693 (Vadevious) on #5725
- `src/adapters/openai-chat/serialized-tool-call-content.ts`: add `repeatedCallIn` built on the
  current `callsIn`/`blockAt`; in `duplicatedSerializedToolCallRanges` suppress the adjacent identical
  pair only when exactly one structured call matches (compare with `freeformBody`); in
  `repairArgumentsDuplicatedBesideSerializedCall` reduce a doubled `input` (direct or newline joined)
  when `input` is the only key.
- Tests: port the PR's tests into `tests/adapters/openai/openai-chat-serialized-tool-call-content.test.ts`
  and `tests/responses/responses-chat-tool-call-content.test.ts`; docs: adapters.md bullet,
  `structure/providers/chat-compat.md` paragraph, ADR-5548 consequences line.
- Commit trailer: `Co-authored-by: Vadevious <Vadevious@users.noreply.github.com>`.

### 5. #5698 command-code filter (marciodps)
- `src/adapters/command-code-tool-text.ts` per the reporter's final patch, with fixes:
  mid-prose marker split in `textDelta` (not when the prefix is only whitespace on a probing block
  with an empty probe — the existing probe already holds `"\n<tool_call>"`); shared
  `probeBlockText` / `queueProseDelta` helpers; `breakOpenBlocks` skips held blocks;
  `isLooseEnvelope` (null-safe `exec` result) used in `matchNative` and `settle` to drop malformed
  envelopes naming a declared tool.
- Tests: new sibling `tests/providers/command-code-tool-text-prose-split.test.ts`: prose+markup in
  one delta with native duplicate (dropped); prose+markup clean finish (restored); marker at index 0
  after streaming prose; leading-whitespace markup still held; interleaved reasoning keeps held
  block; captured malformed `<parameter=` envelope with native duplicate (dropped, one call) and with
  clean finish (dropped, no restore); `<tool_call>junk</tool_call>` does not throw; never-closing
  partial markup released as text.
- Commit trailer: `Co-authored-by: marciodps <marciodps@users.noreply.github.com>` (or their commit email if public).

### 6. #5096 remainder: `ocx effort model` slug resolution
- `src/cli/effort.ts` `inspectModelEffort`: after splitting provider/model, when the model is not a
  known id, decode it with `decodeRoutedModelId(model, knownModelIdsForProvider(provider, prov, config))`
  (router.ts / slug-codec.ts). Report `model` as the resolved native id and add `requestedModel` when it
  differs. Unresolvable ids keep today's behaviour.
- Tests: new sibling `tests/cli/cli-effort-slug.test.ts`: `command-code/deepseek-deepseek-v4.1-flash`
  and `command-code/deepseek/deepseek-v4.1-flash` report the same ladder as
  `COMMAND_CODE_MODEL_REASONING_EFFORTS["deepseek/deepseek-v4.1-flash"]`; same for GLM 5.3 FlashX and
  Gemini 3.8 Flash (the ids named in the latest issue comment). Ladders are read from the SSOT, not
  restated, so no tier is invented.

### 7. #5576 grok-4.7-build-fast
- `src/providers/registry/entries-core.ts` xAI entry: add `grok-4.7-build-fast` to
  `modelContextWindows` (500_000), `modelReasoningEfforts` (low..xhigh), `modelDefaultReasoningEfforts`
  (high), `modelInputModalities` (text,image). Not added to `XAI_MODELS`: xAI documents Grok 4.7 Fast as
  "the same model served on faster infrastructure… not available on the public xAI API"
  (docs.x.ai/developers/grok-4-7, fetched 2026-09-24). No service-tier claim.
- Test: new sibling `tests/providers/xai/grok-47-build-fast-metadata.test.ts` asserting the four facts
  equal grok-4.7's.

## Out of scope
#5421; the "per-model maps lost on restart" half of #5576; the opencode-go `openai-chat` wiring from
#5698 (reported against #5499 in the PR body).

## Verification
`bun run typecheck`; each focused test file above plus existing neighbours
(`tests/providers/command-code-tool-text.test.ts`, `tests/providers/provider-quota.test.ts`,
`tests/adapters/google/google-tool-schema*.test.ts`, `tests/cli/cli-effort.test.ts`, xAI and catalog
parity suites); `bun run test:changed`; `bun run privacy:scan`; `bun run structure:check`.


## Audit fold (A, round 1 verdict FAIL → amendments)

1. Item 2 materializes `items: {type:"string"}` without adding a loss category (representation fix, keeps
   `lossy:false` contracts). Budget-exhausted return stays untouched (`google-tool-schema.test.ts:479-481`).
   Existing tests that pin an array output without items (contract test ~578-587, tuple case ~303-322) update
   their expected `parameters` only; category sets stay. `structure/providers/google.md` gains one sentence.
2. Item 1 also rewrites `tests/providers/provider-quota.test.ts:1131-1136` (CNY row) to `¥`, line-neutral
   (file at its 3763 cap).
3. Item 7: add `grok-4.7-build-fast` to `modelContextWindows`, `modelReasoningEfforts`,
   `modelDefaultReasoningEfforts`, `modelInputModalities`, plus the reasoning-model parameter lists xAI documents
   for reasoning models (`noStopModels`, `noPenaltyModels`, `preserveReasoningContentModels`). Not added:
   `modelWireDefaults` and `modelSupportsServiceTier` (live-probed on grok-4.7 only), `XAI_MODELS`. Update exact
   literals: `provider-registry-parity.test.ts:1319`, `xai-no-stop.test.ts:47`, `xai-transport.test.ts:634,844`.
   `structure/providers/xai-grok.md` gains a line.
4. Item 6: the decoded id replaces `modelId` before `modelInList` / `configuredReasoningEfforts` /
   `reasoningEffortMapFor`.
5. Item 4: compare with `freeformBody` on both sides, tail must be exactly one repetition, add a leading-newline
   case. Rebuttal: the newline-joined doubled-input repair stays — #5693 commit 7854ac8 added it with its own
   regression test and the PR body documents it.
6. Item 5 source is marciodps' third follow-up comment on #5698 (2026-09-23T19:33Z), full patch vs 2.64.0.
   Preserve the marker-free fast path (`command-code-tool-text.test.ts:388`), the queue-visit bound (`:324`),
   and whitespace-probe salvage.
7. Lead registers every new test file in both layout maps.


Round 2 verdict PASS. Residuals: item 2 drops the original "budget ran out" clause, and the two contract
tests assert only loss reports, so no expectation needs editing there; item 7 keeps grok-4.7-build-fast on
the provider-default wire, to be re-checked on first live discovery.
