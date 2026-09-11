# 160 — issue #2886: entitled GPT-5.6 Sol/Terra/Luna vanish from the native catalog

## What the reporter saw

A healthy ChatGPT Plus account that can demonstrably use `gpt-5.6-sol` — native Codex
routing shows it, a fresh Sol conversation completes, and OpenCodex 2.33.0 advertises all
three — loses `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` from both
`ocx models live` and the Codex App picker after upgrading to 2.35.0. Re-enabling them
by hand fails with `invalid model visibility target`.

The A/B is single-variable and includes a working control, so this is not a stale picker
cache.

## The filtering is upstream, and this repository already measured it

OpenCodex never compares `minimal_client_version` itself — it strips the field
(`src/codex/catalog/metadata.ts:502`, `src/codex/catalog/parsing.ts:486`), with a
regression pinning that at `tests/codex-catalog.test.ts:2737`. So no local filter is
dropping these rows; the roster arrives without them.

A prior unit measured the endpoint directly
(`devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md`):
`client_version` is a required query parameter, and the model count returned depends on
it — `0.60.0` yields **0** models, `0.142.2` yields **5**.

Entitlement discovery asks for exactly `client_version=0.0.0`
(`src/codex/model-entitlements.ts:14`). It is asking upstream to describe what a
prehistoric client may use, and then treating the answer as what this account owns.

`#2550` added the three slugs to `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`
(`src/codex/catalog/native-models.ts:5-10`), which is correct policy for the inverse
report in `#2548`. Fail-closed is right when entitlement is unknown; the defect is that
the input was never a real entitlement answer. A valid `{models:[...]}` response sets
`confirmed: true` regardless of contents (`:133-143`, `:172-180`), availability requires
`confirmed && models.has(id)` (`:317-327`), and catalog sync then drops the rows
(`src/codex/catalog/sync.ts:1579-1596`).

The account's plan is never consulted, and WHAM is a separate request
(`src/codex/auth-api.ts:767-785`) — `plan=plus, status=200` proves authentication, not
roster contents. The reporter's evidence and the code were measuring different things.

## Where the real version comes from

There is no existing outbound precedent to copy: native forwarding uses
`FORWARD_HEADERS` (`src/adapters/openai-responses.ts:35`), which carries neither
`user-agent` nor any version header, and the other `client_version: "0.0.0"` sites
(`src/codex/convergence.ts:476`, `src/codex/catalog/sync.ts:1988`) are local Codex cache
wrappers, not upstream requests.

But the best source is already in hand for the path that matters. A live catalog request
arrives **from Codex**, carrying its own `client_version` query parameter, and the handler
already detects it (`src/server/index.ts:1173`) while calling entitlement discovery
without it (`:1073`). The value is right there and is thrown away.

So version authority is a precedence chain, not a single lookup:

1. **The inbound request's `client_version`**, when the caller supplied one. This is the
   only value that is certainly the version of the client being answered.
2. **The selected Codex runtime version** for background sync, where there is no inbound
   request. `loadPersistedCodexRuntime()?.selectedVersion` (`src/codex/runtime.ts:256`)
   performs no freshness validation and the file is written only by runtime-selection paths
   (`:621`), so it can be absent after a persist failure, stale before selection runs, or
   describe the binary OpenCodex chose rather than an externally launched client. Retained
   sync does refresh runtime evidence first (`src/codex/catalog/sync.ts:1828`), which is
   what makes it usable here and not elsewhere.
