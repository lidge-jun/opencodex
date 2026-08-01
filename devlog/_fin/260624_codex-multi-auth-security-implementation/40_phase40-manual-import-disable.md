# 40 - Phase 40 Plan: Disable Unverified Manual Codex Import

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Implement Patch 4 from `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` in a bounded first slice:

- disable `auth.json` / raw-token manual Codex account import by default;
- keep OAuth login as the supported account-add path;
- prevent any manual import attempt from overwriting an existing local alias before identity can be verified authoritatively;
- remove the manual import control from the default GUI flow so deployable UI does not invite unsafe token pasting;
- preserve test coverage for account listing, quota refresh, duplicate detection helpers, and OAuth duplicate-id prechecks without relying on the manual import endpoint as a fixture.

This phase does not implement an authoritative upstream identity validation flow for manual import. A future replacement operation can reintroduce manual import only after the server validates identity against an authenticated upstream response and separates local alias from verified principal/workspace identity.

## Security Basis

- Manual import currently accepts caller-controlled alias, email, tokens, and `chatgptAccountId`. `decodeJwtPayload()` only decodes JSON and does not verify signature, issuer, audience, expiry, or token type.
- A refresh token is a credential, not an identity proof. RFC 9700 describes refresh-token replay/rotation risks and recommends sender-constraining or rotation/replay detection for public clients. Allowing one raw refresh credential to be pasted into multiple local aliases undermines that boundary.
- The OAuth login path is materially safer in this codebase because it gets the account identity from the OAuth store, rejects an existing local alias before writing, checks account-id collision, and attempts authenticated usage lookup before saving.

External reference checked:

- RFC 9700, OAuth 2.0 Security Best Current Practice: `https://datatracker.ietf.org/doc/rfc9700/`

## Acceptance Criteria

- `POST /api/codex-auth/accounts` returns a clear 403 by default before writing any credential or config metadata.
- Disabled manual import still parses no credentials and creates no `codex-accounts.json` token record.
- An explicit env escape hatch exists only for local migration/debug work:
  - `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1`;
  - still rejects an existing local alias before credential write;
  - still rejects oversized tokens and invalid account id format;
  - still runs current account-id collision checks.
- GUI default add-account modal exposes OAuth login only; no raw token import button or raw-token text area is reachable in the normal build.
- Existing OAuth login endpoint behavior remains unchanged.
- Existing account-list/quota tests seed the credential store directly rather than using the unsafe manual import route as a fixture.
- Duplicate helper tests cover team-member shared account id behavior by direct store/config setup, not by manual import.
- Full local gates pass: focused tests, `bun run typecheck`, `bun test tests`, `cd gui && bun run build`, `git diff --check`.

## Threat Model

What we protect:

- stored ChatGPT/Codex pool refresh tokens;
- account-to-credential mapping;
- quota/billing/audit attribution;
- user emails and plan metadata already covered by Phase 30 masking.

Attacker:

- anyone with access to the local management API or GUI;
- a malicious local process on the same host;
- a remote caller if the server is explicitly bound non-loopback and authenticated but misused by an operator.

Trust boundary:

- Browser/management client to opencodex API.

Blast radius:

- wrong account selected for future requests;
- duplicate aliases sharing one rotating refresh grant;
- existing alias metadata paired with different credentials;
- quota and audit logs no longer matching the actual identity.

## File Plan

### MODIFY `src/codex-auth-api.ts`

Add helpers near `ACCOUNT_ID_RE`:

```ts
const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";

export function isUnverifiedCodexImportEnabled(): boolean {
  return process.env[MANUAL_IMPORT_ENV] === "1";
}

function manualImportDisabledResponse(): Response {
  return jsonResponse({
    error: "Manual Codex account import is disabled. Use OAuth login to add a pool account.",
    code: "manual_import_disabled",
  }, 403);
}
```

Change `POST /api/codex-auth/accounts`:

- keep invalid JSON and missing-field validation only after the feature gate if the gate is enabled;
- when `isUnverifiedCodexImportEnabled()` is false, return `manualImportDisabledResponse()` immediately and do not parse or persist tokens;
- when enabled:
  - parse body;
  - validate required fields, id format, and token length;
  - load runtime config;
  - reject if `(runtimeConfig.codexAccounts ?? []).some(a => a.id === body.id)` or `getCodexAccountCredential(body.id)` before deriving identity or writing credentials;
  - duplicate local alias rejection returns HTTP 400 with `error: "Account id already exists: ${body.id}"`, matching the OAuth duplicate-id wording;
  - keep existing derived-account-id collision check;
  - save credential only after all validation passes;
  - then append metadata and save runtime config.

