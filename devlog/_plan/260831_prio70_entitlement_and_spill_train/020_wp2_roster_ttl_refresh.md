# 020 — wp2: refresh the expired roster at the shared entry point (#3023)

Stacks on wp1. Consumes `002`. One PABCD cycle.

Branch: `codex/3023-roster-ttl-refresh`, based on the wp1 head (stacked child).

## Why it stacks rather than lands independently

wp2 makes the management surfaces re-read the entitlement record. wp1 fixes *what*
that record contains. Landing wp2 alone would refresh a still-wrong answer: the
bug would appear fixed on a warm cache and persist on a cold one.

## Change 1 — a conditional ensure, not an unconditional resolve

New export in `src/codex/model-entitlements.ts`: an ensure/freshness operation that
enters the real resolver **only** for credential/version entries that are missing
or past their own deadline. It must treat as cached answers:

- a confirmed roster inside `MODEL_ROSTER_TTL_MS`;
- a confirmed-empty entry (after wp1, unconfirmed with the 15s TTL);
- an unconfirmed failure entry inside `MODEL_ROSTER_FAILURE_TTL_MS`.

It must reuse the existing per-account/version keys and in-flight deduplication
(`:223`, `:455`) so concurrent pollers collapse into one upstream fetch.

## Change 2 — await it from the shared entry point

`src/server/management/model-rows.ts:50`, `listManagementModelRows`: await the
ensure in parallel with `fetchAllModels`, before `nativeModelRows` — the shape
`/v1/models` already uses (`src/server/index.ts:1155`).

```ts
const [routed] = await Promise.all([fetchAllModels(config), ensureCodexEntitlementFreshness(config)]);
```

This repairs all three reported surfaces at once because they funnel here:
`/api/models` directly, `/api/client-config` via `loadExportModels`, and
`ocx export` by requesting `/api/models` over HTTP
(`src/cli/export-command.ts:169`).

**Failure must not throw.** A rejection here would degrade sidecar candidates
(`src/sidecar/candidates.ts:29`) and could turn client-config into a 503. The
ensure resolves with a bounded fail-closed result; the rows stay short, which is
the honest outcome, and Change 3 makes that visible.

## Cost bound (the constraint that shapes this)

The dashboard reaches this entry point ~24 times/minute (`/api/sidecar-settings`
every 5s, computing vision and web-search candidates independently), ~30 with the
Models page open. Polls pause on a hidden document.

So the ensure must be a **cache read** in the steady state: no credential
enumeration, no allocation of a resolver context, no network. Measured target:
with a fresh roster, repeated calls perform zero fetches and no credential
validation. That assertion is a test, not a hope.

## Change 3 — an honest entitlement diagnostic (additive)

`discovery: {"status":"ok"}` is produced by routed-provider discovery
(`src/codex/catalog/provider-fetch.ts:1510`) and is *correct* for what it
describes. Overloading it would erase a simultaneously true routed result.

Add a separate field (`entitlementDiscovery`) distinguishing: no logged-in
credential, fresh, confirmed-empty, refresh failed, expired-awaiting-refresh. GUI
types admit only provider states today (`gui/src/models-groups.ts:2`), so this is
additive on both sides.

**Scope guard:** if the diagnostic grows past a small additive field plus its GUI
type, split it into its own work-phase rather than inflating this cycle.

## Regressions (each driven red first)

- `tests/codex-model-entitlements.test.ts` — fresh repeated ensure -> zero
  refetches; at TTL+1 concurrent callers -> exactly one; failed refresh stays
  unconfirmed with no retry for 15s.
- `tests/native-model-toggle.test.ts` — expired confirmed roster, `/api/models`
  still lists sol/terra/luna. Red today.
- `tests/management-client-config-route.test.ts` — same fixture; OpenCode map holds
  the GPT-5.6 entries; entitlement fetch count is 1.
- `tests/cli-export-command.test.ts` — repoint its fake proxy at the real
  `/api/models` handler. Its stubbed rows currently bypass the defective boundary,
  so today's green is vacuous for this defect.

## Must not change

The expiry check (`:509`) — serving expired grants breaks fail-closed revocation.
`/v1/models` authorization or version behaviour. Per-account/version keys.
Synchronous `nativeModelRows` must stay synchronous.

## Open question to settle during P

Whether a stale management request waits out the 8s entitlement timeout or returns
a pending diagnostic immediately. Serving stale rows is inconsistent with the
current posture, so the default is to wait — but 8s on a dashboard poll is its own
problem. Resolve before B, and record the decision here.
