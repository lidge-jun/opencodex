# 040 — wp4: an honest entitlement diagnostic

Split out of wp2 by audit round 1 (`004`, blocker 4). Stacks on wp2.
Lowest priority in this train — it makes an existing silence visible; it does not
fix a broken behaviour.

## The problem

While entitled rows were missing, `GET /api/providers` still reported
`discovery: {"status":"ok"}`. The reporter read that as the proxy lying.

It is not lying — it is answering a different question. That field is written by
routed-provider discovery (`src/codex/catalog/provider-fetch.ts:1510`,
`src/codex/model-cache.ts:94`) and entitlement resolution never touches it. Routed
discovery genuinely was ok. Nothing anywhere reports on entitlement freshness, so
the operator has no way to tell "this account owns nothing" from "we could not ask".

## Why it is not wp2's job

`/api/models` returns a bare array (`src/server/management/model-routes.ts:352-354`)
and both the GUI and `ocx export` depend on that shape
(`gui/src/pages/Models.tsx:402-417`, `src/cli/export-command.ts:169-185`). A
top-level field breaks both consumers; a per-row field stamps one global fact onto
every row. Neither is acceptable, so the transport is a design decision rather than
an implementation detail.

## Direction

`/api/providers` already carries `discovery` per provider, so an additive sibling
there is the natural home for canonical OpenAI: same endpoint, same mental model,
no shape change for array consumers.

States to distinguish (from `002` and the wp1/wp2 work):

- no logged-in Codex credential
- fresh confirmed roster
- `unconfirmed-empty` — upstream returned no usable rows
- refresh failed (upstream error, timeout)
- expired, refresh in flight

> Audit round 2 (`005`) removed a state this doc originally listed: "confirmed
> roster that is genuinely empty". wp1 Change 2a makes every empty parsed roster
> **unconfirmed**, so that state is unreachable.
>
> The deeper reason it must not come back: the roster contract has no completeness
> marker, so the system genuinely cannot distinguish "this account owns nothing"
> from "upstream returned an unusable empty answer". Labelling one as the other
> would be a lie in a status field — precisely what `002` criticised
> `discovery: ok` for. `unconfirmed-empty` says only what is known.

Do **not** overload `discovery`. It would erase a simultaneously-true routed
result and cannot express partial per-account success. GUI types admit only
provider discovery states today (`gui/src/models-groups.ts:2`), so both sides are
additive.

## Regression

`tests/management-provider-validation.test.ts` (~`:655`): provider discovery stays
`ok` while the entitlement status independently reports fresh / failed /
unavailable. The point of the test is that the two fields are *independent* — that
is the whole reason this phase exists.

## Scope guard

If this grows past an additive field, its GUI type, and one regression, stop and
re-plan. It is a diagnostic, not a subsystem.

## Dependency

Needs wp1 and wp2 landed first: the states above only become distinguishable once
wp1 separates unknown from denied and wp2 knows whether a refresh was attempted.

## Prerequisite: failure provenance (audit round 3 — `006`)

Verified blocker: parsed-empty and network/timeout failure produce the **identical**
cache entry today. The success path when `parseAccountModels` returns an empty set
(`src/codex/model-entitlements.ts:414`) and the catch path (`:424`) both yield
`{models: new Set(), confirmed: false}`. Nothing downstream can tell them apart.

So `unconfirmed-empty` and "refresh failed" are one state in the data. Reporting
them as two would be exactly the invented-status-field lie `002` objected to in
`discovery: ok`.

wp4 therefore requires, in order:

1. Record provenance on the cache entry — `parsed-empty` / `http-error` /
   `timeout` / `unparseable` — as a discriminated field, not a boolean.
2. A regression asserting the two states are genuinely distinct end to end.
3. Only then may the diagnostic name them separately.

If provenance is not added, wp4 reports a single merged `unconfirmed` state and
says so plainly. An honest coarse answer beats a fabricated precise one.