Do not change `/api/codex-auth/login`; OAuth remains the default account-add path.

### MODIFY `gui/src/components/AddCodexAccountModal.tsx`

Remove the manual import branch from the default UI:

- delete `IconKey` import;
- delete `IconX` import if no other branch uses it after the import header is removed;
- delete `step === "import"` state branch and `handleImport`;
- simplify `step` type to `"pick" | "oauth-waiting"`;
- remove `json` and `saving` state;
- remove the "Import auth.json" list-row from the pick screen;
- keep copy-login-link behavior and popup-close cancellation unchanged.

This is intentionally stricter than showing a disabled import button: the deployable UI should not suggest raw-token handling as a normal workflow.

### MODIFY `gui/src/i18n/en.ts`

Keep existing import strings for now if other historical code references them; no new strings are required.

### MODIFY `gui/src/i18n/ko.ts`

Keep existing import strings for now if other historical code references them; no new strings are required.

### MODIFY `gui/src/i18n/zh.ts`

Keep existing import strings for now if other historical code references them; no new strings are required.

### MODIFY `tests/codex-auth-api.test.ts`

Add helpers:

```ts
const MANUAL_IMPORT_ENV = "OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT";

function seedPoolAccount(
  config: OcxConfig,
  account: { id: string; email: string; plan?: string; accessToken?: string; refreshToken?: string; chatgptAccountId?: string; expiresAt?: number },
): void {
  config.codexAccounts = [...(config.codexAccounts ?? []), {
    id: account.id,
    email: account.email,
    plan: account.plan,
    isMain: false,
  }];
  saveCodexAccountCredential(account.id, {
    accessToken: account.accessToken ?? `access-${account.id}`,
    refreshToken: account.refreshToken ?? `refresh-${account.id}`,
    expiresAt: account.expiresAt ?? Date.now() + 5 * 60_000,
    chatgptAccountId: account.chatgptAccountId ?? `acct-${account.id}`,
  });
}
```

Update environment cleanup:

- save/restore previous `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT`;
- delete it in `beforeEach`.

Add tests:

- disabled `POST /api/codex-auth/accounts` returns 403 with `code: "manual_import_disabled"`;
- disabled manual import does not write credentials;
- default-disabled validation behavior is intentional: POST does not parse body before feature gate and invalid JSON/missing fields/invalid id/oversized token requests all return 403 until the env escape hatch is enabled;
- env-enabled manual import preserves existing validation:
  - missing fields returns 400;
  - oversized input returns 400;
  - invalid id format returns 400;
  - invalid JSON returns 400;
- env-enabled manual import rejects duplicate runtime config alias before overwrite;
- env-enabled manual import rejects duplicate credential alias before overwrite;
- env-enabled manual import can still import a non-duplicate local test account for migration/debug compatibility.

Refactor existing account-list/quota/login-status tests that currently create accounts through `POST /api/codex-auth/accounts`:

- create runtime config objects with pool entries directly;
- call `saveCodexAccountCredential()` for token fixtures;
- pass the seeded runtime config object into the later `GET`/status calls whenever the handler must see in-memory `codexAccounts`;
- if a test intentionally calls the handler with `{} as any`, first persist config with `saveConfig(config)` because `getRuntimeConfig({} as any)` falls back to `loadConfig()`;
- keep route assertions focused on account-list/quota/login-status behavior.

Tests to update:

- `POST /api/codex-auth/accounts rejects missing fields`;
- `POST /api/codex-auth/accounts rejects oversized input`;
- `POST /api/codex-auth/accounts rejects invalid id format`;
- `POST /api/codex-auth/accounts rejects invalid JSON`;
- `GET /api/codex-auth/accounts fetches pool quota when cache is empty`;
- `GET /api/codex-auth/accounts refresh=1 bypasses cached pool quota`;
- `GET /api/codex-auth/login-status recovers done when a persisted account exists`;
- `POST /api/codex-auth/login rejects duplicate account id before OAuth starts`;
- `GET /api/codex-auth/accounts reuses cached pool quota without fetching usage`.

