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

`confirmed` is a single bit for the whole account (`:223-234`) and every gated
projection requires it (`:547-550`, `:573-593`, `:527`). It cannot carry a
per-model judgement, which is why 2b had to move to wp5.

Correction from audit round 5: an unconfirmed account does **not** lose
`gpt-5.5`/`gpt-5.4`. Both projections skip the flag entirely for any slug outside
`ACCOUNT_GATED_NATIVE_OPENAI_MODELS` — the filter is
`!ACCOUNT_GATED.has(slug) || (confirmed && entitled.has(slug))`
(`src/codex/catalog/sync.ts:1617-1620`, `src/codex/convergence.ts:280-284`). So
`confirmed` suppresses account-gated models only, and the earlier draft's worry
about ungated native rows was unfounded. What it *does* mean is that a wrong
`confirmed: true` on an empty roster is a confirmed denial of sol/terra/luna —
which is the defect.

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

## Regressions

> Amended after audit round 4 (`007`). Two of the original claims about these
> tests were wrong, and two regressions were missing. Red-first status is now
> marked per case rather than asserted for the set.

`tests/codex-model-entitlements.test.ts`

1. **Red-first.** Effective floor is `0.144.0`. Red now: returns `0.142.2`.
2. **Red-first only after the mock is corrected.** No inbound and no runtime
   version, upstream mock returning gated rows only at `>= 0.144.0` -> the request
   uses `0.144.0` and sol/terra/luna are available. The existing test at `:226`
   mocks the gate at minor `>= 142`, and `144 >= 142`, so raising the floor alone
   leaves it green — that mock threshold moves to `>= 144` as part of this
   regression, along with the comment at `:238-240` that explains it.
3. **Red-first.** `{"models":[]}` -> account not confirmed, failure TTL. Red now:
   confirmed with the 5-minute TTL (probe: no refetch at 15,001 ms, refetch only
   after 300,001 ms).

   Audit round 5, finding 1: the TTL half of this only proves anything against a
   **real cache entry**. `boundedCacheSet` runs only when
   `currentCredentialIdentity(accountId)` equals the snapshot's identity
   (`src/codex/model-entitlements.ts:486-490`, `:330-340`), and the suite's
   `credential()` helper mints `test:<account>`
   (`tests/codex-model-entitlements.test.ts:28-34`), which matches nothing. Use the
   Direct-caller path — `isDirectCallerEntitledToCodexModel` with
   `directHeaders(...)`, whose identity is a stable SHA-256 token fingerprint
   (`direct:<hash>`, `src/codex/model-entitlements.ts:437-451`) — or a genuinely
   persisted pool/main record. Then assert both halves: **no** refetch before 15s, and **exactly one** after 15,001 ms.
4. **Green on both sides — characterization guard, not a red-first regression.** A
   non-empty roster stays confirmed. It bounds 2a against over-reach: only the
   *empty* case may change, so an ordinary short roster must still confirm the
   account and expose whatever it grants.
5. **Red-first.** The existing "all rows filtered as hidden/api-disabled" case at
   `:79` currently asserts *confirmed* at `:90`; it must assert unconfirmed. This
   is the single existing assertion anywhere in the suite whose outcome changes,
   and it is an intentional flip called out for review rather than a quiet edit.
6. **Red-first. New in round 4.** The floor is a *composition*, so test it as one:
   with a synthetic derived floor above `0.144.0`, the higher value must win.
   Without this, replacing the export with the bare literal `0.144.0` passes every
   other case while destroying the future-snapshot property stated at `:28-36`.
7. **Red-first. New in round 4.** The all-filtered case must also prove refetch
   after 15,001 ms, under the same real-cache-entry requirement as regression 3.
   Flipping `confirmed` while leaving the five-minute TTL in place would otherwise
   pass regression 5 with the bug still present.

`tests/claude-models-discovery.test.ts` beside the client-version forwarding test
at `:518`: with no inbound or runtime evidence, `/v1/models` still exposes the
gated rows. The backend for this case must be **version-sensitive** — the existing
no-inbound mock at `:404-411` answers Daybreak for every version, so a
version-blind copy of it is green on both sides and proves nothing.

## Churn bound for 2a (audit round 4, finding 7)

The 15s failure TTL is demand-driven, not timer-driven, so shortening it opens no
background traffic. Refetch happens only through `/v1/models`
(`src/server/index.ts:1158-1164`), Direct gated authorization
(`src/codex/auth-context.ts:382-385`), catalog sync
(`src/codex/catalog/sync.ts:1834-1840`) and convergence
(`src/codex/convergence.ts:409-416`). Identical account and version coalesce onto
one in-flight request (`:461-470`), and distinct versions are capped at four
concurrent flights per account (`:472-483`).

Worst case for a legitimately empty account is about four fetches per minute per
active version under continuous **`/v1/models` or Direct gated** demand.
Correction from audit round 5: this is **not** dashboard polling today.
`/api/models` reaches only `listManagementModelRows`
(`src/server/management/model-routes.ts:352-354`), which never resolves
entitlements (`src/server/management/model-rows.ts:50-55`). Dashboard polling
becomes a caller of this path only once wp2 lands, so wp2 inherits the cost bound
rather than wp1 paying it.

Sequential high-cardinality version cycling is concurrency-bounded but not
rate-limited; that is pre-existing and out of scope here.

## Verification

Focused locally during iteration; full suite + typecheck + privacy scan on
`ssh lidge`. Receipt recorded in `070_outcome.md`.

## Out of scope

Routing, dispatch, the `372000` context window, the roster contract's lack of a
completeness marker (recorded in `001` as an open question), sequential
version-cycling rate limits, and anything under `src/lab/`.
