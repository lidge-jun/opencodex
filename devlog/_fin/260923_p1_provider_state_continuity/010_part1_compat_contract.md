# 010: Part 1, explicit compatibility settings survive provider saves

## Field contract

| Field | Unrelated POST overwrite (same destination) | POST overwrite to a new destination | PATCH |
|---|---|---|---|
| `preserveReasoningContentModels` | stored value carried when omitted, `[]` included | not carried (registry seed may fill) | set, `[]` kept, `null` clears |
| `requiresReasoningPlaceholderModels` | same | not carried | set, `[]` kept, `null` clears |
| `foldDeveloperRoleToSystem` | stored `true`/`false` carried when omitted | not carried | boolean, `null` clears |
| `reasoningWireFormat` | stored value carried when omitted | not carried (registry seed may fill) | `"gateway-object"`, `null` clears |
| `omitReasoningEffortWithToolsModels` | stored value carried when omitted | not carried | unchanged (already handled) |
| `apiKeyPool` (credential) | carried, as today | not carried | not writable (key endpoints) |

A value the request sends always wins. All other fields the POST handler already carries keep
their current behavior; this unit does not widen or narrow them.

Destination is the tuple (adapter, normalized base URL, auth mode). The base URL is normalized by
lowercasing the scheme and host and dropping trailing slashes. Auth mode counts only when the
request names one: the dashboard form sends `authMode` only for `key` and `forward`, and
registry enrichment never sets it, so an omitted value is not evidence of a new destination.

## Diff plan

- New `src/server/management/provider-overwrite-carry.ts`:
  - `PROVIDER_COMPAT_CARRY_FIELDS`: the five field names, as a readonly tuple the tests import.
  - `sampleSubmittedCompatFields(prov)`: `Object.hasOwn` snapshot, taken before
    `enrichProviderFromCatalog` like the other `submitted*` samples.
  - `sameProviderDestination(a, b)`: the destination comparison above.
  - `compatFieldConfigError(raw)`: POST type checks when a client does send a field
    (non-blank string arrays for the three lists, boolean for fold, `"gateway-object"` for wire
    format).
  - `carryProviderCompatFields(prov, live, submitted)`: when the destination is unchanged, copy
    each omitted field from the live row (read after the DNS await, so a PATCH landing during the
    wait is kept). When it changed, copy nothing: the candidate keeps only what the request sent
    and what registry enrichment filled for the new destination.
  - `applyProviderCompatPatchFields(rawBody, next)`: the PATCH branches for the reasoning lists
    (from #5614), `foldDeveloperRoleToSystem` and `reasoningWireFormat`.
- `provider-routes.ts`: call the sampler before enrichment, run `compatFieldConfigError` beside
  the other body checks, gate the existing `apiKeyPool` carry on `sameProviderDestination`, call
  `carryProviderCompatFields` next to `restorePersistedAliasOverlays`, and call the PATCH helper from
  `applyProviderPatchFields`.
- Carry #5614: its test file `tests/server/management-provider-reasoning-lists.test.ts` (PATCH
  and dashboard-save cases, registry seed case, concurrent PATCH during DNS) is kept, adapted to
  the helper. The branch commit carrying it has a `Co-authored-by` trailer for the #5614 author.
- New `tests/server/management-provider-compat-carry.test.ts`: for each of the five fields, seed a
  custom provider, send an unrelated POST overwrite with the same name that omits the field,
  reload with `loadConfig()`, route with `routeModel`, build the outgoing request with the chat
  adapter, and assert the field's effect on the body. A second group changes the base URL, adapter
  or auth mode and asserts none of the five fields and no `apiKeyPool` carry.
  Both test files are registered in `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.

## Effects asserted on the next outgoing request

- fold: a native-chat passthrough body with a `developer` message goes out as `system` when the
  stored value is `true`; or on the translated path `false` keeps `developer`.
- wire format: `reasoning: { enabled, effort }` instead of `reasoning_effort`.
- omit list: a tool-bearing request for a listed model carries neither `reasoning_effort` nor
  `reasoning`.
- preserve list: an assistant tool-call continuation carries `reasoning_content` when the list
  names the model.
- placeholder list: an explicit `[]` stops the placeholder that the preserve list would otherwise
  imply.

## Docs

`docs-site/src/content/docs/reference/configuration/providers.md` gains a short "What a provider
save keeps" section with the table above, and the five rows say how PATCH clears them. The seven
translated pages get the same section. `structure/gui-and-management-api.md` records the contract
next to the provider routes.
