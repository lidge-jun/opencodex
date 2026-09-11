# Unconditional `max`/`ultra`, and the stale clamp that hides them

## Reader summary

Two catalog defects share one shape: OpenCodex decides what the Codex client may
render, and in both cases it decides "nothing" for the wrong reason. First, a
persisted effort-clamp diagnostic keeps `max` and `ultra` hidden after the Codex
binary is upgraded in place, because the diagnostic is matched to the current
runtime by **path alone** — the recorded version is never compared when the path
is unchanged, which is the normal Windows auto-update case. Second, the two
presentation fields the Codex client renders as cards (`availability_nux`,
`upgrade`) survive end to end on pin-backed native rows but are discarded where
the account roster is parsed (`model-entitlements.ts` keeps only the slug), so a
card whose copy lives only on the account endpoint can never appear through the
proxy. (An earlier draft of this paragraph said "deleted at four sites and
carried at none"; the explorer pass disproved it — see
`020_architecture_dispositions.md`.) This unit makes the clamp
diagnostic version-aware, exempts `max` and `ultra` from the observed-runtime
intersection entirely, and — pending a probe — lets the account roster contribute
the presentation copy it currently discards. The per-consumer ladder projection in
the first draft was withdrawn by maintainer ruling; the delete-site registry was
withdrawn because the explorer pass showed native rows already keep the fields.

Evidence: `010_evidence.md`. Upstream issues: #4204 (efforts), #4213 (cards).

## Loop spec

| Field | Content |
| --- | --- |
| Loop archetype | Satisfy-spec. Both defects have a decidable correct behaviour; this is not an open-ended optimization. |
| Trigger | User request: make `max`/`ultra` reachable regardless of the CLI version recorded on disk, and make the card fields usable as boilerplate for other presentation surfaces. |
| Goal | A Codex client that supports an effort sees it offered; a presentation field that upstream populates survives to the client; adding the next such field is a registry entry, not a new code path. |
| Non-goals | Proxying `wham/workspace-messages`. Changing image generation. Authoring card copy that upstream does not ship. Pushing to any remote. Clamping rungs other than `max`/`ultra` — the rest of the ladder keeps its current observed-runtime behaviour. |
| Verifier | `bun test tests/codex-integration/codex-runtime.test.ts tests/codex-integration/catalog-go-exact-efforts.test.ts` — RUN, exit 0, 42 pass, and it reads `src/codex/runtime.ts` (`codex-runtime.test.ts:37` imports it; `:612` calls `effortClampAppliesToRuntime`). **That pair is sufficient for Phase 1 and NOT sufficient for Phase 2** — `catalog-go-exact-efforts.test.ts` pins construction, never the clamp. The gate that observes Phase 2 is `bun test tests/codex-integration/codex-catalog.test.ts tests/codex-integration/reserve-catalog.test.ts tests/clients/client-catalog-compatibility.test.ts` (see `030_test_impact.md` for the exact test names that must invert). NOT RUN at plan time — inverting them is B's work, so a pass today would prove nothing. Phase 3 has no gate until its test exists; that acceptance row is human review. |
| Stop condition | ~~Plan-only~~ Superseded 2026-09-11 (second session): the user authorised the full PABCD cycle. This cycle ends at D with Phases 1, 2 and 4 built and verified. Phase 3 stays withdrawn (GAP-2). |
| Memory artifact | This unit directory: `devlog/_plan/260911_catalog_presentation_and_effort_projection/`. |
| Expected terminal outcomes | Success: Phases 1, 2 and 4 land on `codex/260911-clamp-expiry` with their gates green. Resolved: GAP-1 (CLAMP-04 ships — see `050_revalidation.md`). Unresolved: GAP-2/GAP-3 in `040_open_gaps.md` are not closed by this cycle. Blocked: Phase 3 stays blocked on a live account-roster probe that only the user can authorise. |
| Escalation condition | The account-roster probe needs a real ChatGPT token; main does not take it. CLAMP-04 changes the meaning of an active clamp and inverts diagnostic tests the plan currently promises to keep green — that contradiction goes to the user, not to B. Reserve deletion is no longer an escalation: CLAMP-05 decided it. |

## Phase map

