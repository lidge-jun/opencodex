# 015 — Audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Reviewer verdict: **FAIL**, 3 Critical + 5 High. Every blocker was re-derived locally before
being accepted or rebutted; nothing here is taken on the reviewer's word.

## Measurement that settles three blockers at once

```
bun .tmp/astra-probe.ts   # scratch, gitignored
{ "window": 272000, "maxInput": 272000,
  "tier": { "defaultWindow": 272000, "longWindow": 922000 },
  "isGpt56_astra": true, "solWindow": 272000, "solMaxInput": 272000 }
```

## Dispositions

### C1 — ACCEPTED. Accept criterion 2 was half vacuous and half impossible.

Measured: `nativeOpenAiContextWindow("gpt-6-astra")` is **already** 272,000 on current
`dev`, because `NATIVE_GPT56_CONTEXT_WINDOW` is itself 272,000
([metadata.ts](../../../src/codex/catalog/metadata.ts)). So 010's "set it to 272,000"
was a no-op dressed as a change, and its test would have passed without the patch.

Measured: `nativeOpenAiMaxInputTokens` returns 272,000, not 872,000, because
`nativeOpenAiMaxInputTokens` ends in `Math.min(narrowed, window)` — the input ceiling can
never exceed the advertised window. Asserting 872,000 was arithmetically unreachable.

**Amendment.** The real drift is `maxContextWindow` 922,000 → 872,000, which is the LONG
window (the 1M-opt-in ceiling), not the input ceiling. Restate:

- `nativeOpenAiContextTier("gpt-6-astra")` must become `{ defaultWindow: 272000,
  longWindow: 872000 }` (measured today: `longWindow: 922000`). This is the assertion that
  actually goes red without the patch.
- `nativeOpenAiMaxInputTokens("gpt-6-astra")` stays 272,000 under the default window; the
  872,000 only becomes reachable when the user opts into the long window. Do NOT change
  the `Math.min` clamp — over-advertising input above the window is the exact defect that
  clamp exists to prevent.

### C2 — ACCEPTED. The structural guard leaks three unrelated slugs.

`PINNED_UPSTREAM_MODELS` holds 8 rows; `slug === sourceSlug && PINNED_UPSTREAM_MODELS.has(slug)`
would newly admit `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` into `UPSTREAM_NATIVE_ENTRIES`,
which authorizes on-disk row replacement during sync — an invariant the code comment states
in so many words.

**Amendment.** Replace the predicate with an explicit allowlist of self-described slugs
containing exactly `NATIVE_GPT6_ASTRA_MODEL`, so the widening cannot reach any other row.

### C3 — ACCEPTED, and it is the most consequential find.

Measured: `isGpt56NativeSlug("gpt-6-astra")` is **true** today, purely because the
capability source is Sol. Removing the alias entry flips it false, and
[sync.ts](../../../src/codex/catalog/sync.ts) then takes the else branch of
`applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low","medium","high","xhigh"])`
— truncating Astra's ladder to xhigh and dropping the shipped `max` and `ultra` rungs.
That would have broken the exact thing this unit exists to fix, and no criterion tested it.

**Amendment.** Add `src/codex/catalog/effort.ts` to the file-change map. `isGpt56NativeSlug`
is misnamed for what it now gates: it means "native slug whose ladder is the full 5.6-era
ladder". Widen it to also return true for a self-described native carrying a max/ultra
ladder, or add Astra explicitly. Add a post-sync ladder assertion to the accept criteria.

### H1 — ACCEPTED. Add `provider-fetch.ts` and `parsing.ts` to the map, plus the existing
ChatGPT-forward Astra test at `tests/codex-catalog.test.ts` to the affected-test list.

### H2 — ACCEPTED. The pin test was a tautology: once Astra self-describes,
`upstreamNativeEntry` returns the very JSON the test reads. Re-anchor on the upstream
checkout — compare against `~/Developer/codex/121_openai-codex`'s `models.json` when
present, and skip with a recorded reason when it is not, so the oracle is independent.

### H3 — ACCEPTED as a documentation fix, MOOT as a diagnosis.
The stall watchdog in [bridge.ts](../../../src/bridge.ts) is indeed a better fourth
candidate than `outbound.ts`, which is a downstream translator. 021 supersedes this: the
cause is now positively identified (service restart), not merely narrowed by elimination.
020's candidate list is corrected for the record.

### H4 — PARTIALLY ACCEPTED, and 021 resolves it.
The reviewer is right that "0 rows for all time" makes the instrument suspect, and that
absence alone could not have carried a NOOP. That objection is why 021 does not rest on
absence: it rests on a POSITIVE signal — a five-hour recording gap that ends exactly at the
proxy's process start time, with `service.log` shutdown/start pairs in the window. The
verdict is NOOP because the cause is known, not because the table was empty.

### H5 — ACCEPTED. The merge gate was below policy.
AGENTS.md requires `bun run typecheck` AND `bun run test` before a non-trivial PR is
review-ready, and this change now reaches `sync.ts`, `effort.ts`, `parsing.ts`,
`provider-fetch.ts`. 030 must name the gate explicitly: run `bun run test:changed` plus the
named focused files locally, and require exact-head hosted CI green before
`gh pr merge --admin`.

### M1-M6, L1-L2 — ACCEPTED as corrections

M1 three emitters not two. M2 `030_outcome.md` collides with `030_wp4_merge.md`; the
outcome lives in `021_wp3_evidence.md`, already written. M3 the `visibility: list`
divergence from upstream's `hide` is argued nowhere — it must be argued in 010 (opencodex
deliberately lists what upstream hides, because the proxy's users select models by hand).
M4 the history verifier must use epoch-ms `timestamp`, not `created_at`. M5
`minimal_client_version` is deleted by `upstreamNativeEntry`, so the plan's mechanism
cannot fix that drift — drop it from the drift table as out of reach. M6 record the
`nativeOpenAiContextTier` / auto-compact / provider-cap effects. L1 the 922,000 in the
on-disk catalog is the materialized long window, not `context_window` drift. L2 wp1 is the
docs cycle itself.

## Net effect on scope

The unit grows by two files (`effort.ts`, and the map now names `parsing.ts` /
`provider-fetch.ts` as verified-unaffected or amended), and the headline claim changes:
the meaningful catalog drift is **presentation + long-window ceiling + ladder preservation**,
not the default context window, which was already correct.
