# P1: provider state continuity

Issues: #5563 (explicit compatibility settings lost on provider save) and #5618 (shadow-call
intercept keeps targeting a disabled or deleted provider). Carries #5614.

## Problem

Saving a provider rebuilds the stored row from the submitted body. `POST /api/providers` carries a
list of fields the add/edit form cannot send (`apiKeyPool`, `modelCosts`, context windows, pacing,
and others), but none of the five operator compatibility settings:

- `preserveReasoningContentModels`
- `requiresReasoningPlaceholderModels`
- `foldDeveloperRoleToSystem`
- `reasoningWireFormat`
- `omitReasoningEffortWithToolsModels`

After an unrelated overwrite a custom provider loses them, and a registry provider gets the
registry seed back through `enrichProviderFromCatalog`. `src/config/live-reconcile.ts` cannot
restore them: the disk row equals its baseline, so the three-way merge keeps the live value the
save just wrote. The symptom reads as an old bug returning, for example a gateway that rejects the
`developer` role failing Native Chat after an edit to something unrelated.

Separately, `shadowCallIntercept.model` can name a provider that is later disabled or deleted.
Disabled: `routeModel` throws `Provider is disabled` and the request fails with a generic 404,
logged as `http_404`, on every helper call. Deleted: a `provider/model` target whose provider no
longer exists falls through to the terminal default-provider fallback and is sent, unannounced,
to a different destination with different credentials and cost. Neither management route says
that the intercept depended on the provider.

## Decisions

1. **Survive/reset contract (Part 1).** The five settings are operator compatibility choices
   about one upstream. A POST overwrite that keeps the same destination carries each stored value
   the request omits, including an explicit `[]` or `false`. A POST overwrite that changes the
   destination carries none of them, and it also stops carrying the stored `apiKeyPool`, since
   those keys were issued for the previous destination. Destination means the adapter, the
   normalized base URL and the auth mode. The whole old row is never merged into the candidate.
2. **PATCH is a field mask.** It already keeps every field it does not name. It gains write
   branches for the four settings it rejects today (the two reasoning lists from #5614, plus
   `foldDeveloperRoleToSystem` and `reasoningWireFormat`), with `null` clearing a field. PATCH does
   not apply the destination reset; it only changes the fields a request names.
3. **Shadow target lifecycle (Part 2).** Disabling or deleting a provider that the intercept
   target resolves to succeeds, and the response carries `dependentShadowIntercept`, which
   the dashboard shows as a warning. At request time an unavailable target (disabled provider,
   unknown combo, or a slash-qualified target that would only resolve through the terminal
   default-provider fallback) returns one `409 intercept_target_unavailable` without an upstream
   attempt. It never passes through to native and never falls back to the default provider.
   Combo and routing-profile targets keep their declared failover, which is the fallback the
   operator approved.

## Phases

- [010_part1_compat_contract.md](./010_part1_compat_contract.md): Part 1 implementation and tests.
- [020_part2_shadow_target_lifecycle.md](./020_part2_shadow_target_lifecycle.md): Part 2 implementation and tests.
- [030_delivery.md](./030_delivery.md): PR, docs parity and exact-head CI.

## Constraints

No local suite, typecheck, build or proxy run in this lane (local checks: NOT RUN); evidence is
static reading plus hosted CI on the exact head. `src/server/management/provider-routes.ts` is
1892 lines and the ratchet flags any file above 2000 lines, so new logic goes into sibling modules
and the route keeps only call sites.