Ordered by build dependency. Each phase closes with something independently
verifiable.

### Phase 1 — Foundation: the clamp diagnostic must expire

`effortClampAppliesToRuntime` (`src/codex/runtime.ts:431`) returns `true` as soon as
the recorded path equals the resolved runtime path, before it ever looks at the
version. An in-place upgrade therefore keeps a clamp alive forever. This machine
is in exactly that state: the diagnostic records `0.135.0` for a path that now
reports `0.154.0`, and that binary's own bundled catalog contains `max` and
`ultra`.

Change: when the diagnostic and the runtime both carry a version and those
versions differ, the diagnostic does not apply — regardless of path equality. A
missing version on either side stays conservative and keeps the current
path-match behaviour, because an unknown version is not evidence of an upgrade.

This narrows nothing and weakens no clamp: it invalidates an observation that is
provably about a different binary. It is also the phase the other two depend on,
because a stale diagnostic would mask whatever Phase 2 computes.

Accept criteria:

- Given a diagnostic at version A and a runtime at the same path at version B (A ≠ B), `effortClampAppliesToRuntime` returns `false`.
- Given the same path and the same version, it still returns `true`.
- Given a diagnostic with a null version, current behaviour is unchanged.
- Activation scenario for the guard: construct the two-version case in the test and assert `ocx status` composes without the clamp warning — the observable effect is the absent `Catalog clamp removed` line at `src/cli/status.ts:277`.

Files: `src/codex/runtime.ts` (`effortClampAppliesToRuntime`), `tests/codex-integration/codex-runtime.test.ts` (extend near line 612).

### Phase 2 — Core: `max` and `ultra` stop being clampable

**Maintainer ruling, 2026-09-11.** Emit `max` and `ultra` unconditionally. The
consumer-projection design in the first draft of this plan is withdrawn, and the
#4204 review constraint it was written against is superseded by the person who
wrote it. Rationale on the record: enough time has passed that the CLI versions
which genuinely lack the two rungs are effectively unsupported, so a clamp that
exists to protect them costs more than it buys.

What the clamp does today: the ladder comes from `codex debug models --bundled`
of the resolved runtime (`src/codex/catalog/effort.ts:331` →
`src/codex/catalog/bundled.ts:239`), alternative-runtime discovery is off for that
call (`bundled.ts:261` defaults `discoverAlternatives` to `false`;
`runtime.ts:603` breaks out of the candidate loop when it is `false`), so the
persisted binary decides the ladder for the whole machine.

Mechanism, per CLAMP-01/03 in `020_architecture_dispositions.md` and the A-audit
correction (reviewer blocker 1, folded): the single predicate site is the
keep-filter inside `clampEntryToCodexSupportedEfforts` — `effort.ts:357`, where
`kept` is built with `supported.has(...)`. A rung survives when it is in
`supported` **or** it is `max`/`ultra`. The same predicate gates BOTH default-repair
blocks — the Reserve branch's own repair at `effort.ts:363-367` (which returns
before the shared block) and the shared block at `effort.ts:378`. One predicate,
three places. No new module, no signature change at `sync.ts:1945` or
`convergence.ts:382`, no `bundled.ts` discovery change, no consumer binding.

Explicitly rejected: re-adding the rungs after the clamp via
`ensureUltraReasoningLevel` (`effort.ts:300`). It no-ops on an empty ladder, and it
would leave `removedEfforts` naming rungs that were put back — a diagnostic that
lies. Also rejected: a floor allowlist, which would strip `none`/`minimal` that
current CLIs do parse.

**Emission and admission stay separate (CLAMP-02).**
`supportedCodexReasoningEffortsFromObservedCatalog` (`effort.ts:313`) keeps
reporting what it observes, and `catalogEffortCompatibility` (`effort.ts:409`,
`src/client/catalog-compatibility.ts:47`) keeps refusing a hub catalog an old
runtime cannot parse. Making observation lie would reintroduce #4207: a hub client
on a leftover 0.135 CLI would write the file and then crash reading it.

