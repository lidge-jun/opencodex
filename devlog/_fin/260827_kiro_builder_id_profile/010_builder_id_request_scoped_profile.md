# Kiro Builder ID — request-scoped service profile fallback

Unit: `260827_kiro_builder_id_profile` · work-phase `wp1` · opened 2026-08-27

## Symptom

A Kiro request routed to the Builder ID account fails before any tokens are
generated:

```text
Provider error 400: kiro_profile_required: Kiro requires a CodeWhisperer
profileArn for this account and model. Re-login or re-import the matching Kiro
account (ocx account login kiro --reauth) so the profile is captured, then retry.
```

## Why the current remediation cannot work

The message tells the operator to re-login so the profile is captured. For an
AWS Builder ID account there is nothing to capture. Builder ID is a personal
identity that is not attached to an AWS account, so AWS never mints an
account-scoped `arn:aws:codewhisperer:<region>:<account-id>:profile/<id>` for
it. Re-running `ocx account login kiro --reauth` produces the same credential
shape it produced before, and the operator loops.

Confirmed against a live `~/.opencodex/auth.json` holding two Kiro accounts.
Account identifiers and addresses are deliberately omitted; only the
credential *shape* is load-bearing here:

| account | source | `kiro.profileArn` | `kiro.clientId`/`clientSecret` |
|---|---|---|---|
| A (browser OAuth login) | `oauth` | present | absent |
| B (imported CLI session) | `local-cli` | **absent** | **present** |

Account B is the failing one, and the presence of `clientId` +
`clientSecret` with no profile ARN is exactly the AWS SSO OIDC / Builder ID
shape. `src/oauth/kiro-credentials.ts:297` already derives
`authType: clientId && clientSecret ? "aws_sso_oidc" : "kiro_desktop"` from
that same pair, so the signal exists — it just never reaches the adapter.

## Mechanism

`src/adapters/kiro.ts` `build()`:

```ts
const resolvedProfileArn = resolveKiroProfileArn(parsed._kiroAuthContext);
const isApiKey = provider.apiKey.trim().startsWith("ksk_");
const profileArn = isApiKey ? undefined : resolvedProfileArn;
const wireClient: KiroWireClient = isApiKey || !profileArn ? "cli" : "ide";
...
if (profileArn) headers["x-amzn-kiro-profile-arn"] = profileArn;
const built = buildKiroPayload(parsed, profileArn, forcedCompletionMode, wireClient);
```

`resolveKiroProfileArn` returns `account.profileArn` verbatim when an account
context is present (`src/oauth/kiro.ts:469`). For the Builder ID account that is
`undefined`, so the request goes out on the `cli` wire path with **no**
`profileArn` in the payload and **no** `x-amzn-kiro-profile-arn` header. Gated
models answer with a `ValidationException` naming `profileArn`, and
`src/adapters/kiro-errors.ts:112` maps that to the stable non-retryable
`kiro_profile_required` code. The classifier is doing its job; the request was
simply incomplete.

## What the reference implementation does

`minpeter/kiro-lb` hit the same wall and resolved it by observing what the real
Kiro CLI sends. `kiro/config.py`:

```python
# Builder ID management and generation requests in Kiro CLI 2.19.1 carry this
# service profile even though the local credential has no account-specific ARN.
# Keep it request-scoped: it is not persisted as the account's own profile.
KIRO_BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX"
```

`kiro/auth.py` exposes it as a derived request-time property, never as the
account's stored identity:

```python
@property
def request_profile_arn(self) -> Optional[str]:
    if self._profile_arn:
        return self._profile_arn
    if self._auth_type == AuthType.AWS_SSO_OIDC:
        return KIRO_BUILDER_ID_PROFILE_ARN
    return None
```

The account ARN stays authoritative; the service profile is a shared,
non-account-scoped constant that the vendor client itself carries. The account
id `638616132270` is Amazon's, not the user's — nothing account-identifying is
being invented, which is the distinction `#993` cared about when it added
`parseKiroProfileArn` and refused to synthesize ARNs.

