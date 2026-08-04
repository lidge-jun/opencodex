# WP1 server summary canonicalization

## Recommended rule

Define summary identity as the tuple:

`(baseProviderLabel(attribution.provider), canonicalCallModel(providerKey, attribution.model))`

Serialize the tuple with an unambiguous delimiter such as NUL; do not concatenate raw strings. For `providerKey === "google-antigravity"`, canonicalize by first resolving aliases to wire IDs and then mapping known wire IDs to the picker base. For every other provider and every unknown Antigravity ID, return the original model unchanged.

## Diff-level plan

1. `src/providers/antigravity-models.ts`
   - Add a private `wire -> canonical base` map covering all eight wire identities.
   - Export `canonicalAntigravityCallModelId(modelId)`: `resolveAntigravityWireModelId(modelId)` then reverse-map; unknown IDs pass through.
   - Keep routing resolvers and picker arrays unchanged.
2. `src/usage/summary.ts`
   - Import the canonicalizer and add one provider-aware helper returning canonical model plus a collision-safe key.
   - In `buildDayGrid`, use canonical model in `mKey` and emitted `UsageDayModel.model`.
   - In `buildModels`, use canonical model in map/status keys and emitted `UsageModel.model`.
   - Do not propagate a non-canonical Antigravity `resolvedModel` into the merged summary row; omit it (preferred) or canonicalize it to the same base.
   - In both cost accumulation branches, estimate cost with original provider/model, but look up the destination row with the same canonical summary key. Otherwise costs disappear after keys change.
3. Tests
   - `tests/google-antigravity-wire.test.ts`: table-test every row in the reverse-map inventory plus unknown passthrough.
   - `tests/usage-summary.test.ts`: mix base, wire, visible alias, historical alias, resolved present/absent, exact/account-scoped provider, and repeated request IDs. Assert one Flash row, one Pro row, summed tokens, deduped requests, attempt counts, status counts, shares, and retained costs.
   - Assert `days[].models` uses the same canonical bases.
   - `tests/api-usage.test.ts`: optional endpoint-shape regression proving the API returns canonical rows from historical fixtures.

## Important edge cases

- `requestedModel` must not drive grouping: it is absent in most sampled rows and sometimes provider-qualified.
- Preserve request de-duplication by canonical key plus request ID.
- Combo attempt attribution must canonicalize each attempt by its own provider/model.
- Cost matching must still receive original IDs; only the destination-row lookup is canonicalized.
- No JSONL migration: old data should collapse immediately on server restart.

## Audit amendments (A-gate round 1, main synthesis after Sol timeout)

- **B1 High ACCEPTED — cost key rebucket:** `buildModels` cost pass currently keys `${provider}${entry.model}` / attempt model without reverse-map. Canonicalize those keys too or costs land on missing rows (live baseline already shows some rows cost=None while siblings priced).
- **B2 High ACCEPTED — omit same-family resolvedModel:** If summary keeps wire `resolvedModel`, `ProviderUsage.tsx` and `Usage.tsx` prefer it over `model` and undo collapse. WP1 must omit antigravity resolvedModel when it reverse-maps to the same base; WP2 still flips primary label to `model` as belt-and-suspenders.
- **B3 Medium ACCEPTED — day-grid identity:** `buildDayGrid` uses raw `attribution.model`; canonicalize there too so 7d stacked bars match 30d table.
- **B4 Medium ACCEPTED — reverse-map source:** Derive reverse map from effort wire map + aliases + picker bases; include visible aliases (`gemini-3.1-pro-high`, `gemini-3.1-pro-preview`) and historical `gemini-3.5-flash-*` / `gemini-3-flash-agent`.
- **B5 Medium ACCEPTED — new base calls:** Adapter sends wire id upstream but `logCtx.model` stays route/selected model; `applyResponseLogMetadata` may set resolvedModel from upstream. Collapse must handle model=base with resolved=wire without splitting.
- **B6 Low ACCEPTED — non-antigravity unchanged:** OpenAI virtual models remain keyed by selected model, not resolved base.

Implementation order inside WP1:
1. export `canonicalAntigravityUsageModel`
2. normalize attributions for antigravity in summary
3. tests for merge + cost + day models + non-regression

## Sol A-gate contracts (Bernoulli, folded at B)

1. **Price fallback (High):** `gemini-pro-agent` has no expected-prices overlay. When estimating cost, try original model id first; if unmatched, retry with `canonicalAntigravityUsageModel(model)`. Add explicit overlay for `gemini-pro-agent` if still missing after reverse (or rely on base `gemini-3.1-pro` fallback). Test merged row cost > 0 for pro-agent family and equals sum of per-entry estimates using fallback.
2. **Truth table (High):** Canonicalize with explicit precedence:
   - candidate = model
   - if provider is google-antigravity: `canonical = reverse(candidate)`; if identity and resolvedModel present, `canonical = reverse(resolvedModel)` when that yields a known base
   - emit `model: canonical`; omit `resolvedModel` when reverse(resolved) == canonical OR reverse(model) == canonical
   - unknown ids stay identity
   Unit-test every reverse-map entry + unknown.
3. **Cost destination vs price source:** price lookup may use original id (with base fallback); destination bucket always uses canonical model key.
4. **Combo attempts:** per-attempt model canonicalized for identity and cost destination keys; request folding still by requestId.
5. **Day grid:** same canonical model in `days[].models`.
6. **Keys:** prefer `${providerKey}\0${model}` or `${providerKey}/${model}` over bare concat (nit — adopt `/` delimiter while touching keys if low-risk; otherwise keep concat for minimal diff and document).

