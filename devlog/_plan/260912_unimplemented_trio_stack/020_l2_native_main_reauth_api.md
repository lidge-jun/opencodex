# L2: native-main device reauth API/CLI (#3898)

Class C4 (auth boundary). Stack layer 2, base the L1 branch. Branch
`codex/260912-native-main-reauth-api`. Adopts the accepted Accounts-lane
design devlog/_plan/260912_accounts/080_reauth_api.md; this doc is the
diff-level revalidation of that draft against current `dev` plus the
deltas the code map surfaced. 080 remains the contract source; anything
here overrides stale details of 080, not its invariants.

## Problem

Headless hub (`runtimeRole=hub`, `oauthOpenBrowser: false`, no codex
binary, no keyring) cannot reauth native `__main__`:
`/api/codex-auth/login` is pool-only and rejects `__main__`
(src/codex/account-id.ts:15-20; src/codex/auth-api.ts:2733-2748);
`ocx account main add` requires official `codex login` + OS keyring
(src/cli/account-main.ts:73-90,214-260). WHAM `token_revoked` on the main
grant is then unrecoverable from the hub.

## Changes (080 contract, revalidated)

MODIFY `src/oauth/chatgpt-device.ts`
- Factor the private grant exchange so a native-only result retains the
  raw validated token payload: new `loginChatGPTNativeDevice` returns
  `{ credential, idToken }` in-process only; reject missing
  access/refresh/id token or mismatched account identity. Existing
  `loginChatGPTDevice` behavior unchanged (still projects
  OAuthCredentials, no id_token).
- Delta from 080 (explorer-confirmed gap): the usercode/poll/token fetches
  (84-90, 121-127, 152-163) have no per-request timeout — only the 15-min
  poll deadline and abort. Add a service-owned per-fetch deadline (fetch +
  body) so a stuck TCP cannot hold the flow until TTL. This is the Kuhn
  blocker "poll timer does not bound fetch/body deadlines".
  Audit-folded: one FRESH 30s timeout per fetch attempt inside the poll
  loop (AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]), the
  main-account.ts:239-241 pattern) — a single 30s signal across the whole
  poll would kill the 15-minute grant. Abort-timeout maps to
  device_authorization_failed. The shared helper also bounds hung POOL
  device logins at 30s per fetch — an intended improvement, called out in
  the PR.

MODIFY `src/codex/main-account.ts`
- New `beginNativeMainReauth`: captures the existing
  `MainAuthJsonCredential` snapshot (103-136) into a private closure;
  returned commit accepts complete native device tokens and, only after
  human authorization, acquires `withNativeMainExclusiveClaim`
  (src/codex/native-main-claim.ts:167), rechecks recovery/admission fence,
  asserts original path/hash/inode before atomic rename, requires same
  chatgpt account identity, writes access+refresh+id token + account_id
  together, advances the mutation epoch, and reconciles runtime/quota
  state. Old identity token is never retained beside new credentials. No
  claim held during human polling.
  Audit-folded: do NOT reuse persistRefreshedMainAuthJson (:190-195) — it
  spreads expected.tokens and never writes id_token, so the old identity
  token would survive beside the new grant. The commit uses a SIBLING
  persist that sets access_token/refresh_token/id_token/account_id
  together and overwrites any prior id_token (adding the key is safe:
  readMainAuthJsonCredential :122 tolerates it and
  native-profile-store.ts:476-481 expects it).

NEW `src/codex/main-device-reauth.ts`
- One process-owned active flow (opaque UUID, AbortController, bounded
  terminal retention 5 min, grant deadline 15 min). Start/status/cancel
  return only flowId, status, verificationUrl, deviceCode, and closed safe
  failure codes per the 080 `MainDeviceReauthStatus` union. Injectable
  login/commit dependencies for tests. Superseded/cancelled completions
  never publish. No tokens/emails/raw account ids in DTO/log/error.
