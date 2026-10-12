# Delivery record

The Muse Code device-authorization login is implemented, tested and committed locally on
`codex/260912-meta-muse-device-oauth` in worktree `/Users/jun/.codex/worktrees/m9d2/opencodex`.
Nothing is pushed, and nothing has been exercised against Meta. A reader who was not in the
loop needs three things from this page: what changed, what proves it, and what is still open.

## What changed

| File | Change |
|---|---|
| `src/oauth/meta-muse-device.ts` | NEW. The OIDC device grant, the RFC 8628 poll, the key mint, and a twelve-kind error taxonomy |
| `src/oauth/types.ts` | `MuseOAuthMetadata` and the `muse` field on `OAuthCredentials` |
| `src/oauth/store.ts` | `normalizeCredential` learns that field, without which it is dropped on persist |
| `src/oauth/meta-muse.ts` | Selection order, `importFromKeychain`, the composed no-paste refusal, refresh preservation |
| `src/oauth/index.ts` | `forceLogin` maps to skipping the import |
| `src/providers/registry.ts` | `staticHeaders` for `x-api-version`, and a rewritten note |
| `src/providers/muse-key-quota.ts` | NEW. The on-demand quota probe, rate-limited on both outcomes |
| `src/providers/muse-subscription-usage.ts` | The window mapper is now shared with that probe |
| `src/providers/quota.ts` | `fetchMuseKeyQuota` and a probe-then-passive dispatch |
| `tests/providers/meta-muse-device.test.ts` | NEW, 36 tests |
| `tests/providers/meta-muse-login-order.test.ts` | NEW, 17 tests |
| `tests/providers/muse-key-quota.test.ts` | NEW, 16 tests |

## What proves it

```
bun run test <12 files>   204 pass, 0 fail
bun run typecheck          exit 0
bun run privacy:scan       passed
```

`tests/providers/meta-muse-oauth.test.ts` passes UNMODIFIED, which was the load-bearing
no-regression claim. Two guards are worth naming because they protect failures that produce
no error of their own: the store round-trip test fails if the `normalizeCredential` block is
removed, and the separation test fails if anyone packs the account token into the bearer.

## The five things that were wrong before they shipped

Every one was caught by an audit rather than by a compiler, and each is now guarded.

1. The `muse` field was scheduled one work-phase after the module that returns it, so wp2
   would not have compiled.
2. `normalizeCredential` rebuilds credentials field by field, so the account token would
   have been dropped on persist while the login still looked successful.
3. Keying the slot on `user_id` would have given an existing imported user a second account.
4. A sleep ending exactly at the deadline skipped the final poll, and a 200 carrying a token
   was discarded because a local clock disagreed with the server that issued it.
5. The success TTL was not atomic, so two forced callers could spend two mints in one window.

## Still open

1. **No live verification.** Every endpoint contract is second-party, from `001`. The first
   real device login should be run by the repository owner on his own account and recorded
   as a new 000-range measurement.
2. **No push.** Delivery stops at local commits; a push or PR needs explicit authorization.
3. **Dispatcher-level forced-refresh test.** Enforcement lives entirely inside
   `fetchMuseKeyQuotaSnapshot`, which takes no force parameter, and the TTL plus the
   in-flight gate are unit-tested there. A test that drives it through
   `maybeFetchProviderQuota` with `forceRefresh` would add an integration-level guard.
4. **Automatic remint on a 401.** We now hold the account token, so an expired key could be
   re-minted in place instead of forcing a re-login. Touches shared refresh and failover.
5. **`x-api-version` for `meta-model`.** Same base URL, different credential class.
6. **Shared CLI device-code rendering.** `src/oauth/login-cli.ts:97-106` ignores `deviceCode`
   and always opens a browser; fixing it helps every device provider, which is why it does
   not belong to a single-provider unit.

## Posture, unchanged

None of `020_wp2_device_oauth.md`'s four first-party reopen conditions has been met. Meta
still scopes the credential to its own client. The provider stays HIGH_RISK in
`gui/src/oauth-tos-risk.ts`, its refresh policy stays `disabled`, the consent warning fires
before anything is read, and both the warning and the registry note now say plainly that a
device login authenticates as Meta's own client and has not been exercised from OpenCodex.
