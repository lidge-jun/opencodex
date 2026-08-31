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

## Change 2 — an unusable roster is not a confirmation

Same file, `fetchAccountModels` (`:414`).

Today:

```ts
expiresAt: now + (models ? MODEL_ROSTER_TTL_MS : MODEL_ROSTER_FAILURE_TTL_MS),
models: models ?? new Set(),
confirmed: models !== null,
```

An empty `Set` is truthy, so `{"models":[]}` earns `confirmed: true` and the
five-minute success TTL. Two conditions must stop producing confirmation:

1. **Empty parsed roster.** No usable row means no evidence, not a denial.
2. **Roster obtained below the measured minimum.** If the question could not have
   returned the gated rows, their absence says nothing about entitlement. This is
   the case `models.size > 0` cannot catch: the reported short roster contains
   `gpt-5.5`, so it is non-empty while every gated slug is absent.

Both take `MODEL_ROSTER_FAILURE_TTL_MS` (15s) so recovery is prompt once the
version chain improves, instead of a five-minute lockout.

Shape: compute a `usable` boolean beside `models`, and derive `confirmed` and the
TTL from it. Condition 2 needs `clientVersion` compared against the minimum —
already a parameter of the function.

**Fail-closed is preserved.** An unconfirmed account still yields no gated rows;
`confirmedAccountIds` still gates every projection. The change makes *unknown*
distinguishable from *denied*; it does not admit unknown as entitled.

## Change 3 (bounded) — correct the stale snapshot metadata

`src/codex/data/upstream-models.json`: the three gated rows record
`minimal_client_version: 0.142.2` and `context_window: 372000`, both contradicted
by the in-repo live measurement (`0.144.0`, `272000`).

Treat this as **optional for this cycle and out of scope if it moves anything
else.** The file is a pinned catalog snapshot consumed as exact model metadata; the
context-window value in particular feeds
`NATIVE_GPT56_CONTEXT_WINDOW` consumers and has its own tests
(`tests/codex-catalog.test.ts:2706`, `:2905`). Changing `372000` is a separate
behavioural question and must not ride along here.

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
3. `{"models":[]}` -> account not confirmed, failure TTL. Red now: confirmed.
4. Roster with only `gpt-5.5` under `0.142.2` -> unconfirmed; after 15s with a
   full roster a refetch restores the gated rows. Red now: cached 5 minutes.
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
