# 030 — "Max": what regular Cursor shows vs what the local runtime can show

The user asked why the picker has no "Max". Two different things carry that name.

## Reasoning-effort max / ultra: not reachable

cursor-agent-exec/dist/main.js builds the Reasoning ladder from a hard-coded regex table
(b[], 000 §4). For gpt-5.6-(luna|sol|terra) it is ["low","medium","high","xhigh"]. The
gateway's capabilities.reasoning_effort only decides whether supports_reasoning is true; the
values are never read into the ladder. So opencodex's max/ultra cannot appear without a
Cursor-side change. Document, do not fight.

## Max Mode (long context): reachable as a "Context" selector

Regular Cursor's "Max" toggle is Max Mode = larger context window. The local runtime has the
same concept: J() adds a **Context** parameter (id:"context") with two values when
longContextThresholdTokens < contextLength:

    s = ({contextLength:t, longContextThresholdTokens:n}) => (t===undefined||n===undefined||n>=t) ? undefined : {defaultTokens:n, longTokens:t}
    // values: [{value:String(defaultTokens), displayName:"272K"}, {value:String(longTokens), displayName:"922K", increasesModelCost:true}]

On send, the chosen value caps the request's context length (R="context" lookup in
modelParameters, then Math.min(chosen, contextLength)). The threshold comes from
long_context_threshold_tokens, which the row parser cme() derives, in order, from:

1. cost.long_context.threshold_tokens — BUT cost must pass zod mme (numbers or
   record-of-numbers only); a nested object fails it and the row loses
   extendedCapabilitiesDetected. Unusable.
2. capabilities.cost.long_context.threshold_tokens — same schema, same failure.
3. pricing.overrides[].min_prompt_tokens (smallest positive) — pricing is not in the schema,
   so validation ignores it and only this reader sees it. **This is the encoding.**

So each row gains, when the catalog knows a default window and a larger opt-in window:

    "pricing": { "overrides": [ { "min_prompt_tokens": 272000 } ] }

## Data

- Native GPT-5.6 family: default NATIVE_GPT56_CONTEXT_WINDOW 272_000, opt-in
  nativeOpenAiMaxInputTokens(slug, limits) 922_000 (metadata.ts:130-142, 281). For the
  selector: context_length = opt-in window (922k), threshold = default window (272k) when
  they differ.
- Routed rows: no separate opt-in window in CatalogModel today (contextWindow only;
  maxInputTokens is a hard input cap, not a long-context tier). No threshold → no selector,
  which matches what a plain OpenAI gateway would advertise.

## File change map

| Path | Action |
|---|---|
| src/server/models-capabilities.ts | MODIFY — ModelCapabilityInput.longContextWindow?; when longContextWindow > contextWindow, set capabilities.context_length = longContextWindow and add pricing.overrides[{min_prompt_tokens: contextWindow}] |
| src/server/index.ts | MODIFY — native row passes longContextWindow: nativeOpenAiMaxInputTokens(metadataId, nativeLimits) (add to the catalog destructuring; re-exported at src/codex/catalog.ts:5) |
| tests/cursor-local-models-schema.test.ts | MODIFY — unit: threshold emitted only when long > default; server: gpt-5.6-sol has pricing.overrides[0].min_prompt_tokens === 272000 and context_length === 922000; routed kimi/k3 has no pricing |
| docs-site guide | MODIFY — "Reasoning effort vs Max Mode" paragraph |

## Verify

- bun run typecheck; bun test tests/cursor-local-models-schema.test.ts tests/grok-models-effort-list.test.ts tests/server-combo-failover-e2e.test.ts.
- Live: refresh model list (new base-URL spelling to bust the cache) → picker for gpt-5.6-sol
  shows **Context: 272K / 922K**; screenshot 031_context_selector.png.

## Then

Update PR #3230/#3231 bodies, address reviewer feedback, admin squash-merge #3230 → dev,
retarget #3231 → dev, CI, merge, git merge-base --is-ancestor proof.

