# 050 — Phase 6: Anthropic response-model identity (#1117, PRs #1122/#1121)

Credit: **Giulio Leone** (`Giulio Leone <email from PR head>`, PR #1122,
also the reporter of #1117) and **ingwannu**
(`Ingwannu <email from PR head>`, PR #1121 — independent correct
diagnosis of the same defect). Adoption: **adapted**, narrowed to Anthropic.

## Defect

`applyFinalRouteRequestNormalization` rewrites `parsed.modelId` from the
Codex-facing selector to the bare upstream Anthropic id
(`src/server/responses/core.ts:867`). Every downstream consumer then builds
`response.model` from the mutated value:

- normal Responses bridge — `src/server/responses/core.ts:2562`
- image loop — `src/images/loop.ts:902`
- web-search loop — `src/web-search/loop.ts:772`

So a request for `anthropic/claude-sonnet-5` comes back as `claude-sonnet-5`,
and a client that round-trips `response.model` loses the provider routing.

## Why adapted rather than cherry-picked

#1122 is the stronger of the duplicate pair — it covers passthrough JSON/SSE and
alias collisions that #1121 misses — but it grows a narrow Anthropic identity
bug into a generalized cross-provider response-identity and catalog-lifecycle
rewrite across 25 files. A bug fix that changes response identity for every
provider is a contract change wearing a fix's clothing. The stack keeps the
correct mechanism and drops the generalization.

## Change

| Path | Op | Content |
|------|----|---------|
| `src/server/responses/core.ts` | MODIFY | Inside `applyFinalRouteRequestNormalization`, capture the pre-rewrite Codex-facing selector into a dedicated field (`clientFacingModelId`) **only on the Anthropic branch that performs the rewrite**; leave `parsed.modelId` as the upstream wire model so the Anthropic request body is unchanged |
| `src/server/responses/core.ts` | MODIFY | At the streaming and JSON builders emit `clientFacingModelId ?? modelId`. Because the field is set only where the Anthropic rewrite happens, providers that never rewrite are byte-identical — the `??` fallback is what keeps this a fix rather than a cross-provider contract change |
| `src/images/loop.ts` | MODIFY | Thread the selector through the loop's dependencies instead of reading mutated `parsed.modelId` (~`:902`) |
| `src/web-search/loop.ts` | MODIFY | Same (~`:772`) |
| `src/server/request-log.ts` | MODIFY | Keep the physical routed model in request logs — observability must still show what was actually called |
| `tests/anthropic-response-model.test.ts` | NEW | Qualified and legacy bare selectors; streaming and JSON; assert the upstream request body still carries the bare model |
| `tests/images/*`, `tests/web-search*.test.ts` | MODIFY | Bridge cases for both loops |

**Explicitly not done here:** hidden bare-selector compatibility catalog rows.
#1122 generates them with an ownership marker, but catalog row generation with
restore/removal semantics is a separate contract with its own failure modes
(user-owned row collision, restore deleting a generated row). If the bare
selector needs to keep resolving, that is its own unit — noted in the PR so the
decision is visible rather than silently dropped.

**Scope guard (audit finding 4).** A regression test asserts that a non-Anthropic
routed provider whose public and wire model differ emits exactly the same
`response.model` as before this phase. If that test cannot be written without
the field being set for that provider, the narrowing has failed and the phase
returns to P rather than shipping a silent contract change.

Exact line numbers are deliberately omitted here: `core.ts` is edited by phases
050, 060, 070, and 130, so each phase re-locates its anchor by symbol
(`applyFinalRouteRequestNormalization`, the relay rewrite composition point)
at its own P rather than trusting a line number recorded before four edits.

## Verification

- `bun test tests/anthropic-response-model.test.ts` plus the image/web-search bridge suites
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 05, base = stack 04 head. `Closes #1117`. Credits Giulio Leone as the
reporter and primary implementer and ingwannu for the independent diagnosis,
and states plainly which parts of #1122 were intentionally not carried over.
