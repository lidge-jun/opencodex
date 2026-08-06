# 040 — `qwen3.8-max-preview` → `qwen3.8-max`, with the vendor's published price

Added to this unit after the roadmap cycle opened, at the user's request. It
ships as its own commits on the stack-7 branch.

## The rename

Alibaba released Qwen3.8-Max as a stable production model on 2026-08-03; the
preview endpoint is documented as liable to be taken offline once preview
concludes ([Qwen blog](https://qwen.ai/blog?id=qwen3.8)). Model Studio lists both
ids today — `qwen3.8-max` as the recommended model, `qwen3.8-max-preview` still
present as a separate preview id
([Model Studio models](https://help.aliyun.com/en/model-studio/getting-started/models)).

So `qwen3.8-max` becomes the id this registry names everywhere. Both providers
are affected: `alibaba-token-plan` and `alibaba-token-plan-intl`.

### Whether to keep `-preview` as an alias

**Decision: do not add an alias.** A user whose config names
`qwen3.8-max-preview` keeps working without one, because `routeModel` accepts an
arbitrary namespaced model id for a configured provider (`src/router.ts:402-421`)
and forwards it to the upstream, which still serves that id. The registry entry
governs catalog rows and capability metadata, not whether a hand-named id can be
called.

What such a user loses is the capability metadata keyed to the old id — context
window, reasoning efforts, `preserveReasoningContentModels`. That is the correct
outcome for a preview id the vendor is retiring: the metadata should follow the
supported model. Adding an alias would instead pin retired-preview metadata into
the registry indefinitely.

### Call sites

`src/providers/registry.ts` — 10 occurrences: the two model lists (`:355`,
`:359`, `:375`, `:382`), input modalities (`:362`, `:453`), `defaultModel`
(`:1424`), context windows `983_616` (`:1430`, `:1459`), reasoning efforts
(`:1468`), `modelDefaultReasoningEfforts` (`:1481`), and
`preserveReasoningContentModels` (`:1440`, `:1478`).

`src/usage/expected-prices.ts` — the two overlay rows (`:137`, `:138`) plus the
source constant (`:62-63`).

Tests naming the old id: `tests/alibaba-intl-token-plan.test.ts`,
`tests/qwen38-preserve-reasoning.test.ts`, `tests/claude-desktop-1m.test.ts`,
`tests/subagent-model-fallback-api.test.ts`,
`tests/router-discarded-baseurl-warning.test.ts`,
`tests/provider-registry-parity.test.ts`.

Context window (983,616), reasoning efforts (`low`/`high`/`xhigh`), default
effort (`xhigh`), and modalities (`["text","image"]`) all carry over unchanged —
this is a rename, not a re-specification.

## The price

Qwen publishes **$2 input / $6 output** per million tokens for Qwen3.8-Max
([Qwen blog](https://qwen.ai/blog?id=qwen3.8)), matching the figures the user
gave.

Today the overlay carries a **reseller proxy** rate:

```ts
const QWEN38_ROUTEWAY_TEMPORARY: Cost4 = { input: 1.5, output: 5, cacheRead: 0.15, cacheWrite: 0 };
// "https://routeway.ai/models/qwen3.8-max-preview (temporary reseller proxy;
//  NOT Alibaba Token Plan billing; cacheWrite unpublished -> 0)"
```

Its own comment states the exit condition: *"Replace these overlays when Alibaba
publishes an official qwen3.8-max-preview token rate."* A vendor price now
exists, so the Routeway overlay and its constant are removed entirely rather than
edited.

### Two honesty constraints

**The $2/$6 figure is Qwen's own announcement, not a Model Studio billing table.**
The Model Studio pricing page lists `qwen3.7-max` ($2.50/$7.50) and `qwen3-max`
(tiered $1.20–$3.00 / $6.00–$15.00) but does not yet carry a `qwen3.8-max` row
([Model Studio pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing)).
The source string must say so instead of implying a billing-table verification.

**Cache rates are unpublished.** The existing `cacheRead: 0.15` is a Routeway
number; once that source is dropped, nothing supports it. Both cache fields go to
`0`, following the convention already used in this file
(`cacheWrite unpublished -> 0`, and `GEMINI_PRICING`'s per-hour-storage note).
Carrying a reseller cache rate under a vendor-price label would be the worse
outcome — a wrong number wearing a verified badge.

Status stays **`verified`** for input/output: the vendor published them. The
source string records that cache is unpublished and that Model Studio has no row
yet.

## Delisted models

"Remove models no longer served" applies to the same sweep as `011`: an id absent
from the vendor's current catalog is removed rather than carried. For NIM that is
the 32 ids `011` already dropped. For Alibaba it is the preview id, superseded
above.

## Tests

1. Both Alibaba entries expose `qwen3.8-max` and no longer expose
   `qwen3.8-max-preview`.
2. Capability metadata survives the rename — context window 983,616, efforts
   `["low","high","xhigh"]`, default `xhigh`, modalities `["text","image"]`,
   membership in `preserveReasoningContentModels`. Ablate by dropping one
   metadata key during the rename and watch it go red.
3. The price overlay returns `{ input: 2, output: 6 }` for both providers, with
   no Routeway string left in the file.
4. `defaultModel` on `alibaba-token-plan-intl` resolves to the new id, so a bare
   config still routes.
