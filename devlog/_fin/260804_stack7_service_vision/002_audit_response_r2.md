# 002 — Audit round 2: FAIL again, and the root cause

Round 2 closed B2, B3 and B5, and returned **FAIL** on two P0s plus one High.
Two consecutive failures on the same surface triggers root-cause mode
(LOOP-REPAIR-01) rather than a third patch of the same shape.

## What closed

- **B2** — registry `modelInputModalities` really does reach the emitted catalog
  (`derive.ts:124`, `:248` → `configuredInputModalities` →
  `applyProviderConfigHints`, `provider-fetch.ts:155`, `:172`).
- **B3** — narrowing the Windows skip to the install argv does not reintroduce
  the direct-start race; the failure path still re-stops the backend before
  reclaiming the port (`update/job.ts:807`, `:882`, `:1020`).
- **B5** — retarget → merge `dev` → require `synchronize`-generated checks is a
  real fix.
- Contributor-PR closure at "open and green" is sufficient.

## R2-B3 [High] — `diagnoseService()` from `bin/ocx.mjs`

Found and fixed **before** the verdict arrived, independently and identically:
`bin/ocx.mjs` is Node ESM importing only `.mjs` siblings (`bin/ocx.mjs:1`,
`:11-19`), so it cannot import `src/service.ts`. `020` now specifies reading
`startup.serviceInstalled` from the `status --json` subprocess it already spawns
at `:258`. Already corrected in the tree.

## R2-B1 [P0] — the design was prose, not a design

"Declare a provider-level default-on rule" named no field, no type, no
precedence, and no predicate. `noVisionModels` is `string[]` and *cannot* encode
"default on with exceptions", so this was hiding real implementation cost behind
vague wording. Accepted in full.

The reviewer also caught two consumers I missed: `src/web-search/index.ts:165`,
absent from my plan entirely, and `src/cli/models.ts:44`, which uses raw
`.includes()` instead of `modelInList` — so any predicate change silently skips
it. I had independently confirmed the `.includes()` divergence; the web-search
call site I simply missed.

## R2-B2 [P0] — "non-chat ids never reach the predicate" is false

I wrote that boundary into `010` *as a thing to confirm rather than assume*, and
then did not confirm it. It is false.

NVIDIA has no discovery filter (`registry.ts:1234` — no `models`, no
`liveModels` gate), and `shouldExposeRoutedModel` rejects only media-generation
*names* (`parsing.ts:160-164`). Reproduced:

```console
$ bun run .tmp/probe_nonchat.ts
nvidia/nv-embedqa-e5-v5                        filteredOut=false
nvidia/llama-3.1-nemotron-safety-guard-8b-v3   filteredOut=false
nvidia/nemotron-ocr-v2                         filteredOut=false
nvidia/llama-nemotron-rerank-1b-v2             filteredOut=false
nvidia/nemoretriever-parse                     filteredOut=false
```

Embeddings, rerankers, guards and OCR endpoints all enter the catalog, route
through `openai-chat`, and reach `planVisionSidecar`. Under default-on every one
of them would advertise image input and burn a sidecar call before failing
upstream.

## The root cause

Both P0s are the same defect wearing different clothes. Vision classification in
this registry has always been **membership in a bounded set**, and every existing
user of it pairs the classification with a bounded model list:

```console
$ # providers declaring noVisionModels, and whether their model set is bounded
cursor                  staticModelList=true
umans                   staticModelList=true
ollama-cloud            staticModelList=true
volcengine (×3)         staticModelList=true
alibaba-token-plan-intl staticModelList=true
...                     13 entries, 12 with a static list
```

NVIDIA is the first provider asked to classify over an **unbounded** set: no
`models` list, live discovery, ~101 rows today and more tomorrow, and no modality
metadata to separate chat from non-chat.

That is why every design attempt failed. #964 enumerated the open side and went
stale. My complement enumerated a different closed set and changed nothing. My
default-on escaped the closed world but, lacking any chat/non-chat signal, could
not tell an unknown text model from an unknown embedding model — **because that
information does not exist in the data**. No predicate over an id string can
recover it.

**The honest statement of the constraint:** with no modality metadata and no
model-kind metadata, unknown NIM ids cannot be classified correctly in both
directions. Any design claiming otherwise is claiming information the provider
does not publish.

## The design that follows from the constraint

Stop trying to classify the unknown. Fix what is knowable and bound the rest
explicitly:

1. **Enumerate text-only ids** — as #964 did, because for a *known* id the
   classification is real and verifiable. Correct its five false positives.
2. **Pin the 15 verified vision-capable ids** with explicit
   `modelInputModalities` so they are usable rather than merely unlisted (B2).
3. **Do not default unknown ids in either direction.** An unknown NIM id keeps
   today's behavior. This leaves #956 open for models NVIDIA ships after our
   snapshot — stated as a known limitation, not hidden behind a mechanism that
   does not work.
4. **Make the staleness visible and cheap to fix** instead of pretending it does
   not exist: a test that fails when the registry's NIM classification drifts
   from a recorded snapshot date, so the list's age is surfaced rather than
   silently rotting.

This is a smaller claim than the previous two drafts and it is the one supported
by evidence. It fixes the reported bug for every model in the report, corrects
the five entries #964 got backwards, makes the vision-capable models usable for
the first time, and states plainly what it does not solve.

Point 4 is the part worth arguing about at the next gate: a date-stamped
snapshot test is a maintenance signal, not a correctness guarantee, and it must
not be presented as one.
