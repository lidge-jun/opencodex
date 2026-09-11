# 010 — wp2: floor-aware tier 2 in the entitlement resolver

## Change

One file: `src/codex/model-entitlements.ts`.

`resolveCodexEntitlementClientVersion` currently ends:

```ts
return selected ?? GATED_MODEL_CLIENT_VERSION_FLOOR;
```

It becomes a clamp rather than a fallback: whatever tier 2 produces, the question we put to
upstream is never below `GATED_MODEL_CLIENT_VERSION_FLOOR`.

```ts
if (selected === null) return GATED_MODEL_CLIENT_VERSION_FLOOR;
return compareClientVersions(selected, GATED_MODEL_CLIENT_VERSION_FLOOR) >= 0
  ? selected
  : GATED_MODEL_CLIENT_VERSION_FLOOR;
```

Expressed through a small named helper so the intent reads at the call site, and so the
existing `compareClientVersions` stays the single ordering authority.

## The policy, stated exactly

The clamp is not "background only" — `isDirectCallerEntitledToCodexModel` and both
`src/codex/auth-context.ts` authorization paths also reach tier 2, because they are inbound
requests carrying no `client_version`. The rule is about which question is asked:

- **No inbound version supplied** -> the caller is asking whether the ACCOUNT owns the model.
  Upstream only incidentally filters that answer by version, so ask at no less than the floor.
- **An inbound version supplied** -> the caller is asking what THAT CLIENT may use. Answer for
  that version, verbatim.

## What must not change

- **Tier 1 keeps absolute precedence.** If Codex 0.140.0 asks, it is told what 0.140.0 can
  use. Clamping there would advertise rows that client cannot drive (#2548) and would break
  the existing `"an omitted gated slug below its minimum is unknown and uses the failure TTL"`
  contract, which supplies `0.140.0` as inbound and requires `unknown` rather than `denied`.
- **A runtime at or above the floor still wins.** `0.145.1` resolves to `0.145.1`, not to the
  floor. The clamp raises; it never lowers.
- **`readRuntimeVersion` and `memoizedPersistedRuntimeVersion` stay exact.** They report what
  is on disk. The clamp is applied by the resolver on the way out, so
  `memoizeRuntimeVersionForTests` and every non-entitlement consumer of `selectedVersion`
  (runtime identity, catalog cache keys, `X-Codex-Version`, install provenance) are untouched.
- **No new grant without upstream evidence.** The clamp changes only which version we ask
  under. `granted` still requires the model to be present in the returned roster.

## Why the clamp is not "inventing a version"

The floor is not a guess. It is composed in this same file from the highest of: the
`minimal_client_version` this build's own bundled snapshot records for the gated slugs, the
measured `0.144.0`, and the `0.142.2` fallback. Asking under it is the narrowest question
that can still return the models this build claims to support. Tier 3 has asked exactly that
question since #3035; this change stops a stale tier 2 from asking a worse one.

## Regressions and controls

All in `tests/codex-model-entitlements.test.ts`. Only the first two can fail before the fix;
the rest are invariants this change must not disturb, and are labelled as such rather than
counted as coverage.

RED before the fix, GREEN after:

1. `inbound = null`, persisted `0.141.0` -> the resolver returns the floor, and the version
   actually sent upstream is the floor. RED today: `0.141.0` both times.
2. End-to-end on the same host: upstream returns the gated rows only at or above `0.144.0`
   -> `gpt-5.6-sol` projects `granted` and reaches `availableAccountGatedNativeModels`.
   RED today: absent.

Controls (pass before and after):

3. Tier 1 verbatim: inbound `0.140.0` with persisted `0.141.0` resolves `0.140.0`, and a
   gated slug missing from that roster stays `unknown`, not `denied`.
4. A runtime at or above the floor is preferred: persisted `0.145.1` -> `0.145.1`.
5. No fabricated grant: asked at the floor, a roster that genuinely omits the model does not
   yield `granted`.

Dropped as vacuous: the proposed "memo purity" case. `memoizeRuntimeVersionForTests` returns
`memoizedPersistedRuntimeVersion` directly and never passes through the resolver, so it
cannot observe this defect in either direction.

Cache identity, added after the audit:

6. The resolved version is part of `cacheKeyFor` and of the in-flight key, so an inbound
   `0.141.0` caller and an unversioned caller now occupy separate entries and issue two
   fetches rather than coalescing. Asserted directly: two fetches, `0.141.0`-scoped absence,
   floor-scoped visibility.

## Verification

`bun test tests/codex-model-entitlements.test.ts`, plus `tests/claude-models-discovery.test.ts`
(touched by #3035 for the same seam), then `bun run typecheck`.
