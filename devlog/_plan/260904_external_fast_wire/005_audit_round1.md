# 005 — Audit round 1: synthesis and disposition

Adversarial plan audit of `000/010/020/030/040` returned **FAIL** with 8 blockers. All 8 are
accepted; 6 change the design, 2 change scope. This doc records the decision per blocker so
a later reader sees why the plan moved, and the decade docs are amended in place.

## Round 2 outcome

The amended docs were re-audited and FAILED again: appending amendment sections had left
each doc carrying two contradictory instructions per call site, and the `hasCompositeRowMarkers`
helper introduced for B5 was itself defective — asymmetric (it caught `x--high--fast` but
not `x--fast--high`) and blind to a real base named `a--high`, whose legitimately published
`a--high--fast` row it would have suppressed.

Both findings are accepted. `010`, `020`, and `030` were REWRITTEN canonically rather than
amended, so each call site has exactly one executable instruction, and the composite guard
was deleted in favour of requiring the stripped base to be a known routable model — the
arbitration the collision inventory already performs. The per-blocker disposition below
records the original round-1 reasoning; where round 2 changed the mechanism, the decade doc
is authoritative.

## B1 — Claude alias collision (design change)

A Claude alias is `claude-ocx-<provider>--<model>` (`src/claude/alias.ts:89`) — it already uses
`--` as its own provider separator. So a real model `foo--fast` becomes
`claude-ocx-p--foo--fast`, and a naive suffix strip on the raw alias yields
`claude-ocx-p--foo`, routing `p/foo`: a different model, silently.

`knownEffortRowIds()` does not contain Claude aliases (`effort-row.ts:44`), so it cannot
defend this.

**Decision.** On the Claude surface the fast marker is parsed only after alias decoding, not
before. `decodeClaudeAlias` yields `{provider, model}`; the marker is stripped from `model`,
and the known-id check runs against the decoded routed id, where `knownEffortRowIds()` is
authoritative. wp3 carries the amended ordering.

This also means the fast row published for Claude is `claude-ocx-p--foo--fast` where the
marker is the LAST `--` segment of the model half — well-defined, because the alias's own
separator is the FIRST one after the prefix.

## B2 — native eligibility must be policy-derived (design change)

`nativeFastEligible()` read only upstream `additional_speed_tiers`, which ignores an
operator's `supportsServiceTier: false` and the final wire resolution. Publishing on
upstream metadata alone would advertise Fast on a route the runtime then drops.

**Decision.** Both conditions required: upstream native evidence AND
`fastRowEligible(provider, metadataId, providerName)`. Upstream evidence alone never
publishes.

## B3 — Claude native loop was missed (design change)

`buildAnthropicModelInfos` has two loops: natives at `model-info.ts:143` and routed at
`:155`. The plan only patched the routed one, so `gpt-5.6-sol` — the flagship Fast model —
would have gained no row on Claude discovery. That contradicts the unit's own goal.

**Decision.** Both loops gain the additive row, sharing one predicate.

## B4 — two ingresses were missed (scope change)

- `/v1/messages/count_tokens` (`claude-messages.ts:1022-1036`) resolves a model and can hand
  it to native passthrough with no fast parsing — a synthetic id would be forwarded
  upstream as an invalid model.
- `/v1/responses/compact` (`compact.ts:502-515`) routes `raw.model` through
  `routeCompactionModel` with no tier handling, so a fast id would not round-trip.

**Decision.** Both join wp3. `count_tokens` only needs the model rewritten to the base
before `wantsNativePassthrough` — it returns a token estimate and sends no tier. `compact`
rewrites the model and carries `service_tier` so compaction runs at the tier the caller
selected.

## B5 — parse ordering made the two grammars compose by accident (design change)

The Responses path parsed the effort row first and mutated `parsed.modelId`, then parsed
fast from the mutated value. So `x--fast--high` would fire BOTH dimensions, while
`x--high--fast` fires neither — and Chat and Messages, which parse from the immutable
requested id, would disagree with Responses about the same string.

**Decision.** Every ingress parses every grammar from the immutable original selector, and
an id carrying both markers is accepted as NEITHER. One grammar per id, enforced
identically on all five surfaces. wp1 owns the check so it cannot drift per call site.

## B6 — `/api/models` and the exporters (scope change)

`/api/models` `namespaced` ids feed `ocx export` and the OpenCode integration
(`src/cli/opencode.ts:368`, `src/cli/export-command.ts:78`). Those are external clients by
any reading, so excluding them while claiming "external clients" was inconsistent.

**Decision.** Narrow the claim rather than widen the blast radius. `namespaced` ids are
`disabledModels` keys and export identities; adding synthetic rows there risks writing a
synthetic id into a user's persisted config. wp4's docs state plainly that `fastRows`
covers the request-serving surfaces — `/v1/models`, Claude discovery, and the four
ingresses — and that `ocx export` and OpenCode emit base ids only. Revisit on request.

## B7 — Cursor management status patch was underspecified (scope change)

The proposed `fastRow` field referenced an `eligible` value the mapper cannot derive: it
keeps only the public id, not `{provider, modelId}` (`cursor-integration-routes.ts:69`).

**Decision.** Dropped from wp2. It is a Cursor-integration status panel, not a client-facing
selector, and plumbing model identity through it buys nothing for this unit's goal.

## B8 — wp1 write scope (correction)

`src/server/effort-row.ts` is edited by wp1 (exporting `isKnownId`) but was absent from its
scope line. Added.

## Non-blocking notes accepted

- `applyCatalogMetadata` misnamed; the writer is `applyCatalogModelMetadata`
  (`effort.ts:160`). Corrected in `000`.
- `UPSTREAM_NATIVE_ENTRIES` is not currently imported by `server/index.ts` nor re-exported
  by the catalog facade; wp2 names the direct import from `src/codex/catalog/metadata.ts`.
- `parseEffortRowId("x--fast")` returning null was independently confirmed:
  `isDeclaredReasoningEffort("fast")` is false (`src/reasoning-effort.ts:39`). The two
  grammars do not interfere, as claimed.
