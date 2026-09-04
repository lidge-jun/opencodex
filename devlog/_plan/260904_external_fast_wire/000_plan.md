# 000 — external_fast_wire: Plan & Research

## The asymmetry

Codex Fast is the `priority` service tier. It is published **only** as Codex-catalog
metadata: `applyCatalogModelMetadata` stamps `service_tiers: [{id:"priority", name:"Fast"}]`
and `additional_speed_tiers: ["fast"]` when `model.supportsServiceTier === true`
(`src/codex/catalog/effort.ts:160-168`). The Codex desktop picker renders those fields and
turns them into a toggle. Nothing else does.

Every other ingress selects a model by **id string alone**:

| Surface | Selector | Fast reachable today |
|---|---|---|
| Codex app | catalog row + `service_tiers` toggle | yes |
| `GET /v1/models` -> chat/responses | id string | no |
| Claude Code discovery -> `/v1/messages` | id string | no |
| Cursor | id string | yes — because Cursor's Fast is a model VARIANT |

Cursor is the existence proof. Its Fast is a dimension of the picked model
(`fastWire: {kind:"cursor-variant", canonicalToWire:{priority:"fast"}}`,
`src/providers/registry.ts:1154`), so a `-fast` id carries the intent and any client can
pick it. `cursorFastIdFor()` already rewrites listed Cursor ids when `config.fastMode`
is on (`src/server/index.ts:1554`, `src/claude/model-info.ts:159`).

The gap this unit closes: **that rewrite is Cursor-only, and it is a global replacement
rather than a selectable row.** A native `gpt-5.6-sol` — which really does advertise
`additional_speed_tiers: ["fast"]` upstream (`src/codex/data/upstream-models.json`) — has
no external Fast selector at all, and `fastMode` forces every request instead of letting a
client choose per request.

## What we build

An opt-in synthetic row `<base-id>--fast`, published on the two client-facing discovery
surfaces — the raw OpenAI-style `/v1/models` list and Claude Code discovery — for exactly
the models whose resolved FastPolicy reports `eligible`, and parsed back on all five
request ingresses (`/v1/responses`, `/v1/responses/compact`, `/v1/chat/completions`,
`/v1/messages`, `/v1/messages/count_tokens`) to the base model with canonical `priority`
applied through the existing FastWire path.

Deliberately NOT published: the dashboard `/api/models` `namespaced` ids. Those are
`disabledModels` keys and the identities `ocx export` and the OpenCode integration write
into user config files, so a synthetic id landing there would outlive the flag that
produced it. Those clients keep emitting base ids; wp4 documents the limitation.

## The separator decision (load-bearing)

**`--fast`, not `-fast`.** A single hyphen is unsafe: terminal `-fast` is already a real
model id across this catalog, not a free suffix.

| Source | Real ids ending in `-fast` |
|---|---|
| `src/generated/model-metadata.ts` | `grok-3-fast`, `grok-4-fast`, `grok-4-1-fast`, `grok-composer-2.5-fast`, `x-ai/grok-4.1-fast`, `anthropic/claude-opus-{4.6,4.7,4.8,5}-fast` |
| `src/providers/registry.ts:1677` | `glm-5.3-fast`, `glm-5.3-short-fast`, `glm-5.2-fast`, `glm-5.2-short-fast`, `kimi-k2.6-fast`, `qwen3.5-397b-fast`, `qwen3.6-35b-fast` |
| `src/providers/registry.ts:2961` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `src/adapters/cursor/discovery.ts:286` | `gpt-5-fast`, `composer-2.5-fast` — explicitly documented as real rows that *look* like a dimension |
| `src/adapters/cursor/catalog.ts:491,573` | `<base>-fast`, `<base>-<effort>-fast`, `<base>-thinking-<effort>-fast` |

With a single hyphen, `glm-5.3-fast` is ambiguous: a real model, or the synthetic Fast row
of `glm-5.3`? A known-id guard settles that one case for the real model — which means the
synthetic row for `glm-5.3` becomes unpublishable, and any real `X-fast` missing from the
request-local inventory gets mis-parsed into base `X` plus priority. That is a wrong model
on the wire, not a degraded one.

`--fast` inherits the guarantee the effort-row grammar already relies on: `--` is a
terminal separator absent from real model namespaces (`src/server/effort-row.ts:17`). The
two grammars compose without ambiguity because `parseEffortRowId` requires
`isDeclaredReasoningEffort(effort)` (`effort-row.ts:90`) and `fast` is not a declared
effort, so `x--fast` falls through the effort parser untouched. wp1 asserts that
non-interference rather than assuming it.

## Eligibility: publish on `eligible` only

`resolveFastPolicy` (`src/providers/fastwire.ts:190`) returns five states. Exactly one may
publish a row.

| eligibility | meaning | publish `--fast`? |
|---|---|---|
| `eligible` | capability true AND the final adapter implements the wire | **yes** |
| `capability-unsupported` | capability explicitly false | no |
| `unclassified` | capability `undefined` — absence of evidence, not evidence of support | no |
| `wire-unavailable` | no wire on the final adapter (incl. `fastWire: null`) | no |
| `pin-unavailable` | a hard pin forced an adapter without the wire | no |

`unclassified` is the subtle one: `decideTier` deliberately makes `fastMode` inert there
(`fastwire.ts:320,407`), so publishing a row we cannot honour would advertise a capability
the runtime then refuses to exercise. The listing therefore reuses the same
`fastPolicyForModel(provider, modelId, providerName)` the catalog already calls
(`src/codex/catalog/provider-fetch.ts:754`): pure, synchronous, no network, no `src/lab`
import, safe on the `/v1/models` hot path.

## Phase map

One decade doc per implementation cycle; each is one full PABCD work-phase.

| Doc | Work-phase | Deliverable |
|---|---|---|
| `010` | wp1 | `src/server/fast-row.ts`: id codec, collision rules, eligibility read, `fastRows` flag |
| `020` | wp2 | listing publication: `/v1/models` + both Claude discovery loops |
| `030` | wp3 | ingress round-trip: responses, chat-completions, messages, count_tokens, compact |
| `040` | wp4 | docs-site reference, close-out, stacked-PR landing |

Amended after audit round 1; see `005_audit_round1.md` for the eight blockers and their
disposition. The audit changed the Claude parse ordering, made native eligibility
policy-derived, added two ingresses, and dropped the Cursor status field.

Stacked PRs: wp2 targets wp1's head, wp3 targets wp2's, wp4 targets wp3's
(`DEV-STACK-01`). Each retargets to `dev` once its parent lands.

## Out of scope

FastWire tier-decision semantics and downgrade safety; Cursor's own `-fast` variant
grammar and the `fastMode` global rewrite (both stay exactly as they are); `src/lab/**`;
pricing and usage-cost; Desktop 3P hashed aliases.

## Residual carried in from 260902_cursor_unified_identity

R1 there notes that a listed fast id advertises the BASE effort ladder. The same question
applies here and gets a different answer: a `--fast` row is the same model at a different
service tier, not a sibling product with its own ladder, so the base ladder is correct.
