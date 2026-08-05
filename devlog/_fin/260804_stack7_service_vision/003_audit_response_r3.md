# 003 — Audit round 3: a sixth false positive, and a census I invented

Round 3 returned **FAIL**. Three failures on the same document is LOOP-DOOM-01
territory, so the response is not a fourth patch of the same shape: it changes
the *verification method* the design depends on.

## R3-B1 [P0] — `moonshotai/kimi-k2.5` is a sixth false positive

`010` claimed the new list is #964's enumeration "with the five false positives
removed". #964 also lists `moonshotai/kimi-k2.5`, and NVIDIA documents it as
natively multimodal — GIF/JPG/PNG, URL or base64, four images per prompt by
default, with hosted `image_url` examples
([NIM VLM docs](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/kimi-k2.5/api.html),
[hosted inference reference](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-5-infer)).
Independently confirmed.

**Why this is fatal to the draft-3 design, not just a missing entry.** Draft 3's
entire justification was "for a *known* id the classification is real and
verifiable". Finding a sixth false positive immediately after correcting five
shows I never verified the remainder — I inherited ~54 unaudited entries from
#964 and called them "known text-only". That phrase was unsupported.

Subtraction-by-known-exceptions is unsafe while the base list is unaudited. The
method has to change: **every entry carried from #964 gets verified against
NVIDIA documentation, or it does not ship.** An entry that cannot be verified is
dropped rather than assumed text-only — dropping costs today's behavior, and
assuming costs a silent quality regression.

## R3-B2 [P1] — the registry census was wrong, and I generated it carelessly

`002` and `010` claimed "12 of 13 entries pair `noVisionModels` with a static
`models` list" and named `opencode-zen` as the exception. Counted directly:

```console
$ rg -c "^\s+noVisionModels:" src/providers/registry.ts
17
```

There are **17** such entries. Fifteen have a static `models` list; the two that
do not are **`opencode-go`** (`registry.ts:877`) and **`opencode-free`**
(`registry.ts:1585`). `opencode-zen` declares no `noVisionModels` at all.

The wrong numbers came from an ad-hoc regex over entry bodies whose boundaries it
got wrong, and I put its output into a document as a census without checking it.
That is the same failure as R2-B2 — asserting rather than verifying — repeated
one document later. Ad-hoc extraction is now treated as a hypothesis, not
evidence.

**The information-constraint argument survives**, and the two real exceptions
strengthen rather than weaken it: both classify only known ids and leave unknown
ids untouched, exactly as draft 3 proposes. `opencode-free` additionally has a
provider-specific `-free` suffix filter (`provider-fetch.ts:636`) giving it a
model-kind signal NVIDIA does not have. But "first provider" and the counts are
corrected wherever they appear.

## R3-B3 [P1] — test 5 asserts semantics that do not exist

`010` said a user's explicit config `noVisionModels` "wins" over the registry.
It does not: `mergeStringArray` **unions** them (`router.ts:95`, `:243`). A user
cannot remove a registry classification by supplying their own list.

The test becomes "user additions are preserved alongside registry entries".
Introducing replacement or negation semantics is a separate change with its own
design cost and is out of scope here.

## R3-B4 [P2] — drop the dated snapshot test

I flagged it as the weakest part and the reviewer agreed for a sharper reason: a
local date assertion has no NVIDIA input, so it cannot detect drift — only
elapsed time. As a required unit test it becomes a calendar-triggered CI failure
whose cheapest fix is bumping the date without auditing anything, which actively
launders staleness.

**Dropped.** The registry comment records the verification date and the standing
instruction; a future maintainer gets the date without CI theatre. `002`'s
description of it as detecting "drift" was wrong and is corrected.

## What survived round 3

- **Accepting the unknown-model gap is legitimate, not premature surrender.**
  The reviewer looked for a runtime discriminator and found none:
  `formatOpenAIChatErrorBody` extracts arbitrary error text with no stable
  modality code (`openai-chat.ts:33`), and the NIM tests establish none. A
  retry-on-modality-error scheme would also not help the catalog gate, since
  unknown models would first have to advertise image support — re-exposing
  embeddings, rerankers, OCR and guards.
- **Vision and reasoning axes are orthogonal.** kimi-k2.5 and k2.6 stay in
  `NVIDIA_NIM_KIMI_MODELS` for reasoning suppression while joining the vision
  set. Confirmed by probe and by the reviewer against
  `tests/nvidia-nim-hardening.test.ts:42`.
- **`020`'s `status --json` fix is implementable**, with one implementation note:
  the probe currently runs only after a *successful* service command
  (`bin/ocx.mjs:253`), so the failure path must move or duplicate it. The planned
  failure-path test catches this.
- **`030`'s sequencing holds.** One correction: `010` says #956 stays partially
  open for future models while `030` schedules closing it on merge. The closing
  comment must state the bounded snapshot scope explicitly rather than claiming a
  complete fix.

## Method change carried into implementation

1. Every #964-inherited id is verified against NVIDIA documentation before it
   ships. Unverifiable ids are dropped, not assumed.
2. Counts and inventories come from direct, re-runnable commands whose output is
   pasted, never from an ad-hoc regex summarized from memory.
3. Claims about mechanism (`mergeStringArray` semantics, catalog filters) are
   read in the source before being written into a document.
