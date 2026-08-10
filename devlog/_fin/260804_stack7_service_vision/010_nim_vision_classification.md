# 010 — Classify NVIDIA NIM vision capability by its short side (#964 / issue #956)

## The defect being fixed

The registry `nvidia` entry declares no `noVisionModels`
(`src/providers/registry.ts:1303-1320`), so `planVisionSidecar()` returns
`undefined` for every NIM model (`src/vision/index.ts:235`). A text-only NIM
model therefore either receives raw image parts it cannot read, or — more often —
has attachments blocked client-side because the catalog never advertises image
input (`src/codex/catalog/provider-fetch.ts:177-184`). That is issue #956, and it
is real.

Note the field's inverted name: `noVisionModels` lists models that CANNOT see
images, and listing one there is what *enables* image support for it, via the
sidecar. Getting a model's membership wrong in either direction is a bug.

## Why #964's list cannot be carried

#964 enumerates ~60 text-only NIM ids by hand. Live verification against
NVIDIA's own documentation on 2026-08-04 found **five of those entries are
natively image-capable**:

| Id | #964 says | NVIDIA says | Source |
|---|---|---|---|
| `thinkingmachines/inkling` | text-only | text, **image**, audio (RGB, 40–4096px per side) | [NIM API reference](https://docs.api.nvidia.com/nim/reference/thinkingmachines-inkling) |
| `minimaxai/minimax-m3` | text-only | Text, **Image**, Video | build.nvidia.com model page |
| `moonshotai/kimi-k2.6` | text-only | text, **image**, video, with a published `image_url` example | build.nvidia.com model page |
| `stepfun-ai/step-3.7-flash` | text-only | text + image, documented as a VLM | [NIM VLM example](https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/step-3.7-flash/api.html) |
| `mistralai/mistral-medium-3.5-128b` | text-only | text + image, NIM-certified VLM | [VLM introduction](https://docs.nvidia.com/nim/vision-language-models/latest/introduction.html) |

A false positive here is **silent**. The model can read the image itself, but the
proxy intercepts it and sends a different model's *text description* instead.
Nothing errors; cost and latency rise and answer quality drops, and no test
fails. That is strictly worse than the bug #956 reports, which at least
announces itself.

The false entries are not the author's invention: **issue #956's own body lists
`minimaxai/minimax-m3` and `moonshotai/kimi-k2.6` as text-only.** Reporter and
PR author shared the same wrong premise and review passed it through. This is the
fourth time in this session's line of work that a hand-written allowlist over an
open string domain has been wrong; the pattern is the finding, not the individual
entries.

*(Resolved.) The Mistral Medium 3.5 caveat — that the first evidence described a
**self-hosted** VLM container rather than the hosted endpoint — was closed at the
round-4 gate. NVIDIA's hosted inference reference targets
`integrate.api.nvidia.com`, defaults to this exact id, and documents `image_url`
input, and the Build page reports a free hosted endpoint with Text and Image
modalities. It ships in the vision set with no pending recheck.

## Why not classify by name, tag, or API

Three candidate mechanisms, all rejected on evidence:

1. **A modality field from the API.** `GET /v1/models` on
   `integrate.api.nvidia.com` returns no input-modality field, and the documented
   VLM `/v1/models` schema carries identifiers, ownership, context length and
   permissions — no modalities. The registry really is the only source of truth,
   as #956 states.
2. **A naming convention.** `google/gemma-4-31b-it` carries no `vision`, `-vl`,
   or `omni` marker and [accepts text + image, processing video as frame
   sequences](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it).
   Counterexamples run both ways: `-vl` also appears on embedding and reranking
   models that are not chat generators at all.
3. **The catalog's own labels.** The `image-to-text` filter returns 7 entries
   while per-page verification finds 15 image-capable chat models. The labels are
   incomplete.

## The design: enumerate what is known, bound what is not

**Two earlier designs in this document were falsified at the audit gate.** The
history matters because it is the argument for the current one
(`001_audit_response.md`, `002_audit_response_r2.md`).

**Draft 1 — complement over a static chat list.** Falsified: an id in neither
list is not in `noVisionModels` either, so nothing changes for it.

```console
$ bun run .tmp/probe_complement.ts     # the proposed shape, modelled exactly
deepseek-ai/deepseek-v4-flash            sidecarWouldRun=true
moonshotai/kimi-k2.6                     sidecarWouldRun=false
brandnew/model-nobody-classified         sidecarWouldRun=false   <-- #956 persists
```

**Draft 2 — provider-level default-on with the vision list as its exception.**
Falsified on a boundary this document had explicitly flagged as needing
confirmation, and which I then did not confirm:

```console
$ bun run .tmp/probe_nonchat.ts
nvidia/nv-embedqa-e5-v5                        filteredOut=false
nvidia/llama-3.1-nemotron-safety-guard-8b-v3   filteredOut=false
nvidia/nemotron-ocr-v2                         filteredOut=false
nvidia/llama-nemotron-rerank-1b-v2             filteredOut=false
```

NVIDIA has no discovery filter and `shouldExposeRoutedModel` rejects only
media-generation *names* (`src/codex/catalog/parsing.ts:160-164`). Embeddings,
rerankers, guards and OCR endpoints all reach `planVisionSidecar`, so default-on
would advertise image input for every one of them.

### The constraint, stated honestly

Seventeen registry entries declare `noVisionModels`; fifteen pair it with a
static `models` list:

```console
$ rg -c "^\s+noVisionModels:" src/providers/registry.ts
17
```

The two exceptions are `opencode-go` (`registry.ts:877`) and `opencode-free`
(`registry.ts:1585`). Neither is a counter-pattern: both classify only known ids
and leave unknown ones untouched, and `opencode-free` additionally has a
provider-specific `-free` suffix filter (`provider-fetch.ts:636`) — a model-kind
signal NVIDIA does not publish.

*(An earlier revision of this section said "12 of 13" and named `opencode-zen`
as the exception. Both were wrong; see `003_audit_response_r3.md`.)*

NIM has no `models` list, uses live discovery, and publishes neither modality nor
model-kind metadata.

So an unknown NIM id carries no signal distinguishing a text-only chat model from
an embedding endpoint. **No predicate over an id string can recover information
the provider does not publish.** Draft 2 failed not because the rule was written
badly but because it claimed knowledge that does not exist.

### What this design does instead

1. **Enumerate text-only ids — but only ids we have actually verified.** Draft 3
   said "for a known id the classification is real and verifiable" while
   inheriting ~54 unaudited entries from #964 and calling them known. A sixth
   false positive (`moonshotai/kimi-k2.5`) surfaced immediately after correcting
   five, so **every carried id is verified against NVIDIA documentation or
   dropped**. Dropping costs today's behavior; assuming costs a silent
   regression.
2. **Pin the 16 verified vision-capable ids** with explicit
   `modelInputModalities: ["text","image"]`, so they become usable instead of
   merely unlisted.
3. **Leave unknown ids alone.** They keep today's behavior in both directions.
4. **Record the verification date in the registry comment.** A dated *test* was
   considered and dropped (`003_audit_response_r3.md`): a local date assertion
   has no NVIDIA input, so it detects elapsed time rather than drift, and its
   cheapest CI fix is bumping the date without auditing anything.

| Case | Behavior | Honest? |
|---|---|---|
| known text-only id | sidecar runs, image advertised | fixed |
| known vision id | native path, image advertised | fixed (new) |
| unknown id | unchanged from today | **stated limitation** |

This is a smaller claim than either falsified draft, and it is the one the
evidence supports. #956 stays partially open for models NVIDIA ships after the
snapshot — recorded as a known limitation rather than hidden behind a mechanism
that does not work.

### The known-id half is only as good as its audit

This design's correctness rests entirely on the per-id verification, not on the
list's shape. That is why the audit is a gating step rather than a nicety, and
why an unverifiable id is dropped instead of carried.

### Verified vision models also need explicit modalities (audit B2)

Keeping a native-vision id out of `noVisionModels` is necessary but **not
sufficient**. `applyProviderConfigHints` adds `image` to a model's
`inputModalities` only for `noVisionModels` members
(`src/codex/catalog/provider-fetch.ts:176-184`), and NIM `/v1/models` publishes
no modality metadata. So a model left out of both would be advertised text-only
and the Codex app would block attachments client-side — the model can see, and
the user still cannot send.

Every id in `NVIDIA_NIM_VISION_MODELS` therefore also gets
`modelInputModalities[id] = ["text", "image"]`, following the shape
`ZHIPU_BIGMODEL_INPUT_MODALITIES` already uses
(`src/providers/registry.ts:327-331`). The test asserts the **emitted catalog
payload** carries `image`, not merely that the id is absent from a list.

## Verified vision-capable set (2026-08-04)

High confidence, per-model NVIDIA documentation:

```
meta/llama-3.2-11b-vision-instruct
meta/llama-3.2-90b-vision-instruct
nvidia/llama-3.1-nemotron-nano-vl-8b-v1
nvidia/nemotron-nano-12b-v2-vl
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
nvidia/cosmos3-nano-reasoner
nvidia/ising-calibration-1.5-31b
nvidia/ising-calibration-1-35b-a3b
google/gemma-4-31b-it
google/diffusiongemma-26b-a4b-it
minimaxai/minimax-m3
moonshotai/kimi-k2.6
moonshotai/kimi-k2.5
stepfun-ai/step-3.7-flash
thinkingmachines/inkling
mistralai/mistral-medium-3.5-128b
```

Flagged, not yet committed to code:

- `mistralai/mistral-medium-3.5-128b` — hosted endpoint **confirmed** at the
  round-4 gate, so it ships. NVIDIA showed a 2026-08-07 deprecation date; when
  the id goes away it classifies nothing, which is harmless.
- `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` — catalog indicated imminent
  deprecation; harmless if it disappears (an absent id classifies nothing).
- `google/paligemma` — established VLM, but its detail page 404s. Excluded from
  the vision list would make it text-only, which is wrong; excluded from
  classification entirely is correct until availability is confirmed.
- `nvidia/vila`, `microsoft/phi-3_5-vision-instruct`, DePlot, Phi-4 Multimodal —
  image-capable but hosted endpoint deprecated. `nvidia/neva-22b`,
  `kosmos-2`, `fuyu-8b` — no current hosted page found. #964's test asserts these
  historical ids stay out of `noVisionModels`; that assertion stays true under
  our design for free, since they are simply not classified.

## Planned diff

Confined to `src/providers/registry.ts`. **No predicate change**, so no consumer
edits — the reason this draft is implementable where draft 2 was not.

1. `NVIDIA_NIM_VISION_MODELS` — the 16 verified ids, with a comment recording the
   verification date, per-model source, and the standing instruction that a new
   NIM model must be classified deliberately, never assumed.
2. `NVIDIA_NIM_NO_VISION_MODELS` — **the 26 ids verified in `011_nim_id_audit.md`
   and no others.** #964 submitted ~64; six were image-capable and 32 could not
   be verified against any current NVIDIA page, so they are dropped rather than
   carried. `NVIDIA_NIM_KIMI_MODELS` is reconciled: k2.5 and k2.6 move to the
   vision list while k2-thinking and k2-instruct stay text-only, and all four
   remain in the reasoning-suppression list, which is an independent axis.
3. `modelInputModalities` pinning `["text","image"]` for each vision id (B2),
   following `ZHIPU_BIGMODEL_INPUT_MODALITIES` (`src/providers/registry.ts:327-331`).
4. Set `noVisionModels` on the `nvidia` entry and extend the entry comment with
   the open-world limitation.

Existing consumers already behave correctly once the field is populated — which
is why #956 has a working config-only workaround. Two are worth noting even
though they need no change: `src/web-search/index.ts:165` and
`src/cli/models.ts:44`, the latter using raw `.includes()` rather than
`modelInList`. Both were missed in earlier drafts and would have needed edits
under a predicate change.

## Tests and the red-green plan

Extend `tests/nvidia-nim-hardening.test.ts` (the file #964 also chose):

1. **Vision-capable ids do NOT get the sidecar.** Seed with all **six** ids #964
   got wrong — `thinkingmachines/inkling`, `minimaxai/minimax-m3`,
   `moonshotai/kimi-k2.6`, **`moonshotai/kimi-k2.5`**,
   `stepfun-ai/step-3.7-flash`, `mistralai/mistral-medium-3.5-128b` — plus the
   two llama-3.2 vision ids. k2.5 was the round-3 P0 and must appear in both this
   test and the emitted-modality test below, not only in the list.
   `planVisionSidecar` returns `undefined` for each even with an image attached.
   This is the direct regression guard for #964's defect. Ablate by adding one
   back to `noVisionModels` and watch it go red.
2. **An unknown id is unchanged.** The honest boundary: an id in neither list
   produces no vision plan, exactly as today. Asserted so the limitation is
   pinned in the test suite rather than only in prose — if a later change makes
   unknown ids default in either direction, this test forces that decision to be
   deliberate.
3. **The catalog advertises image input for both classes, for different
   reasons** (audit B2): a text-only id gets `image` via the `noVisionModels`
   hint, and a verified vision id gets it via `modelInputModalities`. Assert the
   emitted payload in both cases. Ablate the `modelInputModalities` entries and
   watch the vision-id case go red.
4. **Representative text-only ids still classify correctly** —
   `deepseek-ai/deepseek-v4-flash`, `z-ai/glm-5.2`,
   `nvidia/nemotron-3-ultra-550b-a55b`, `openai/gpt-oss-120b`. Sidecar on, no
   image forwarded raw.
5. **A user's config additions are preserved.** `mergeStringArray` **unions**
   registry and user arrays (`src/router.ts:95`, `:243`), so a user cannot
   remove a registry classification by supplying their own list. An earlier
   revision asserted the user's list "wins", which is not the shipped semantic
   (`003_audit_response_r3.md`). Replacement/negation semantics would be a
   separate change with its own design cost; out of scope here.
6. **A bare persisted nvidia config gets the fix** through `routeModel` — the
   #956 reporter's exact config shape, which today needs a manual workaround.
7. **The two lists cannot overlap.** A structural assertion that
   `NVIDIA_NIM_VISION_MODELS ∩ NVIDIA_NIM_NO_VISION_MODELS = ∅`, so a future
   edit cannot put an id in both. Ablate by planting a duplicate.
8. *(Dropped — the dated-snapshot guard. See `003_audit_response_r3.md` R3-B4.)*

Every guard gets driven red by ablation before it counts, per the unit's
verification discipline.
