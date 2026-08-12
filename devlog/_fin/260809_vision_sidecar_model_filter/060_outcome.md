# 060 — outcome

Shipped. Three layers on `dev`, bottom-up, one PABCD cycle each.

| Layer | PR | Merge commit | What landed |
|---|---|---|---|
| 1 — eligibility predicate | #1326 | `eebd9d48f` | `src/vision/eligibility.ts`, the devlog unit |
| 2 — management API + write gate | #1327 | `d4758bc94` | options module, both routes, shared model resolver |
| 3 — dashboard card | #1328 | `e96a81bed` | filtered picker, backend provenance, card shell |

## What the user asked for, and what answers it

**"Only models that can actually read an image."** `visionEligibleModelOptions` emits a
row only when an executor can reach it and no source proves it blind. The trap that
shaped the design is in `000_plan.md`: `noVisionModels` marks models the proxy describes
FOR, and the catalog deliberately ADDS `"image"` to exactly those rows, so advertised
modalities alone would have selected blind describers.

**"gpt-5.6-luna and claude-haiku-4-5 must always be there."** Each enabled side's
baseline is inserted before catalog candidates and survives a catalog outage, an empty
catalog, and a fresh install with no providers. It is withheld in exactly one case: the
provider explicitly lists it in `noVisionModels`. Silence never removes it.

**"Show the allowed list, in the delegation card's shape, no i18n indirection,
compact reasoning."** Layer 3, with the web-search card given the same shell so the
two read as one row.

## What review changed

Eight automated findings arrived after publication; seven were real. They shared one
root cause, recorded in `050_stack_landing.md`: an option was emitted as a bare model id
and the provider identity that proved it eligible was discarded, so every consumer
re-derived a provider and each derived it differently.

Four independent audit rounds ran on top of that, and three of them found something the
implementation had missed:

- Layer 1 still offered a canonical Anthropic row when no executor was resolvable, so a
  key-auth provider — which `findAnthropicVisionProvider` never returns — could be picked
  and then fail at describe time. Fixed in `0ac7552be`.
- Layer 2's defaulted parameter re-read the OAuth account store up to four times per
  response, because the no-executor case passes an explicit `undefined`. Fixed in
  `6196fc5cd`.
- Layer 3 dropped the persisted backend on the grandfathered entry (`c0e651285`), and
  collapsed "no `visionModels` key" with "`visionModels: []`", which let a current
  server's authoritative empty answer be replaced by the unfiltered catalog —
  re-offering the exact text-only rows this unit removes (`21c7157f3`).

The last one is the one worth remembering: the feature would have shipped with a path
that quietly undid it, and only an end-to-end pass over the merged tree saw it. Per-layer
review had signed off on both halves separately.

## Verification

- `bun run typecheck` — exit 0
- `bun run lint:gui` — clean
- `bun test tests/vision-eligibility.test.ts tests/sidecar-settings-vision-filter.test.ts tests/vision-reasoning-contract.test.ts ./gui/tests/vision-model-options.test.ts` — 42+ pass / 0 fail
- `bun run build:gui` — builds
- Full suite green through the pre-push gate on each layer; CI green on each PR before its merge

Two CI flakes cost time and are worth naming so the next person does not debug them:
15-minute shard timeouts from `tests/cli-help.test.ts` hanging after a `cli-account`
error, and a bun-level `EEXIST: epoll_ctl`. Both reproduced on unrelated PR #1324, and
both passed on rerun.

## Follow-ups, not done here

`visionDescriberIsProvablyBlind` probes both vendor tables for an unmatched id, which is
safe only because the two tables share no bare model id. If that ever stops being true,
the probe needs the executor identity the option list already carries.
