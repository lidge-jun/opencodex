# Muse Code device-authorization login

OpenCodex can hold a Muse Code subscription credential today, but only by reading the one
the vendor's own CLI already wrote into the macOS Keychain. This unit adds the login that
produces that credential in the first place: Meta's OIDC device-authorization grant,
followed by the subscription key mint that turns the resulting account token into the
`LLM|` Model API key our request path already knows how to use.

The work is scoped to one provider (`meta-muse`) and stops at local commits. Nothing here
authorizes a push, a PR, a release, or a live authenticated call with a real Meta account.

## Why this is a reopen, and what changed

`devlog/_fin/260903_muse_spark_plan_oauth/020_wp2_device_oauth.md` closed the device-flow
phase as a recorded negative. Its reasoning is not retracted here. Two separate things
kept it closed, and only one of them has moved.

**What has moved: the protocol is no longer unknown.** That doc listed what a reopen would
need and deliberately refused to write it:

> The plan would need what this doc deliberately does not contain: exact token endpoint
> and client id, request/response types, identity/expiry/refresh semantics, an error
> taxonomy, cancellation behavior, the chosen `src/oauth/<id>.ts` filename and registry
> id, and [...] a `gui/src/oauth-tos-risk.ts` entry with its
> `tests/oauth-tos-warning.test.ts` coverage

(The quoted test path is stale. The warning test actually shipped at
`tests/gui/oauth-tos-warning.test.ts`; the quote above is verbatim, stale path included.)

Every item on that list is now available without guessing. `001` records the endpoints,
client id, payload shapes and identity semantics from a working second-party
implementation, and the ToS entry already exists: `gui/src/oauth-tos-risk.ts:10` carries
`meta-muse` in `HIGH_RISK` as of the 260903 delivery.

**What has not moved: the vendor restriction.** Meta still scopes the credential to its
own client, and none of `020`'s four first-party reopen conditions has been met. So this
unit does not claim vendor authorization. It ships under the same posture the repository
already applies to `anthropic` and `google-antigravity`: an explicit owner decision,
a HIGH_RISK ToS gate in the GUI, a consent warning before anything is read, and a
refresh policy that generates no unattended traffic. The device flow makes that posture
*more* explicit than the import path did, because it authenticates as Meta's own client
id rather than reusing a credential the user's own CLI already minted — `010` states that
plainly in the warning text.

## Constraints

| Constraint | Consequence for this unit |
|---|---|
| No live Meta credentials may be exercised | Every endpoint contract comes from `001`; all tests inject `fetch`, `sleep` and `now` |
| No regression for existing Muse users | The Keychain import and manual-paste paths stay, and stay first in the selection order for a plain login (`020`) |
| No push authorization in this session | Delivery ends at local commits on `codex/260912-meta-muse-device-oauth` |
| The bearer our request path sends must stay a plain string | The account token is stored beside it, not inside it (`002` §A) |
| Meta's mint endpoint is rate-limited | Remint suppression plus `Retry-After` respect are requirements, not polish (`010`, `030`) |

## Work-phase map

```
wp1 (docs)  ->  wp2 (device core)  ->  wp3 (login integration)  ->  wp4 (header + quota)  ->  wp5 (tests + gate)
```

| Phase | Document | Outcome | Depends on |
|---|---|---|---|
| wp1 | this file, `001`, `002` | The roadmap below, concretized to diff level | — |
| wp2 | `010_wp2_device_core.md` | `src/oauth/meta-muse-device.ts` (device authorization, RFC 8628 poll, key mint, error taxonomy) plus the `muse` field on `OAuthCredentials` in `src/oauth/types.ts` | wp1 |
| wp3 | `020_wp3_login_integration.md` | `loginMetaMuse` gains the device path; registration, fallback order, credential persistence | wp2 |
| wp4 | `030_wp4_header_and_quota.md` | `x-api-version` on Model API requests; on-demand quota probe from the mint response | wp3 |
| wp5 | `040_wp5_tests_and_gate.md` | Targeted tests, docs consistency, receipt, local commits | wp4 |

## What "better than the reference" means here

`001` §D measures the reference implementation's weak points. Six of them are addressed,
and each is checked by a named test in `040`:

1. **No poll error taxonomy.** The reference mints a key from a token it already has; it
   never implements the device poll, so it has no `authorization_pending`, `slow_down`,
   `expired_token` or `access_denied` handling at all. `010` implements the full set.
2. **No injectable clock.** Our own existing device flows pay real seconds in tests
   (`tests/oauth/chatgpt-device-auth.test.ts:102-113` asserts a 1.9s floor). `010` injects
   `sleep` and `now`, so the poll branches are tested in milliseconds.
3. **Bearer overloading.** The reference packs JSON into the credential the request path
   uses as a bearer, then needs a transport shim to unpack it. `002` §A keeps the bearer a
   plain `LLM|` key and stores the account token in a namespaced field, following the
   `kiro` precedent in `src/oauth/types.ts`.
4. **Header via a code hook.** The reference adds `x-api-version` inside a transport
   function. `030` declares it once as `staticHeaders` on the registry row, which also
   covers model discovery and respects user overrides.
5. **Quota tied to the provider, not the capability.** `030` gates the on-demand probe on
   the account actually holding an account token, so a Keychain-imported account keeps the
   passive path instead of failing a probe it can never satisfy.
6. **No probe backoff.** No quota source in this repository implements one today
   (`src/providers/quota.ts:2171-2172` negative-caches by TTL instead). `030` adds a real
   failure backoff for the mint probe, which is the one probe that must not be retried
   aggressively.

## Risks