3. **Neither available → ask under this build's own gated floor.**
   `GATED_MODEL_CLIENT_VERSION_FLOOR` is derived from the highest
   `minimal_client_version` that `src/codex/data/upstream-models.json` records for the
   models in `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` (`0.142.2` today). It is a claim this
   repository can substantiate, and it is derived rather than written down so a refreshed
   snapshot cannot leave it stale.

   **This tier was wrong in the first attempt and CI caught it.** The original design said
   "neither available → do not ask", on the reasoning that failing closed on absent evidence
   was the existing contract. That is true for a *request*, and false for background sync:
   `syncCatalogModels` has no inbound request, and on a host where Codex has never been
   resolved it has no persisted runtime either — yet it is exactly the path that publishes
   account-confirmed native rows. Skipping discovery there suppressed the rows this fix
   exists to restore. Two pre-existing tests failed on `dev` CI and neither was in the
   originally chosen focused set:
   `tests/claude-models-discovery.test.ts` ("Codex discovery exposes the observed native as
   a selector row plus one global bare row") and `tests/codex-catalog-sync-hardening.test.ts`
   ("account sync preserves an observed gated native only after the mapped account confirms
   it"). The lesson is narrow and worth keeping: *fail-closed is a property of a request
   path, and a background publisher is not a request path.*

   Sending `0.0.0` remains forbidden, and now by value rather than by exact string —
   `0`, `0.0`, `00.0.0`, and `0.0.0-dev` all make the same claim (a client predating every
   gated model) and are all rejected. The value is also length-bounded because it is
   interpolated into an outbound URL.

This needs a real seam. `fetcher` (`:43`) can observe the URL but cannot choose the
version, so `resolveCodexModelEntitlements` and `isDirectCallerEntitledToCodexModel`
both take an explicit client version.

## The cache has to be version-scoped

`accountModelsCache` is keyed by account ID alone, with credential identity stored as a
discriminator (`:30`, `:216`); the flight key is account plus credential identity
(`:223`). Version must join both, or a roster fetched under one version keeps answering
for another until the TTL expires.

The first attempt kept the account-only **cache key** and merely compared the stored version
on read. Review showed that is not equivalent: with two versions in flight for one account,
the later-completing one overwrites the earlier, and the *unversioned* projection readers in
`src/codex/catalog/metadata.ts:424,514` then publish whichever landed last rather than what
each client proved. The key itself is now `account\u0000version`, with account-scoped
invalidation walking every version's entry so a credential change still clears all of them.

`cachedAvailableAccountGatedNativeModels` scans every cache entry (`:331`). Once two
versions can be retained at once, that scan will leak a newer roster into an older
client's projection — the `#2548` failure, arrived at from the opposite direction. It has
to filter by the version being projected.

`isCodexModelEntitlementSnapshotCurrent` validates credentials only (`:346`); a runtime
version change during a gather needs the same stale-result protection.

## Sub-defect B, correctly scoped

`ocx models enable gpt-5.6-sol` fails because `/api/model-visibility` builds
`supportedNative` from `nativeModelRows(config)`
(`src/server/management/model-routes.ts:461-468`), which has already dropped the
suppressed rows, so validation rejects at `:477-478`.

Validating bare native IDs against the static `NATIVE_OPENAI_MODELS` set
(`src/codex/catalog/native-models.ts:69`) fixes that, **unioned with** the existing
account-qualified targets rather than replacing them.

Being precise about what this buys: acceptance only clears `disabledModels` (`:532`).
Entitlement still filters `nativeModelRows` (`src/codex/catalog/metadata.ts:424`) and
routing stays gated. So B is **not** a manual escape from a false negative — the earlier
draft of this page claimed that and was wrong. B removes a misleading 400 and lets an
operator pre-clear an independent disable key. If no disable key exists, B changes nothing
the user can see. A is the fix; B is a UX and configuration repair that stops the CLI from
lying about why.

## Verification

**A** in `tests/codex-model-entitlements.test.ts` (fetch seam already exercised at
`tests/codex-model-entitlements.test.ts:38`): a mock backend that returns a legacy-only
roster below the threshold and the full roster at `0.146.0`. The wrong behavior asserted
is the real one — *an entitled account is classified as denying GPT-5.6 because OpenCodex
under-reports its own client version*. Named mutation: restore the `0.0.0` literal.

A second case pins the precedence chain's last tier: with no inbound version and no
persisted runtime, discovery must still ask — under the derived floor, verbatim. Named
mutations: return `null` from tier 3 (three tests fail, including the two CI regressions
above), and hardcode a stale floor instead of deriving it from the snapshot.

Cache identity gets its own case, and the **first version of it was vacuous** — an
independent review proved the test stayed green after reverting *both* the cache-hit version
comparison and the version component of the flight key. It seeded the cache directly through
`seedCodexModelEntitlementsForTests`, so it only ever exercised the optional projection
filter, never the write path. The rework drives the real path through a Direct caller, whose
credential identity is derived from its own bearer token (`direct:<hash>`) and therefore
satisfies the identity guard that decides whether a completed flight may write — which a
synthetic pool credential never does. Two cases now:

- sequential: fetch under version A, ask again under A (served from cache, no second
  request), then ask under B and assert a re-fetch;
- concurrent: two versions in flight for one account, completing newest-first, and both
  answers must survive. Named mutation for both: collapse the cache key back to account-only.
  The flight key's version component has its own mutation, which the concurrent case catches.

The version is also asserted end to end at the route: `/v1/models?client_version=0.151.7`
must produce `0.151.7` on the outbound `/codex/models` request. Named mutation: drop the
`url.searchParams.get("client_version")` argument in `src/server/index.ts`.

Tier 2 is memoized for five seconds because it reads `codex-runtime.json` from disk on every
gated authorization and every `/v1/models` resolution, including when the roster cache is hot
and the answer needs no I/O at all. Named mutation: bypass the memo and re-read every time.

**B** in `tests/model-visibility-management-api.test.ts`: with `disabledModels:
["gpt-5.6-sol"]` and no entitlement cache, the PUT must be accepted and clear the entry,
specifically not returning `invalid model visibility target`. Named mutation: derive
`supportedNative` from `nativeModelRows` again.

## What this does not claim

### The floor is an entitlement probe, not client-compatibility evidence

An independent review called this a blocker: tier 3 asks under `0.142.2`, which is a *model
requirement*, not evidence of the installed client's version, so an entitled account can have
gated rows published into a catalog that an older externally launched Codex cannot drive — the
#2548 direction. The reasoning is sound and the risk is real. The fix is still the floor, for
four reasons that the code and the existing tests support:

1. **The suggested alternative contradicts `dev`.** "Refuse or defer the durable catalog write
   when no client version is available" is what returning `null` did, and two tests already on
   `dev` fail under it: `tests/claude-models-discovery.test.ts` and
   `tests/codex-catalog-sync-hardening.test.ts` ("account sync preserves an observed gated native
   only after the mapped account confirms it"). Those tests encode the intended behavior — a
   background sync *should* confirm entitlement and publish. A change that contradicts them is a
   separate, deliberate decision, not a fix to this bug.

2. **Tier 2 already handles the known-old-client case correctly.** If a Codex runtime has been
   resolved and it is older than the gated models require, tier 2 supplies *that* version, upstream
   returns no gated rows, and they stay suppressed — which is exactly right. Tier 3 is reached only
   when no runtime has ever been resolved, so there is no known client to be wrong about.

3. **The floor is the narrowest probe that can work.** It is the lowest version under which the
   gated models can be returned at all. Asking under it cannot manufacture a confirmation: an
   unentitled account still comes back without the rows.

4. **Client-compatibility filtering has never existed here.** No code path in `src/` consults
   `minimal_client_version`; both catalog sites delete it (`catalog/parsing.ts:486`,
   `catalog/metadata.ts:502`). The proxy has never enforced client-version compatibility, so this
   change does not remove a guard — it leaves a pre-existing gap where it was.

The tradeoff, stated plainly: the failure this accepts is a model appearing for a client too old to
drive it, which surfaces as an upstream error on use. The failure it fixes is an entitled account on
a current client silently losing GPT-5.6 — the reported bug. Adding a real client-compatibility
filter is worth doing, and it is its own unit of work with its own decision about those two tests.

The reporter supplied no captured `/codex/models` response, so I cannot prove their
machine took the confirmed-negative branch rather than a transient failure. Both produce
the same symptom. The version-filter explanation is what the source, the version boundary,
and this repository's own measurement support, and the fix is correct either way — but if
their roster was failing for another reason the models will still be missing afterwards,
and the issue should be reopened with a redacted capture rather than assumed fixed.