**Reserve (CLAMP-05).** `requiresExactReserveEfforts` (`effort.ts:344`) deletes a
row whose ladder empties (the `omitted`/`splice` at `effort.ts:466,472` are pure
effects of the emptied ladder — they get NO special case). The keep falls out of
the `:357` filter: when `max`/`ultra` are the sole survivors `kept` is non-empty,
so the row is kept with exactly those rungs. `{xhigh}` vs `{medium}` still
deletes; `{low,high}` vs `{medium,high}` still yields `{high}`.

Phase 1 is not made redundant by this: the diagnostic still exists for other rungs,
and a same-version leftover listing only `max`/`ultra` would keep warning without
the CLAMP-04 filter.

**Landing constraint (A-audit blocker 2, folded).** Phases 1 and 4 must not land
without Phase 2 in the same diff: `liveRemovedEfforts` already hides rungs that
`clampEntryToCodexSupportedEfforts` still removes, so landing 1+4 alone makes
`ocx status`/`ocx doctor` report "no clamp" while the next sync still strips the
rungs. One branch, one landing.

Accept criteria:

- With a fixture runtime whose bundled catalog stops at `xhigh`, a native row ends the sync carrying `max` and `ultra`.
- A genuinely absent rung that is NOT `max`/`ultra` is still removed — asserted explicitly, so this is provably an exemption and not a disabled clamp.
- `default_reasoning_level: "ultra"` is no longer rewritten to `xhigh` when the ladder kept `ultra` (`effort.ts:378`).
- `catalogEffortCompatibility` still reports `unsupportedEfforts: ["max"]` against an old-CLI ladder — the #4207 gate is unchanged.
- Activation scenario for the reserve branch: a reserve fixture whose source ladder is `max`/`ultra`-only against an observed `{medium}`; the observable effect is that the row appears in the written catalog instead of being spliced out, while the existing `{xhigh}` vs `{medium}` fixture still produces an omitted row.

Files: `src/codex/catalog/effort.ts` (only). Unchanged by design: `sync.ts:1945`, `convergence.ts:382`, `bundled.ts`, `src/client/catalog-compatibility.ts`.

### Phase 3 — Integration: keep the account roster's presentation fields

**The first draft had this backwards.** The four `delete` sites are not why no card
appears — a pin-backed native row already carries both fields end to end, and
`tests/codex-integration/codex-catalog.test.ts:7398` pins exactly that. The carrier
exists. Full derivation in `020_architecture_dispositions.md`.

The real loss is upstream. `src/codex/model-entitlements.ts` fetches
`https://chatgpt.com/backend-api/codex/models`, and `parseAccountModels` (`:536-546`)
keeps **only the slug** — `supported_in_api` and `visibility` are read as filters and
every other field, presentation included, is dropped on the floor. The set is then
used as an allowlist for account-gated natives (currently just Daybreak). So Astra's
row is always the pin or the bundled catalog, and both carry
`availability_nux: null`.

Change: let the account roster contribute presentation fields for a native slug it
already authorises, through one small descriptor that names which fields may cross
that boundary and in which direction the account roster wins over the pin. That
descriptor is the reusable piece the user asked for — the next presentation field
becomes an entry rather than a new merge path.

**Blocked on evidence, by design.** Whether the account roster carries copy the pin
lacks is unverified and needs a live ChatGPT token. If it does not, Phase 3 is
withdrawn rather than built — there would be nothing to carry, and a descriptor
with no producer is the ghost state `PLAN-FIELD-CHAIN-01` exists to prevent.

PLAN-FIELD-CHAIN-01 for the descriptor:

| Stage | Path |
| --- | --- |
| Creation | account roster response parsed at `src/codex/model-entitlements.ts:536`; today the only producer, and it currently produces nothing |
| Serialization | none — both fields already exist in the catalog JSON written by `sync.ts`; no new wire shape |
| Deserialization | `src/codex/catalog/parsing.ts` entry normalization; `ensureStrictCatalogFields` already routes by `isRouted` |
| Consumers | the merge in `sync.ts` (`finishUpstreamNativeEntry`, `:257`), plus the four existing sanitizers which stay as they are — `metadata.ts:567` (Daybreak capability alias), `sync.ts:354` (template clone), `parsing.ts:613` (routed), `reserve.ts:36` (Reserve). **N/A by design:** none of them gains a registry lookup, because each is already correct. |

Accept criteria:

