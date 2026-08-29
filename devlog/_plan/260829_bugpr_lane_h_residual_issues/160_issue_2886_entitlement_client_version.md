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
3. **Neither available → do not ask.** Sending `0.0.0` manufactures a confirmed negative,
   which is the whole defect. No trustworthy version means unconfirmed, and unconfirmed
   already suppresses (`:321`) and routing already rejects
   (`src/codex/auth-context.ts:458`). Fail closed on absent evidence, never on invented
   evidence.

This needs a real seam. `fetcher` (`:43`) can observe the URL but cannot choose the
version, so `resolveCodexModelEntitlements` and `isDirectCallerEntitledToCodexModel`
both take an explicit client version.

## The cache has to be version-scoped

`accountModelsCache` is keyed by account ID alone, with credential identity stored as a
discriminator (`:30`, `:216`); the flight key is account plus credential identity
(`:223`). Version must join both, or a roster fetched under one version keeps answering
for another until the TTL expires.

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

A second case pins the precedence chain: with no trustworthy version, discovery must be
**unconfirmed** rather than a confirmed negative. Named mutation: fall back to `0.0.0`;
the account is then reported as positively denying the models.

Cache identity gets its own case — fetch under one version, ask under another, assert a
re-fetch. Named mutation: drop version from the cache key.

**B** in `tests/model-visibility-management-api.test.ts`: with `disabledModels:
["gpt-5.6-sol"]` and no entitlement cache, the PUT must be accepted and clear the entry,
specifically not returning `invalid model visibility target`. Named mutation: derive
`supportedNative` from `nativeModelRows` again.

## What this does not claim

The reporter supplied no captured `/codex/models` response, so I cannot prove their
machine took the confirmed-negative branch rather than a transient failure. Both produce
the same symptom. The version-filter explanation is what the source, the version boundary,
and this repository's own measurement support, and the fix is correct either way — but if
their roster was failing for another reason the models will still be missing afterwards,
and the issue should be reopened with a redacted capture rather than assumed fixed.