### MODIFY `tests/codex-auth-collision.test.ts`

Stop using manual import as a duplicate/collision fixture.

Use direct setup:

```ts
function seedAccount(id: string, email: string, chatgptAccountId: string): OcxConfig {
  const config = { port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [{ id, email, isMain: false }] };
  saveConfig(config);
  saveCodexAccountCredential(id, { accessToken, refreshToken, expiresAt, chatgptAccountId });
  return config;
}
```

Required imports:

- `saveConfig` from `../src/config`;
- `checkAccountIdCollision` from `../src/codex-auth-api` or `../src/codex-auth-collision`;
- `saveCodexAccountCredential` from `../src/codex-account-store`.

Assertions:

- `checkAccountIdCollision("shared-team-account", "member-b@example.test")` returns no collision when an existing pool account has the same ChatGPT account id but a different email;
- Correction 2026-06-27: `checkAccountIdCollision("shared-team-account", "MEMBER-A@example.test", "business")` returns no collision when the existing account is personal. Personal and workspace subscriptions are separate duplicate buckets because one user can legitimately hold both. Within the same bucket, the existing ChatGPT account id plus normalized email collision guard still applies.

### MODIFY `src/codex-auth-api.ts` OAuth wording

Change the OAuth path error that currently says `Try importing manually.` to a non-manual-import recovery message:

```ts
error: "Could not determine account identity from OAuth tokens. Please retry OAuth login.",
```

This keeps runtime behavior unchanged while avoiding a UI/server message that points users toward a disabled unsafe flow.

### OPTIONAL MODIFY `tests/gui-source.test.ts` if present

Only if an existing source-level GUI test asserts import UI text. Update it to assert the Add Account modal source no longer renders `importAuthJson`.

## Verification Plan

Focused gates:

```bash
bun test tests/codex-auth-api.test.ts tests/codex-auth-collision.test.ts
```

Full gates:

```bash
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

Independent verification:

- dispatch a read-only Backend/Security verifier after implementation to check that disabled manual import cannot persist credentials, OAuth path is preserved, and tests no longer depend on manual import as a fixture.

## Implementation Evidence

Changed files:

- `src/codex-auth-api.ts`
  - Added `OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT=1` escape hatch.
  - `POST /api/codex-auth/accounts` now returns `403 { code: "manual_import_disabled" }` by default before JSON parsing or credential writes.
  - Env-enabled manual import rejects existing runtime-config aliases and existing credential aliases before saving.
  - OAuth login path remains unchanged except the old “Try importing manually” recovery text now asks the user to retry OAuth login.
- `gui/src/components/AddCodexAccountModal.tsx`
  - Removed raw `auth.json` import state, textarea, POST call, and import button from the default add-account modal.
  - Preserved OAuth popup, copy-login-link, polling, cancellation, and close behavior.
- `tests/codex-auth-api.test.ts`
  - Added default-disabled manual import tests.
  - Added env-enabled validation/success/duplicate-alias tests.
  - Replaced manual POST fixtures with direct runtime-config and credential-store seeding.
- `tests/codex-auth-collision.test.ts`
  - Replaced manual POST fixtures with direct config/credential setup and direct `checkAccountIdCollision()` assertions.

## Verification Evidence

Local commands run on 2026-06-24:

```text
bun test tests/codex-auth-api.test.ts tests/codex-auth-collision.test.ts
40 pass, 0 fail

bun run typecheck
exit 0

bun test tests
289 pass, 0 fail

cd gui && bun run build
exit 0

git diff --check
exit 0
```

Independent read-only verifier:

```text
Backend verifier verdict: DONE

Confirmed:
- API manual import disabled by default before parse/write.
- Env escape hatch exists and duplicate alias rejection occurs before credential save.
- OAuth `/api/codex-auth/login` is preserved.
- AddCodexAccountModal no longer exposes raw auth.json/manual import UI.
- Tests no longer depend on manual POST fixtures except explicit env-enabled manual import tests.
- No personal account data, bearer JWT, or real full email was added.
- Verifier re-ran typecheck, full tests, focused tests, GUI build, and git diff --check successfully.
```

## Out Of Scope

- authoritative upstream validation for raw-token import;
- refresh-token fingerprint indexing across aliases;
- UI reveal/masked-email follow-up;
- outcome taxonomy and quota freshness work from later Patch 5;
- devlog PII scrubbing from later Patch 6.
