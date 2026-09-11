# 003 — A-gate round 1: reviewer verdict and synthesis

Reviewer: independent read-only lane on `gpt-5.6-sol`, high reasoning effort, anchored at
`529639a57`. Verdict: **FAIL**, blockers 1, 2, 3.

Two of the three blockers were settled by running probes rather than by argument. Both
reviewer claims survived contact with the backend.

## Blocker 1 (High) — static and discovered resolution return different shapes

**Accepted, with a narrower fix than proposed.**

The reviewer is right that `discoveredAntigravityEffortWireModelId` returns before
`hasOwnEffortLadder` is consulted, so once a live ladder is registered the resolver returns
`{ wireModelId }` with **no** `thinkingLevel`, while static rule 2/3 returns
`{ wireModelId, thinkingLevel }`. Same model, two request bodies.

Probe (2026-09-03, CCA `:generateContent`) settles which is canonical:

| Case | HTTP | Result |
|---|---:|---|
| `gemini-3.8-flash-medium`, no `thinkingConfig` | 200 | `OK` |
| `gemini-3.8-flash-low` + `thinkingLevel: HIGH` | 200 | `OK` |

A suffixed wire id needs no `thinkingLevel`, and CCA silently accepts a **contradictory**
pairing rather than rejecting it — which is worse than an error, because the tier that
actually ran is unknowable from the response. So the suffix must be the sole carrier.

**Fix (amends `010`):** rule 2/3 omits `thinkingLevel` when the resolved wire id already
encodes the tier. Scope it with an explicit set rather than a regex over all models:

```ts
/**
 * Base models whose every effort maps to a wire id that ALREADY encodes the tier.
 *
 * For these, sending thinkingLevel alongside the suffix states the effort twice, and CCA
 * accepts a contradictory pair (probe: `-low` wire + HIGH level returns 200), so a mismatch
 * would run at an unknown tier instead of failing loudly. It also makes static resolution
 * byte-identical to the discovery path, which never emits thinkingLevel.
 *
 * gemini-3.1-pro is deliberately absent: its `high` rung is `gemini-pro-agent`, which carries
 * no tier suffix, so there the level is the only thing naming the effort.
 */
const ANTIGRAVITY_SUFFIX_TIER_MODELS = new Set(["gemini-3.8-flash"]);
```

and in rule 2/3:

```ts
if (effort && effort in effortMap) {
  const wireModelId = effortMap[effort]!;
  return ANTIGRAVITY_SUFFIX_TIER_MODELS.has(modelId)
    ? { wireModelId }
    : { wireModelId, thinkingLevel: effort };
}
```

`gemini-3.1-pro` behavior is unchanged — deliberately, since altering it is outside this unit.

Required test (activation scenario): `parse -> register -> resolve` and `resolve` without
discovery must return the SAME object for explicit `low`/`medium`/`high`, for unset effort, and
for clamped `max`/`xhigh`/`ultra`. That equality assertion is the regression guard; asserting
each path separately is what let the divergence exist.

The reviewer's sidecar note is covered by the same fix: `src/web-search/gemini-executor.ts:51`
destructures `thinkingLevel` and only sends `thinkingConfig` when present, so once both paths
omit it the sidecar body stops depending on whether discovery has run.

## Blocker 2 (High) — the Claude SDK identity paragraph guard is 3.7-only

**Accepted. Reproduced, and it is not theoretical.**

`src/adapters/google.ts:750` strips `ANTIGRAVITY_REJECTED_CLAUDE_SDK_PARAGRAPH` only when
`parsed.modelId === "gemini-3.7-flash"`. Probes with that exact paragraph in
`systemInstruction`:

| Case | HTTP | Result |
|---|---:|---|
| `gemini-3.8-flash-medium` + paragraph | 429 | `RESOURCE_EXHAUSTED` |
| `gemini-3.8-flash-high` + paragraph | 429 | `RESOURCE_EXHAUSTED` |
| `gemini-3.7-flash-tiered` + paragraph | 429 | `RESOURCE_EXHAUSTED` (control: known behavior) |
| `gemini-3.8-flash-medium`, paragraph stripped | 200 | `OK` |
| `gemini-3.8-flash-medium` + paragraph again | 429 | `RESOURCE_EXHAUSTED` |

The strip/restore pair rules out incidental quota exhaustion: the same account, seconds apart,
succeeds without the paragraph and fails with it. A policy rejection surfacing as a quota 429 is
exactly the failure mode the original 3.7 fix documented.

**This is the highest-value finding of the audit.** Shipping 3.8 as the default without it
would 429 every Claude-Agent-shaped request the moment the default moved, and the error text
would send users hunting a quota problem that does not exist.

**Fix (amends `010`):** widen the guard from an equality check to the set of CCA Flash models
that reject the paragraph:

```ts
const stripRejectedClaudeSdkParagraph = provider.googleMode === "cloud-code-assist"
  && ANTIGRAVITY_CLAUDE_SDK_PARAGRAPH_REJECTORS.has(parsed.modelId);
```

with the set holding `gemini-3.7-flash` and `gemini-3.8-flash`, and a comment recording that
membership is probe-established per generation, not assumed. A regression test beside
`tests/google-adapter.test.ts:250` asserts the paragraph is absent from the serialized
`systemInstruction` for both models, and still present for a non-CCA Google request.

## Blocker 3 (Medium) — stale exact assertions and thin focused-test commands

**Accepted in full.** These tests assert exact arrays and lengths, so they fail the moment the
catalogs grow:

| Test | Line | What breaks |
|---|---:|---|
| `tests/google-hardening.test.ts` | 777 | exact `google.models` array |
| `tests/google-models-listing.test.ts` | 360 | exact discovered-id array |
| `tests/provider-registry-parity.test.ts` | 771 | `toHaveLength(6)` on Antigravity models |
| `tests/oauth-provider-reconcile.test.ts` | 142 | `toHaveLength(6)` after reconcile |

`010`/`020`/`030` are amended to name these edits, and the focused commands now include
`google-hardening`, `google-models-listing`, `google-adapter`, and `usage-cost`.

## Blockers 4-9

| # | Severity | Disposition |
|---|---|---|
| 4 | Medium | Accepted — `020` gains a dedicated test asserting an explicit `gemini-3.7-flash` default SURVIVES reconciliation, separate from the stale-default healing case. |
| 5 | Medium | Accepted — `010` gains the missing consumers: discovery-map completion (L164-166), discovery suppression (L597-601), discovery default selection (L405-410), and the context-window spread/alias derivation (L272-277). |
| 6 | Medium | Accepted — the Gemini free-directory row gets a row-specific `lastVerified: "2026-09-03"`; the shared `LAST_VERIFIED` constant is untouched so unrelated providers keep their real dates. |
| 7 | Low | Accepted — see `004_no_change_inventory.md`. |
| 8 | Low | Accepted — `GEMINI_FLASH_WIRE_ID` is renamed `GEMINI_RETIRED_FLASH_TARGET_WIRE_ID` and the rule-0 comment is corrected to say retired ids route to 3.7, not to "the current generation". |
| 9 | Low | Accepted with a correction to the reviewer's framing. `ANTIGRAVITY_WIRE_MODELS` is indeed consumed nowhere, so the plan's step 2 is cosmetic. Rather than edit dead data or delete a constant unrelated to this unit, `010` drops the step and records the observation as a follow-up. Deleting it is a separate cleanup with its own blast radius. |

## Round outcome

Every blocker is folded into the plan as a concrete amendment; none was rebutted on judgment
alone, and the two High findings were confirmed against the live backend. Round 2 re-audits the
amended plan with the same reviewer.