- Dedicated abort controller and direct `loginChatGPTNativeDevice` call:
  MUST NOT use `startLoginFlow("chatgpt")` (would overwrite the chatgpt
  scratch slot and 409 against pool logins, src/oauth/index.ts:1899-1973).

NEW `src/codex/main-device-reauth-api.ts`
- `POST/GET/DELETE /api/codex-auth/main/reauth-device` with exact opaque
  flow query, strict request keys, safe 400/404/409. Registered at the
  management dispatch boundary (src/server/management-api.ts:385-407
  region); existing management auth/origin/session controls stay
  authoritative. No CLI direct account-file write.

MODIFY `src/cli/account-main.ts`
- `ocx account main reauth --device [--no-wait]`,
  `reauth status --flow <id>`, `reauth cancel --flow <id>` via the
  management API; reject extra args before start. Register capability/help;
  regenerate skill surface with `bun run skill:surface` if the capability
  registry changes (tests/ci-workflows/skill-ocx.test.ts gates this).
  Audit-folded: the native-main CLI branch point is account-main.ts (:181
  region, beside add/switch) with USAGE in src/cli/account.ts:64; the
  management route-registry (src/server/management/route-registry.ts
  MANAGEMENT_ROUTES) must gain the POST/GET/DELETE rows or
  management-route-registry.test.ts and the capabilities ratchet go red —
  do NOT grow UNDECLARED_ROUTES_2026_08_28.

## Hub fence resolution (open decision 1, resolved here for audit)

On a headless hub the native owner lifecycle is a no-op
(src/server/index.ts:1026-1046 binds the no-op when
`shouldSyncCodexOnStart` is false; the gate is composed at
src/codex/desired-state.ts:130 — :79-81 is `localClientSyncAllowed`).
The reauth commit therefore MUST NOT depend on owner activation and MUST
NOT widen `shouldSyncCodexOnStart` (that gate covers client-config sync,
not credential rewrite).

Audit-folded correction to 080: 080's `assertNativeMainOwner` at
preparation/commit is RETRACTED for this layer. That assert throws without
a held owner entry (src/codex/native-main-owner.ts:302-314), which would
make hub reauth always fail. The exclusive claim is owner-independent
(src/codex/native-main-claim.ts:167, FS/SQLite lock only). The fence is
pinned to: `withNativeMainExclusiveClaim` + in-process admission fence +
path/hash/inode assertion + recovery/admission snapshot recheck, exactly
as on workstations. Only claim/admission failure maps to
`native_main_unavailable`; no write occurs without the full fence — an
unfenced write is a C4 violation, not a fallback.

## Tests (red-first; domain tests/codex-integration, tests/oauth, tests/cli)

NEW `tests/codex-integration/main-device-reauth.test.ts` — same-account
success without codex/keyring; wrong identity refused; missing token
fields; cancelled/superseded late result cannot publish; concurrent file
replace/refresh/profile switch; atomic write failure; claim unavailable →
native_main_unavailable with zero writes; no pool-row mutation; DTO/log
secret scan.
NEW `tests/codex-integration/main-device-reauth-api.test.ts` — route
contract: strict keys, 400/404/409 shapes, unauthorized rejected,
`__main__` still refused by `/api/codex-auth/login`.
MODIFY `tests/oauth/chatgpt-device-auth.test.ts` — native result retains
idToken in-process; per-fetch deadline fires on a hung stub fetch.
Audit-folded: native-main CLI tests land in
tests/cli/cli-native-profile.test.ts (native-main CLI); the pool
cli-account.test.ts keeps only the __main__ login rejection cases.
MODIFY `tests/cli/cli-native-profile.test.ts` — reauth --device surface,
status, cancel, arg rejection.
All NEW files: layout.json explicit + expected-fixture entries.

## Docs / ownership

structure/ ownership docs for src/codex, src/oauth, src/cli, src/server
synced in this PR (structure:check must stay green). Headless recovery
instructions updated (docs-site) in the same PR. Security draft stays in
scratch; only the implementation + regression diff is published.