- A native slug whose account-roster row carries `availability_nux` ends the sync carrying it, overriding a `null` pin.
- A routed row, the Daybreak capability alias, and a Reserve projection still lose the field — asserted per row kind, not once, so the fix is proved not to have widened.
- `parseAccountModels`' existing filtering (`supported_in_api !== true`, `visibility === "hide"`) is unchanged; a hidden row contributes no copy.
- Activation scenario: a fixture roster carrying copy for one native slug and nothing for another; the observable effect is one row with a message and one still `null` in the written catalog.

Files: `src/codex/model-entitlements.ts`, `src/codex/catalog/sync.ts`, new test under `tests/codex-integration/` (needs an entry in both `scripts/test-layout/layout.json` `explicit` and `tests/fixtures/test-layout-expected.json`, or a name matching the `codex-integration` regex seed).

### Phase 4 — Hardening: say what happened

`ocx doctor` currently suggests "set CODEX_CLI_PATH to a newer Codex binary" while
the selected binary is already newer — the advice is generated from the stale
diagnostic. Once Phase 1 lands, the message must distinguish "this runtime really
lacks the rung" from "a previous runtime lacked it". `doctor.ts:1180` does not call
`effortClampAppliesToRuntime` at all — it warns on any non-empty `removedEfforts` —
so status and doctor can disagree about the same file. Accept criterion: given one
leftover diagnostic, `ocx status` and `ocx doctor` reach the same verdict. Docs-site
follows only if Phase 2 changes user-visible behaviour, which it does: `max` and
`ultra` now appear on runtimes that previously hid them.

Files: `src/cli/doctor.ts:1181`, `src/cli/status.ts:250`, `src/server/management/config-routes.ts:283`, `docs-site/`.

## Scope boundary

IN: `src/codex/catalog/effort.ts` (Phase 2), `src/codex/runtime.ts` (Phases 1 and 4), `src/cli/{status,doctor}.ts` and `src/server/management/config-routes.ts` (Phase 4), and — only if the Phase 3 probe succeeds — `src/codex/model-entitlements.ts` and `src/codex/catalog/sync.ts`. Matching tests, docs-site.

OUT, and explicitly unchanged by design: `src/codex/catalog/{bundled,parsing,metadata,reserve}.ts`, `src/client/catalog-compatibility.ts` and `catalogEffortCompatibility` (CLAMP-02), `supportedCodexReasoningEffortsFromObservedCatalog`, `nativeEffortClamp` and the wire-clamp layer, `src/server/index.ts` route allowlist, `src/server/images.ts`, `src/lab/`, the `wham` client surface, and hand-authored `upstream-models.json` copy. There is no new presentation-field module; that idea was withdrawn.

## PLAN-BYPASS-NAMED-01

The thing being enforced is the CLAMP-02 boundary: emission may exempt the two
rungs, hub admission may not.

- Tier: E2 — repository tests.
- Executing surface: `tests/clients/client-catalog-compatibility.test.ts` plus `bun run test` in CI.
- Known bypass path: a contributor who adds the exemption to `supportedCodexReasoningEffortsFromObservedCatalog` instead of to `clampEntryToCodexSupportedEfforts` gets the same visible outcome locally and silently reopens #4207. The compatibility tests would catch that specific move; a new code path that recomputes the supported set elsewhere would not be caught at all.
- Residual risk: a local `ocx sync` on a leftover pre-0.14x CLI can now write a catalog that CLI cannot parse. Accepted by the ruling; hub clients still fail closed.
- Wording: **early warning**, not enforcement. Final layer: none.

## Consultation record

Architect consultation completed on `xai/grok-4.6` through the connected hub:
proposal (CLAMP-01..06) in `020_architecture_dispositions.md`, main dispositions in
the same file, reflection check returned **MISALIGNED** with five findings.
Findings 1 and 4 — the document contradicting its own loop-spec and scope — are
resolved in this revision. Findings 2, 3 and 5 are recorded unresolved in
`040_open_gaps.md`. Two explorers ran alongside on disjoint questions; their output
is `030_test_impact.md` and the Phase 3 correction in `020`.

This plan has **not** passed an independent A audit. The reflection is the
architect checking its own proposal against main's rewrite; it does not substitute
for A.
