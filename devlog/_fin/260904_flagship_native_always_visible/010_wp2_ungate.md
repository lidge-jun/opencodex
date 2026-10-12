# 010 — wp2: ungate the flagship trio

## Source changes

**`src/codex/catalog/native-models.ts`** — remove `gpt-5.6-sol`, `gpt-5.6-terra` and
`gpt-5.6-luna` from `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`, leaving `gpt-daybreak-blue-latest`.
Rewrite the doc comment: it currently says availability "is not static" and that Pool routing
requires the authenticated roster, which stops being true for the trio. Record the owner decision
the way the astra comment does, including the pool trade.

**`src/codex/model-entitlements.ts`** — no behavioural change, two comment corrections:

1. `ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS` keeps its three entries and gains a
   comment saying why they outlive gating: `hasUnknownGatedAbsence` iterates this map alone, and
   emptying it would make the TTL guard constant-false and reintroduce #3022 against Daybreak.
2. `MEASURED_GATED_CLIENT_VERSION_MINIMUM`'s stated exit condition can no longer occur, because
   no gated slug carries a snapshot row any more. The constant is load-bearing indefinitely.

**`src/codex/subagent-model-fallback.ts`** — `preserveDrainingMainCandidate` moves off the gated
set onto `SUPPORTED_NATIVE_OPENAI_SLUGS`. The drain sentinel exists so a routed fallback cannot
bypass the atomic main claim during a native-main drain; that reasoning never had anything to do
with entitlement, and leaving it on the gated set would let ungating silently swap the operator's
configured subagent model mid-drain.

No change in `src/server/responses/core.ts`: wire normalization reads its own map.

## Tests

The contract genuinely changed, so several assertions must move. The rule applied throughout:
**retarget onto Daybreak rather than delete**, so the fail-closed and floor coverage keeps
testing something real instead of quietly going hollow.

New, and RED before the change:

1. With the entitlement cache reset and no confirming roster, `nativeModelRows` lists all four
   flagship slugs, and `ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has("gpt-5.6-sol")` is false. This is
   the assertion that pins the decision so a future sync cannot silently re-gate.
2. `disabledModels` still hides an ungated flagship — the user's lever survives.
3. `codexAccountGatedCanonicalWireModel("gpt-5.6-sol")` is `undefined`, so the wire id is still
   the requested slug.
4. The composed floor is still `0.144.0` after the gated set shrinks, asserted through
   `composeGatedClientVersionFloorForTests` on the real snapshot with the new set. This is the
   regression that would catch a silent undo of #3442.
5. Daybreak is still filtered out without a roster, in the same test, so ungating is proven
   scoped rather than global.

Updated because the contract moved:

- `tests/codex-catalog-sync-hardening.test.ts` "Gap B" — the three `not.toContain` assertions
  flip to `toContain`; the Daybreak `not.toContain` stays so the case still proves fail-closed.
- `tests/codex-model-entitlements.test.ts` — `availableAccountGatedNativeModels` expectations
  now yield `[DAYBREAK]`. The floor and TTL suite retargets onto Daybreak.
- `tests/codex-auth-context.test.ts` — the pool fail-closed cases retarget onto Daybreak. They
  are the only coverage of that path and must not be deleted.
- `tests/native-model-toggle.test.ts` — add explicit "lists without any roster" assertions.
- `tests/codex-catalog.test.ts` — a comment claiming Sol is account-gated becomes false.
- `tests/codex-convergence-account-selectors.test.ts` — `expectCanonicalContent` now *requires*
  the trio in a rosterless fixture, inverting what that fixture was built to prove. Verify it
  passes for the right reason rather than by self-adjusting.
- `tests/subagent-roster-retention.test.ts` — touched by the gated set.

Plus a regression pinning the drain sentinel: during a native-main drain with no non-main
candidate, an ungated flagship model must still retain main as a read-free sentinel rather than
rewriting to the next model in the chain.

## Verification

Focused runs on every touched suite, then the full suite, with each failure compared against a
clean-`dev` baseline before it is called a regression.
