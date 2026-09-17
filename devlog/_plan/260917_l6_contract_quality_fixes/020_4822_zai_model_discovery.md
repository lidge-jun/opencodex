# U2 — Z.AI discovery needs both the endpoint and the envelope

Source: issue #4822. Verified against `f1dfda8e48`.

## The trap in this issue

There are two defects and fixing either one alone leaves discovery broken.

The `zai` registry row carries `baseUrl: "https://api.z.ai"` and no
`modelDiscovery` spec, so `providerModelsUrl` builds
`https://api.z.ai/models`, which the reporter observed as an nginx 404. The
row already knows the real prefix — it sets `responsesPath: "/api/v1/responses"`
— and `src/providers/registry/model-seeds.ts` already records
`GET https://api.z.ai/api/v1/models` as the authoritative roster URL in a
comment. Only the discovery URL disagrees with the rest of the row.

Correcting the URL alone still fails. `extractProviderModelItems` accepts one
envelope key, `data`, or a top-level array, and reads each row's `id`. Z.AI
returns `{"models": [{"slug": "glm-5.3"}, ...]}`, so the parser answers
`{ ok: false, reason: "invalid_shape" }` and the dashboard reports the same
failure it reported before, with a different cause.

## The opposite trap

This is also not a reason to generalize the discovery contract. The single
allowlisted `data` envelope is deliberate: the code comment at line 505 records
that a bare `models` key on an openai-chat response is specifically *not*
accepted, and `buildSiblingIndex` already uses a `models[]` sibling for a
different purpose — enriching rows that entered through `data[]`. Teaching the
shared parser to accept `models[].slug` for everybody would change what a
`models` key means for every provider that sends one, and llama.cpp's
dual-envelope body is served by exactly that distinction.

So the envelope and identifier widening is scoped to the provider that needs it,
through the existing per-provider `modelDiscovery` spec, not by relaxing the
default.

## Change

Two edits, one provider.

1. `src/providers/registry/entries-extended.ts`: give the `zai` row a
   `modelDiscovery` spec pinning the path to `/api/v1/models`. The `path`
   form resolves against the registry's own `baseUrl`, which
   `isRegistryModelDiscoveryUrl` already treats as canonical, so the
   URL-allowlist check keeps working. `baseUrl` itself is not touched —
   `responsesPath`, `chatCompletionsPath` and `destinationAliases` all resolve
   against it and changing it would move the inference wires.
2. `src/providers/model-discovery.ts`: let a `modelDiscovery` spec declare the
   envelope key and the identifier field it expects, and apply that in
   `extractProviderModelItems` instead of the hard-coded `["data"]` /
   `id` pair. Providers without a spec keep the current behaviour byte for
   byte.

The `models` static seed stays. Discovery failing back to a seeded roster is
the behaviour `liveModels` already relies on, and the seed is what keeps the
picker populated while the live call is in flight.

## Regression coverage

`tests/providers/provider-model-discovery-contract.test.ts` is the existing home
for both halves, so no new test file and no layout entry.

1. `resolveProviderModelDiscoveryUrl("zai", ...)` yields
   `https://api.z.ai/api/v1/models`, and `isRegistryModelDiscoveryUrl` accepts
   that URL and rejects `https://api.z.ai/models`.
2. `extractProviderModelItems` on `{"models":[{"slug":"glm-5.3"}]}` with the
   `zai` spec returns the model, and the same body with no spec still returns
   `invalid_shape`. The second assertion is what keeps this scoped.
3. The inference paths are unchanged: the `zai` row still resolves
   `/api/v1/responses` and the Chat alias after the spec is added.