| Risk | Mitigation |
|---|---|
| Meta's device response field names differ from `001` | Parse defensively, accept documented aliases, fail with a named error rather than a crash; the flow is additive so a failure falls back to import/paste |
| The mint endpoint 429s during login | Remint suppression, `Retry-After` respect, and an error that names the wait instead of retrying blind |
| A user reads the device flow as vendor-approved | The consent warning states that this authenticates as Meta's own client id, and the HIGH_RISK GUI gate still fires |
| `staticHeaders` collides with a user header | `mergeRegistryStaticHeaders` (`src/providers/registry.ts:3494-3505`) already yields to user-claimed names |
| Scope creep into shared login surfaces | `020` treats the shared CLI device-code rendering as an explicitly optional item, decided at wp3's P |

## Scope amendment (wp2 P)

`src/oauth/store.ts` joins the in-scope list. It was left out originally because the
credential field looked like a pure type change. It is not: `normalizeCredential` rebuilds
every persisted credential field by field, so a field it does not know about is dropped
without error. The amendment is one block in one function, and without it the rest of this
unit is decoration.

## Audit record (wp1, A phase)

Two independent grok-4.6 reviewers audited this unit against the repository, and the main
agent audited it against the pinned test contracts. Six findings were folded; none was
rebutted. The plan as first written would not have compiled and would have broken four
existing tests.

| # | Source | Finding | Fold |
|---|---|---|---|
| 1 | main | The device call did not forward the injected `fetchImpl`, so any existing test reaching it would have called `auth.meta.com` for real | `020` [fold 1]: `fetchImpl`, `sleep` and `now` are forwarded into `loginMetaMuseDevice` |
| 2 | main | A Keychain read that times out was to become a fallthrough, breaking `meta-muse-oauth.test.ts:159-166` and, worse, starting a browser grant to solve a permissions dialog | `020` [fold 2]: it stays a throw; only a missing pointer or a pointer without a Meta account falls through |
| 3 | main | On a host with no paste surface the device error would have replaced the existing guidance, breaking the `dev.meta.ai`, `META_MODEL_API_KEY` and `no credential to import` assertions | `020` [fold 3]: `noPasteSurfaceError` composes the device reason WITH the existing guidance |
| 4 | reviewer B1 (FAIL) | `muse` was scheduled for wp3 while wp2 returns it, so wp2 fails to compile with TS2353 | `010`: the type moves into wp2, same commit as the module |
| 5 | reviewer B2 | `002` implied a kiro-specific redactor protects the field; the real mechanism is hand-built allowlists | `002` §A corrected, and the prohibition is written into the type docstring |
| 6 | reviewer B2 | A 5-minute FAILURE backoff does not stop repeated mints, because `?refresh=1` and the reset poller bypass the quota cache | `030` §C adds `SUCCESS_TTL_MS`, enforced even against a forced refresh |

Reviewer B1 also confirmed as clean: `exactOptionalPropertyTypes` is off so the conditional
spreads are valid, `sanitizeApiKeyValue` accepts `string | undefined`, the
`AbortSignal.any` pattern matches `src/oauth/nous.ts:399`, `"oauth"` is a legal
`OAuthCredentialSource`, and the planned `LLM|` regex is character-identical to
`src/oauth/meta-muse.ts:270`. Reviewer B2 confirmed that `000`'s reopen framing does not
claim vendor authorization it does not have, which was the single most important question
in the audit.

## Audit record (wp2, A phase)

Five more folds: three from the main agent reading the store, two from an independent
grok-4.6 audit of the module source. One reviewer proposal was rejected with a reason,
recorded here because a rebuttal is a decision rather than an omission.

| # | Source | Finding | Fold |
|---|---|---|---|
| W1 | main | `normalizeCredential` rebuilds rather than copies, so `muse` would be dropped on persist and the quota capability would be dead with no error anywhere | `010`: a `muse` block in `src/oauth/store.ts`, plus the scope amendment above |
| W2 | main | The store matches a slot on `accountId ?? email`, so keying a device login on `user_id` would hand an existing imported user a SECOND account | `010`: email first, `user_id` moves to `muse.userId` |
| W3 | reviewer | A 200 carrying a token was discarded when the local deadline had just passed, forcing the user to redo an approval that had already succeeded | `010`: no deadline re-check after a 200, because the server clock is authoritative and ours is not |
| W4 | reviewer | A sleep ending exactly at the deadline skipped the final poll, wasting an approval made inside that window | `010`: poll first, check the deadline only before sleeping |
| W5 | main | A payload carrying a usable key AND `require_payment` returned the key silently | `010`: the key is still returned, with a warning naming the action URL |

**Rejected.** The reviewer proposed requiring `user_id` as `accountId` and failing
`missing-identity` without it. That fixes device-to-device consistency but not the case that
actually matters: an existing user who imported a credential has a row keyed by email, and
an `accountId`-keyed device login would not match it. The fold keeps email as the slot key,
which is also the choice the import path documents at `src/oauth/meta-muse.ts:305-307`.

An earlier pair of reviewers with a broader packet returned nothing across four wait
cycles and was retired; the packets above were narrowed and re-dispatched. That retirement
is recorded because it consumed the same-agent retry.
## Verification posture

Targeted, not suite-wide. Each implementation cycle's C runs `bun run test` against the
new and adjacent test files plus a TypeScript check of the changed scope, and records the
command, exit code and output tail in a `cxc receipt test` artifact. No test performs
network, Keychain or filesystem IO: every dependency is injected, matching the existing
`deps()` convention at `tests/providers/meta-muse-oauth.test.ts:37-46`.
