# 011 — Per-id audit of #964's list against NVIDIA documentation

`003` made per-id verification a gating step: an id ships only if NVIDIA's own
documentation says text-only, otherwise it is dropped. This is that audit,
performed 2026-08-04 against `build.nvidia.com` model pages,
`docs.api.nvidia.com/nim/reference/*`, and the
[LLM APIs index](https://docs.api.nvidia.com/nim/reference/llm-apis)
cross-checked against the
[Visual Models index](https://docs.api.nvidia.com/nim/reference/visual-models-apis).

## Result

| Bucket | Count |
|---|---|
| Confirmed text-only — ship | 26 |
| Confirmed image-capable — moved to the vision list | 6 |
| Unverified / absent from NVIDIA's catalog — dropped | 32 |

#964 submitted ~64 ids. **Fewer than half survive verification.**

## Confirmed text-only (26) — these ship

Each carries an explicit `Input Modalities: Text`, `Input Type(s): Text`, or
equivalent on its NVIDIA page:

```
deepseek-ai/deepseek-v4-flash          nvidia/llama-3.1-nemotron-nano-8b-v1
deepseek-ai/deepseek-v4-pro            nvidia/llama-3.1-nemotron-ultra-253b-v1
google/codegemma-7b                    nvidia/llama-3.3-nemotron-super-49b-v1
meta/llama-3.1-70b-instruct            nvidia/llama-3.3-nemotron-super-49b-v1.5
meta/llama-3.1-8b-instruct             nvidia/nemotron-3-nano-30b-a3b
meta/llama-3.2-1b-instruct             nvidia/nemotron-3-super-120b-a12b
meta/llama-3.2-3b-instruct             nvidia/nemotron-3-ultra-550b-a55b
meta/llama-3.3-70b-instruct            nvidia/nemotron-mini-4b-instruct
meta/llama2-70b                        nvidia/nvidia-nemotron-nano-9b-v2
mistralai/mistral-7b-instruct-v0.3     openai/gpt-oss-120b
mistralai/mistral-nemotron             openai/gpt-oss-20b
moonshotai/kimi-k2-thinking            poolside/laguna-xs-2.1
moonshotai/kimi-k2-instruct            z-ai/glm-5.2
```

`z-ai/glm-5.2`, `deepseek-v4-flash`/`-pro` and the nemotron-3 family are the ids
issue #956 actually names, so the reported bug is fixed for every model in the
report.

Two notes for the implementation:

- `moonshotai/kimi-k2-thinking` and `kimi-k2-instruct` are text-only and stay in
  `NVIDIA_NIM_KIMI_MODELS` for reasoning suppression. Only k2.5 and k2.6 move to
  the vision list. The two axes are independent fields
  (`registry.ts:1238-1240`), verified by probe.
- `google/codegemma-7b` is confirmed while `google/codegemma-1.1-7b` is not — the
  point-release id has no current page. Near-identical names, different outcomes;
  exactly why name-based reasoning was rejected.

## Confirmed image-capable (6) — moved to the vision list

`thinkingmachines/inkling`, `minimaxai/minimax-m3`, `moonshotai/kimi-k2.6`,
`moonshotai/kimi-k2.5`, `stepfun-ai/step-3.7-flash`,
`mistralai/mistral-medium-3.5-128b`. Sources in `010` and `003`.

The audit found **no seventh** false positive among the remaining ids. That is
the first evidence that the correction has converged rather than merely advanced.

## Unverified — dropped (32)

Dropped rather than carried, per `003`. Dropping an id costs today's behavior;
carrying an unverified one risks the silent substitution this whole unit exists
to prevent.

**Absent from NVIDIA's current catalog (27).** `01-ai/yi-large`,
`ai21labs/jamba-1.5-large-instruct`, `aisingapore/sea-lion-7b-instruct`,
`bigcode/starcoder2-15b`, `databricks/dbrx-instruct`,
`deepseek-ai/deepseek-coder-6.7b-instruct`, `google/codegemma-1.1-7b`,
`google/gemma-2b`, `google/recurrentgemma-2b`, the four `ibm/granite-*`,
`meta/codellama-70b`, `microsoft/phi-3.5-moe-instruct`,
`mistralai/codestral-22b-instruct-v0.1`, `mistralai/mistral-large`,
`nv-mistralai/mistral-nemo-12b-instruct`,
`nvidia/llama-3.1-nemotron-51b-instruct`, `nvidia/llama3-chatqa-1.5-70b`,
`nvidia/mistral-nemo-minitron-8b-8k-instruct`, `nvidia/nemotron-4-340b-instruct`,
the four `writer/palmyra-*`, `zyphra/zamba2-7b-instruct`.

**Page exists, modality field absent (2).** `moonshotai/kimi-k2-instruct-0905`
and `nvidia/llama-3.1-nemotron-70b-instruct` — both deprecated endpoints whose
specifications omit modalities.

**Id does not match NVIDIA's catalog (3).** `mistralai/mistral-large-2-instruct`
(no such id), `mistralai/mixtral-8x22b-v0.1` (NVIDIA documents
`mixtral-8x22b-instruct-v0.1`), and `nvidia/nemotron-nano-3-30b-a3b` — a
**reversed-name typo** of the real `nvidia/nemotron-3-nano-30b-a3b`, which #964
also lists correctly. Both spellings were in the submitted list; only one is a
real model.

## What this audit demonstrates

Dropping is safe, but not for the reason first written here. A delisted id **is**
still reachable: `routeModel` accepts an arbitrary namespaced id for a configured
provider (`src/router.ts:402-421`), the default-provider fallback accepts
arbitrary ids (`:451-455`), and a stale discovery cache or custom row can surface
one. The correct statement is narrower: **excluding these ids leaves them at
today's unclassified behavior even when reached**, since the current `nvidia`
entry classifies none of them, and a user's own `noVisionModels` entry still
survives the union merge.

What the drop count measures is provenance. 32 of 64 entries unverifiable —
including `nvidia/nemotron-nano-3-30b-a3b`, a reversed-name typo of a real id the
same list also spells correctly — shows how much of #964's list was assembled
rather than verified. The six reversed entries were the visible damage; this is
the extent of it.

It also bounds the fix honestly. 26 verified ids is a real fix for real models,
not a claim about NIM as a whole.