## Design

Mirror the reference split: **stored identity** vs **request-scoped routing
value**. The fallback must never become the former.

1. **Carry the auth-type signal to the adapter.** `parsed._kiroAuthContext` is
   `Pick<KiroOAuthMetadata, "profileArn" | "apiRegion" | "ssoRegion">`
   (`src/types/request.ts:91`). Widen the routing subset with an explicit
   `authType?: KiroAuthType` rather than letting the adapter infer Builder ID
   from a missing ARN. Inference-by-absence would also catch a
   `kiro_desktop` credential whose import merely failed, and that account
   should keep failing loudly instead of silently borrowing a service profile.
   `src/oauth/index.ts` `accessSnapshot` derives it from the same
   `clientId && clientSecret` pair the credential loader already uses, and
   propagates it through the three `parsed._kiroAuthContext` assignments in
   `src/server/responses/core.ts`.

2. **Resolve the fallback in one place.** Add
   `KIRO_BUILDER_ID_SERVICE_PROFILE_ARN` to `src/adapters/kiro-constants.ts`
   and a `resolveKiroRequestProfileArn(account)` helper next to the existing
   `resolveKiroProfileArn` in `src/oauth/kiro.ts`. The existing resolver keeps
   its current contract — callers that want the account's own ARN keep getting
   `undefined` — so region inference and account matching are untouched.

3. **Use it at request build time only.** `build()` swaps
   `resolveKiroProfileArn` for `resolveKiroRequestProfileArn`. Because the
   Builder ID account now has a profile, guard the wire-path selection so it
   stays `cli`: Builder ID is a CLI-shaped credential and the `ide` envelope is
   for enterprise profiles. This is the one place where "has a profileArn" and
   "is enterprise" stop being synonyms, and conflating them would silently move
   the account onto a different request shape than the vendor client uses.

4. **Keep API keys unchanged.** `ksk_` still forces `profileArn = undefined`.

### Non-persistence

The fallback is computed per request from a constant. It is never written by
`saveAccountCredential`, never enters `KiroOAuthMetadata`, and never reaches
`inferRegionFromProfileArn`, which matters because the constant is
`us-east-1`-scoped and would otherwise pin a Builder ID account's region to
`us-east-1` regardless of its own `ssoRegion`. `resolveKiroApiRegion` reads
`account.profileArn` directly, so leaving that resolver alone is what
preserves correct region behavior.

One consequence to accept deliberately:
`providerContinuationDestinationIdentity` (`src/server/responses/core.ts:438`)
hashes `kiroContext?.profileArn`. It keeps reading the stored value, so two
Builder ID accounts do not collapse into one continuation scope.

## Verification

The regression suite is `tests/kiro-builder-id-profile.test.ts`, kept separate
from `tests/kiro-adapter.test.ts` so the Builder ID contract reads as one story
rather than as scattered cases in the general adapter suite.

- Builder ID context yields the service ARN in both the payload and the header,
  and stays on the `cli` wire path.
- Regression — enterprise account with its own ARN keeps that ARN and the `ide`
  path; `ksk_` keeps sending no profile.
- Regression — a `kiro_desktop` account without an ARN still sends none, so the
  actionable failure survives for genuinely broken imports.
- Regression — the accountless path, where the auth type comes from the local
  CLI import rather than the request context, still sends the fallback inside
  the `cli` envelope. Driven red against the earlier context-derived guard
  before being accepted.
- Non-persistence asserted against the raw on-disk store, not a parsed view.
- `bun run typecheck` and `bun run privacy:scan`.
- Live: make the Builder ID account (B above) the active Kiro account, restart
  the service so the proxy loads this tree, and capture a real completion.

## Out of scope

`src/lab/`, routing profiles, other providers, credential rotation, any push or
GitHub mutation.
