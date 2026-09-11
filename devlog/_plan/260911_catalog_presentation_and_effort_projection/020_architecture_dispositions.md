# Architecture consultation and main dispositions

Architect: `xai/grok-4.6` via the connected hub, read-only, dispatched 2026-09-11.
Two explorers ran alongside it on disjoint questions (test impact; presentation-field
flow). Verdict on the first draft of `000_plan.md`: **MISALIGNED**. Main accepts most
of it; the dispositions below are what actually governs B.

## Decisions

| ID | Proposal | Main disposition |
| --- | --- | --- |
| CLAMP-01 | Keep the clamp; a rung survives if it is in `supported` **or** it is `max`/`ultra`. Apply the same predicate to the default-repair block (`effort.ts:378`), which today would still rewrite `default_reasoning_level: "ultra"` even on a ladder that kept `ultra`. Do not post-patch with `ensureUltraReasoningLevel` — it is a construction helper, no-ops on empty ladders, and would make `removedEfforts` report rungs that were put back. | **Accepted.** This is the mechanism. The default-repair catch is a real defect the plan missed. |
| CLAMP-02 | Do **not** union `max`/`ultra` into `supportedCodexReasoningEffortsFromObservedCatalog` (`effort.ts:313`), and do not touch `catalogEffortCompatibility` (`effort.ts:409`, `src/client/catalog-compatibility.ts:47`). Emission and hub admission are different questions; hub download stays fail-closed per #4207. | **Accepted, and promoted to a scope boundary.** A hub client on a leftover 0.135 CLI must keep refusing rather than writing a catalog it cannot parse. |
| CLAMP-03 | One predicate change in `clampEntryToCodexSupportedEfforts` (`effort.ts:348`). No new module, no signature change at `sync.ts:1945` or `convergence.ts:382`, no consumer binding in `runtime.ts`, no `bundled.ts` discovery change. | **Accepted.** Strictly smaller than the plan's Phase 2. |
| CLAMP-04 | Keep `codex-runtime-clamp.json`. After CLAMP-01 a sync whose only removals were `max`/`ultra` persists `null` and unlinks. Until that sync, filter the two rungs out of "active clamp" in a single helper that **both** `effortClampAppliesToRuntime` and `doctor.ts` call — today `ocx doctor` (`doctor.ts:1180`) never calls the helper `ocx status` uses (`status.ts:249`), so the two can disagree about the same file. | **Accepted.** This explains the observed contradiction in `010_evidence.md` §1 and is a second, independent defect. Phase 1 stays: it is necessary for non-`max`/`ultra` rungs and insufficient alone, because a same-version leftover listing only those two would still warn. |
| CLAMP-05 | Keep reserve exactness. `{xhigh}` vs `{medium}` still deletes the row; `{low,high}` vs `{medium,high}` still yields `{high}`. Only the case where `max`/`ultra` are the sole survivors changes: the row is **kept** instead of spliced out (`effort.ts:466,472`). | **Accepted.** This closes the escalation the plan left open. Add the focused reserve test; do not weaken the existing xhigh-vs-medium omission test. |
| CLAMP-06 | Drop the per-consumer projection. One shared `$CODEX_HOME/opencodex-catalog.json`, no consumer key in the diagnostic, no second catalog. Desktop/CLI disagreement is resolved by always offering the two rungs. | **Accepted.** The "who owns the shared file" blocker in the first draft is obsolete. |

Residual risk accepted with CLAMP-06: a leftover pre-0.14x CLI reading the shared
file locally can fail to parse it. Hub clients still fail closed. Local `ocx sync`
does not, and that is the stated cost of the ruling.

## Correction to Phase 3 — the premise was wrong

The first draft assumed the four `delete` sites were why no card appears. The
explorer pass disproves it. **Pin-backed native rows already keep both fields end
to end** — `upstreamNativeEntry` deletes only `minimal_client_version`,
`finishUpstreamNativeEntry` (`sync.ts:257`) does not touch them, and
`ensureStrictCatalogFields` strips them only when `isRouted === true`
(`parsing.ts:609`). There is a test pinning exactly this:
`tests/codex-integration/codex-catalog.test.ts:7398` — "a native row keeps its own
eligibility metadata" — and `:3529` asserts Sol's `availability_nux` is defined.

So the carrier exists. Three native-looking kinds still lose the field, each for a
defensible reason: the Daybreak capability alias (`metadata.ts:567`), older natives
not in `UPSTREAM_NATIVE_ENTRIES` when OpenCodex has to synthesize the row
(`deriveEntry`), and Reserve.

**The actual gap is upstream of all four sites.** `src/codex/model-entitlements.ts`
does fetch `https://chatgpt.com/backend-api/codex/models`, but `parseAccountModels`
(`:536-546`) keeps nothing except the slug — every presentation field in that
response is discarded, and the set is used only as an allowlist for account-gated
natives (currently just Daybreak). Astra's row therefore comes from the pin or the
bundled catalog, both of which carry `availability_nux: null`.

That reframes the open question in `010_evidence.md` §4. It is no longer "does the
carrier exist" but "does the account roster carry copy the pin does not, and should
it override the pin". The probe still needs a live account token and is still a user
decision.
