# Design decisions

Research document. Each section states the alternatives, the choice, and what would
falsify the choice. No diffs; `010`-`040` own those.

## A. Where the account token lives

The mint endpoint needs the Meta **account token**. Every existing request path needs the
`LLM|` **API key** as a plain bearer: `src/server/responses/core.ts:4480` copies the stored
access value onto `provider.apiKey`, and `src/adapters/openai-responses.ts:2364` sends it
verbatim as `Authorization: Bearer ${provider.apiKey}`. Model discovery does the same at
`src/oauth/index.ts:1205`. So a device login has two secrets and one slot.

**Alternative 1 — overload the bearer (the reference's choice).** Store
`JSON.stringify({oauthAccessToken, apiKey})` in `access`, then unpack it at the transport
seam. The reference needs `packages/ai/src/registry/muse-code.ts` to exist for exactly
this reason. In our tree the stored access value is read by the inference path, model
discovery, health projection, key failover and the account-quota readers; every one of
them would need an unpack, and any that was missed would send a JSON blob as a bearer.

**Alternative 2 — a second provider id.** Register `meta-muse-device` separately. Rejected:
it would split one user's accounts across two provider rows, duplicate the registry entry,
the models list, the ToS gate and the quota wiring, and the credential it produces is
identical in shape to the imported one.

**Chosen — a namespaced credential field.** `access` and `refresh` keep holding the
`LLM|` key exactly as today, and the account token goes into a new optional
`muse?: MuseOAuthMetadata` on `OAuthCredentials`. This is not a new pattern: `kiro?:
KiroOAuthMetadata` already occupies that role at `src/oauth/types.ts:38-53`, documented as
"Never returned by management APIs; persisted only inside the protected auth-store
boundary."

**Corrected during the A-phase audit:** that sentence is true of `kiro`, but not for the
reason this document first implied. There is no kiro-specific redactor. Outbound safety
comes from hand-built allowlists — `OAuthAccountSummary` is assembled field by field at
`src/oauth/index.ts:1839-1850`, and `OAuthAccessSnapshot` (`src/oauth/index.ts:85-100`)
carries an explicitly named "safe request-routing subset". So the protection `muse`
inherits is *construction*, and it holds only as long as nobody adds the field to either
shape. That prohibition is written into the type docstring in `010` rather than left as a
convention.

Consequences, all desirable: zero change to any request path; an imported or pasted
credential simply has no `muse` field, which is exactly the capability signal `030` needs
to decide whether an on-demand quota probe is possible; and the account token never enters
a code path that logs or projects a bearer.

Logging is protected by a different and stronger mechanism, which is worth knowing before
adding any credential field: `src/oauth/log.ts:31-33` rejects any field whose normalized
name ends in `_token`, `_secret` or `_code`. `oauthAccessToken` normalizes to
`oauth_access_token`, so it cannot be logged even by accident, and the planned
`device_code` is covered by the same rule.

Falsified if: someone adds `muse` to either allowlist, or a new surface serializes
`OAuthCredentials` wholesale. Both are visible in review; neither is silent.

## B. How `x-api-version` reaches the wire

**Alternative — a transport hook.** Extend `resolveProviderTransport`
(`src/providers/xai-transport.ts:113-122`) with a `meta-muse` branch, as the reference does
with its own transport. It works, but it only covers the call sites that invoke that
resolver, and model discovery at `src/oauth/index.ts:1162` is a separate path.

**Chosen — `staticHeaders` on the registry row.** One declarative field, already supported:
`src/providers/registry.ts:175-176` declares it, `mergeRegistryStaticHeaders`
(`registry.ts:3494-3505`) merges it while yielding to any name the user has claimed,
`src/router.ts:332` applies it to the request path, `src/providers/derive.ts:236` seeds it
into a freshly written provider entry, and `src/oauth/index.ts:1176` applies it to model
discovery. `opencode-free` (`registry.ts:3198-3210`) is the working precedent.

Falsified if: Meta requires the header to differ per request (it is a static protocol
version, so this is unlikely), or if a user must be able to remove it — which
`mergeRegistryStaticHeaders` already permits by claiming the name.

## C. Which accounts get an on-demand quota probe

Today `meta-muse` is wholly passive: `hasPassiveAccountQuota` returns true for it
(`src/providers/quota.ts:1870-1871`) and the dispatcher therefore takes the cache-only
branch (`quota.ts:3037`). The comment above `fetchPassiveProviderQuota` is explicit that
this is a deliberate refusal to spend an inference turn, not an oversight
(`quota.ts:1606-1613`).

A device-logged-in account can now be probed for real, because the mint endpoint returns
`subs_usage`. An imported or pasted account cannot: it has no account token.

**Chosen — gate on the capability, not on the provider id.** `hasPassiveAccountQuota`
stays true for `meta-muse` as the floor, and the dispatcher gains a branch *above* the
passive one that runs the mint probe only when the active account carries
`credential.muse?.oauthAccessToken`. A probe result is written through the existing
account-quota cache so the passive reader keeps serving it after a restart; a probe
failure falls through to the passive row rather than blanking the bars.

This is the one place where being stricter than the reference matters: the reference's
usage provider declares `supports()` by parsing the credential, and returns `null` when it
cannot — the same idea, expressed as a per-call parse instead of a capability gate.

**Hardened during the A-phase audit.** A failure backoff alone is not enough, because two
callers bypass the ordinary quota cache: `GET /api/provider-quotas?refresh=1`
(`src/server/management/provider-routes.ts:747-748`) and the reset poller, which calls
`fetchProviderQuotaReports(loadConfig(), true)` on every tick
(`src/quota/reset-poller.ts:83`). A forced refresh skips `CACHE_TTL_MS`
(`src/providers/quota-wire.ts:13`), so a user holding down a refresh button would drive one
key-mint request per click. The probe therefore keeps its OWN success TTL and honours it
regardless of `forceRefresh` (`030` §C). This is the strongest reason to gate on
capability: the probe is the only quota source in this repository that touches an endpoint
with a side-effecting name.

Falsified if: the mint endpoint turns out to charge, to count against the subscription, or
to rotate the key. `001` §B shows it as an auth-plane call returning the same key, but that
is second-party evidence, which is exactly why the probe is rate-limited on both success
and failure and never runs on the request path.

## D. Why there is no PKCE here

The request asked for a login shaped like PKCE rather than a credential import, and that
is what this unit delivers — a user-approved browser grant instead of a Keychain read.
PKCE itself does not apply: RFC 8628 has no redirect to intercept, so there is no
`code_verifier` exchange to protect, and `001` §A shows the reference sends none.

Our one existing device flow that *does* carry a verifier is instructive:
`src/oauth/chatgpt-device.ts:9-16` notes the poll returns a **server-generated** verifier
spent at the ordinary token endpoint, and that "we never generate the verifier ourselves
here". Sending a speculative `code_challenge` to Meta would be an unverified protocol
guess, so `010` does not.

What `010` does instead, which is the substance behind the request: bind the poll to the
exact `device_code` issued in the same call, cap the flow at the server-declared
`expires_in`, honour `interval` and `slow_down`, refuse to accept a grant that arrives
after the deadline, and propagate cancellation so an abandoned login stops polling.

## E. Names and files

| Thing | Choice | Reason |
|---|---|---|
| New module | `src/oauth/meta-muse-device.ts` | Mirrors `chatgpt.ts` / `chatgpt-device.ts`, the existing precedent for one provider with two grants |
| Existing module | `src/oauth/meta-muse.ts` keeps `loginMetaMuse` as the entry point | Callers and tests already target it; the device path is selected inside it (`020`) |
| Provider id | unchanged `meta-muse` | §A alternative 2 |
| Quota source | `src/providers/muse-key-quota.ts` | Keeps the SSE parser in `muse-subscription-usage.ts` untouched and shareable |
| Credential field | `muse?: MuseOAuthMetadata` | §A; mirrors `kiro` |
| Tests | `tests/providers/meta-muse-device.test.ts`, plus additions to `tests/providers/meta-muse-oauth.test.ts` | Existing file owns import/paste behaviour; the new file owns the grant |
