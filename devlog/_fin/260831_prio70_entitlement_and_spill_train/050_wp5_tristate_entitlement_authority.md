# 050 — wp5: tri-state entitlement authority

Split out of wp1 by audit round 2 (`005`, blocker 1). Lowest priority in the train:
it hardens against a future upstream change rather than fixing a reported symptom.

## What it is for

#3022 happened because a roster fetched under a too-low `client_version` came back
without the gated rows, and their absence was recorded as a decided denial. wp1
Change 1 fixes the *current* instance by asking under `0.144.0`.

It does not make the system robust to the next bump. When upstream raises the
gated minimum to `0.148.0`, the same shape recurs: a version that was correct
yesterday silently produces confirmed negatives. wp5 removes the class.

## Why it could not ride along in wp1

Two structural facts, verified in round 2:

1. **The answering version is discarded.** `CachedAccountModels` records
   `clientVersion` (`src/codex/model-entitlements.ts:230`), but
   `resolveCodexModelEntitlements` drops it when building
   `CodexModelEntitlementSnapshot` (`:236`, `:547-550`). The projections cannot see
   it.
2. **The projections are positive-only.** `entitledCodexAccountIdsForModel` and
   `availableAccountGatedNativeModels` answer "which are granted" (`:570`, `:573`).
   A third boolean term either narrows redundantly or widens into granting a model
   upstream never gave. "Unknown" has no slot.

So the change is: a new snapshot field, an explicit per-model minimum source, and
three exported projections that admit only `granted` while carrying `unknown`
separately. Every caller of those three is in scope. That is a subsystem, and
smuggling it into a symptom fix is how a fail-closed gate gets accidentally opened.

## Shape

1. **Carry the answering version into the snapshot** — a `clientVersionByAccount`
   map beside `modelsByAccount`, so a projection can ask "under what question was
   this answered?".
2. **An explicit per-model minimum source.** Not the stale snapshot: sol/terra/luna
   have a measured `0.144.0`, and `gpt-daybreak-blue-latest` has **no row at all**
   (`src/codex/data/upstream-models.json`), so it has no minimum and must keep
   omission-as-denial rather than being handed a guess.
3. **Tri-state at the boundary.** `granted` / `denied` / `unknown`. Projections keep
   returning only `granted` — that is what preserves fail-closed. `unknown` exists
   so it can be *reported* (wp4) and so it takes the 15s failure TTL instead of the
   5-minute success TTL, making recovery prompt.
4. **Positive evidence is never version-tested.** A returned row is a grant no
   matter which version asked. Only absence needs a trustworthy question.

## Regressions

- A gated slug omitted from a roster fetched **below** its minimum is `unknown`:
  not exposed, and not cached as a 5-minute denial.
- The same slug omitted from a roster fetched **at or above** its minimum is
  `denied`: the question was capable, so absence is real evidence.
- A gated slug **present** in a roster fetched below the minimum is `granted`.
  Guards requirement 4.
- `gpt-daybreak-blue-latest` keeps omission-as-denial at every version. Guards
  against the predicate silently un-gating a model with no known minimum.
- No projection ever returns a slug that was not in a roster. The fail-closed
  invariant, asserted directly rather than assumed.

Use a gated slug for every one of these. Round 2 caught the earlier draft asserting
on `gpt-5.5`, which is **not** in `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`
(`src/codex/catalog/native-models.ts:5-10`, ungated list at `:70`) and therefore
never at risk — a vacuous test.

## Dependency

After wp1 (shares `model-entitlements.ts`) and ideally after wp4, whose diagnostic
is the natural consumer of `unknown`.
