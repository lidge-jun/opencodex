# 010 — wp1: entitlement floor + empty-vs-negative roster (#3022)

Stack base. Consumes `001`. One PABCD cycle.

Branch: `codex/3022-entitlement-floor-empty-roster` off `origin/dev`.

## Change 1 — tier 3 stops trusting the snapshot alone

`src/codex/model-entitlements.ts`

Add an independently measured minimum next to the derivation, and take the higher
of the two. The snapshot may raise the floor; it may never lower it below what we
have measured upstream to honour.

```ts
/**
 * Lowest client_version measured to actually return the gated rows.
 *
 * devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md and the
 * #2886/#3022 reporter captures agree: 0.142.2 returns 200 with five rows and no
 * gpt-5.6; 0.144.0 and above return the gated rows. The bundled snapshot records
 * 0.142.2, so a derivation that trusts it asks a question upstream answers with
 * an empty gated set.
 */
const MEASURED_GATED_CLIENT_VERSION_MINIMUM = "0.144.0";
```

and the exported floor becomes the max of `deriveGatedClientVersionFloor(...)`,
the measured minimum, and the existing fallback only when derivation yields
nothing. `compareClientVersions` (`:88`) already does the ordering.

Keep `deriveGatedClientVersionFloor` exported and unchanged in behaviour — it is
separately tested and its job (read the snapshot faithfully) is still correct. The
correction belongs at the composition site, so a future snapshot refresh that
records `0.144.0` or higher takes over naturally and the constant becomes inert
rather than conflicting.

Tiers 1 and 2 are untouched. An inbound or runtime version still wins, because
those describe a real client and this constant does not.

## Change 2 — separate "usable answer" from "authoritative about this model"

> Amended after audit round 1 (`004`, blocker 1). The first draft used one
> account-wide `usable` flag, which would have discarded affirmative rows too.

Same file, `fetchAccountModels` (`:414`).

Today:

```ts
expiresAt: now + (models ? MODEL_ROSTER_TTL_MS : MODEL_ROSTER_FAILURE_TTL_MS),
models: models ?? new Set(),
confirmed: models !== null,
```

An empty `Set` is truthy, so `{"models":[]}` earns `confirmed: true` and the
five-minute success TTL.

`confirmed` is a single bit for the whole account (`:223-234`) and every
projection drops the account entirely when it is false (`:547-550`, `:573-593`,
`:527`). So it cannot carry a per-model judgement, and overloading it would hide
`gpt-5.5`/`gpt-5.4` — models a `0.142.2` roster legitimately confirms.

Two distinct changes:

**2a. Account-scoped: an empty parsed roster is not a confirmation.**
`{"models":[]}`, and an all-filtered roster, mean no usable evidence. Set
`confirmed: false` and take `MODEL_ROSTER_FAILURE_TTL_MS` (15s) rather than
locking in a wrong answer for five minutes. A non-empty roster stays confirmed.

**2b — deferred to wp5.** See `005` (audit round 2, blocker 1). The draft wanted
model-scoped absence authority: "absence of gated model *M* is denial only when the
answering version could have returned *M*". It is not implementable inside this
cycle, for two verified reasons.

First, the answering version is not visible where the decision happens.
`CachedAccountModels` records `clientVersion` (`:230`), but
`resolveCodexModelEntitlements` discards it when building the snapshot (`:236`,
`:547-550`).

Second, the projections are **positive-only**: they compute which accounts/models
are *granted* (`:570`, `:573`). A third boolean term in a positive-only filter can
only narrow it (redundant — absence already yields nothing) or widen it to include
a model upstream never granted. There is no third slot for "unknown" to occupy, so
expressing it means changing the snapshot contract and all three exported
projections. That is a subsystem change, not a line.

Change 1 already fixes the reported defect by asking under `0.144.0`. 2b was only
ever a safety net against a *future* upstream bump, so it goes to `050` where it
can be designed with a real tri-state contract.

## Change 3 (bounded) — correct the stale snapshot metadata

`src/codex/data/upstream-models.json`: the three gated rows record
`minimal_client_version: 0.142.2` and `context_window: 372000`, both contradicted
by the in-repo live measurement (`0.144.0`, `272000`).

Treat this as **optional for this cycle and out of scope if it moves anything
else.** The file is a pinned catalog snapshot consumed as exact model metadata; the
context-window value has its own pinned-entry tests
(`tests/codex-catalog.test.ts:2901-2909`).

Correction from audit round 1: `372000` does **not** feed
`NATIVE_GPT56_CONTEXT_WINDOW`. That constant is independently `272_000` and
overrides the snapshot for runtime projections
(`src/codex/catalog/metadata.ts:130`, `:155-157`). So the stale value is a
documentation wart with no behavioural reach, which is *why* leaving it is safe.

Decision for this cycle: **do not edit the JSON.** Change 1 makes the stale value
harmless, and the max-composition means correcting it later is safe. Record the
staleness as a follow-up so it is not lost.

## Regressions (each driven red first)

`tests/codex-model-entitlements.test.ts`

1. Effective floor is `0.144.0`. Red now: returns `0.142.2`.
2. No inbound and no runtime version, upstream mock returning gated rows only at
   `>= 0.144.0` -> the request uses `0.144.0` and sol/terra/luna are available.
   **The existing test at `:226` mocks the gate at `142`, which is why the suite
   never caught this — that mock must be corrected to match measured upstream.**
3. `{"models":[]}` -> account not confirmed, failure TTL. Red now: confirmed with
   the 5-minute TTL (auditor probe: no refetch at 15,001 ms, refetch only after
   300,001 ms).
4. A non-empty roster stays confirmed. Guards 2a against over-reach: only the
   *empty* case changes, so an ordinary short roster must still confirm the account
   and expose whatever it does grant.

   (Tests 4/4b/4c from the round-1 draft are withdrawn with 2b. Round 2 also caught
   that the draft's `gpt-5.5` assertion was vacuous: `gpt-5.5` is **not** in
   `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` — that set is exactly sol/terra/luna plus
   Daybreak (`src/codex/catalog/native-models.ts:5-10`), and `gpt-5.5` sits in the
   ungated native list at `:70`. It was never at risk from `confirmed`, so
   asserting its survival proved nothing.)
5. The existing "all rows filtered as hidden/api-disabled" case at `:79` currently
   asserts *confirmed*; it must assert unconfirmed. This is an intentional
   assertion change, called out for review rather than quietly flipped.

`tests/claude-models-discovery.test.ts` beside the client-version forwarding test
at `:518`: with no inbound or runtime evidence, `/v1/models` still exposes the
gated rows.

## Verification

Focused locally during iteration; full suite + typecheck + privacy scan on
`ssh lidge`. Receipt recorded in `070_outcome.md`.

## Out of scope

Routing, dispatch, the `372000` context window, the roster contract's lack of a
completeness marker (recorded in `001` as an open question), and anything under
`src/lab/`.
