# 40 - Phase 4: Manual Import Identity

Status: implementation-ready plan.

## Objective

Manual token import must not let user-provided labels, emails, or unverified JWT payloads define account identity.

## Planned Changes

### Short-Term Safe Default

Disable manual import by default until authoritative identity validation is implemented.

Options:

- GUI hides token fields unless an explicit advanced/unsafe setting is enabled.
- API rejects `POST /api/codex-auth/accounts` manual token import unless `allowUnsafeManualCodexImport` is true.

### MODIFY `src/oauth/chatgpt.ts`

Separate identity concepts:

- `workspaceAccountId`
- `userPrincipalId`
- `displayEmail`
- `localAlias`

Decoded JWT claims are hints only. They need confirmation from an authenticated upstream endpoint before storage.

### MODIFY `src/codex-auth-collision.ts`

Collision identity:

- same verified user principal + workspace = duplicate;
- same workspace + different verified user principal = allowed;
- same refresh-token fingerprint = duplicate grant, blocked.

### MODIFY `src/codex-auth-api.ts`

Manual import flow:

1. reject existing local alias before credential write;
2. validate identity through an authenticated request;
3. compute refresh-token fingerprint;
4. reject duplicate grant;
5. store verified identity metadata separately from display email.

OAuth login flow:

- keep existing stronger checks;
- adopt same identity metadata shape for consistency.

### MODIFY `gui/src/components/AddCodexAccountModal.tsx`

Remove or gate manual token entry. Copy should make OAuth login the normal path.

## Tests

Add/update:

- `tests/codex-auth-collision.test.ts`
- `tests/codex-auth-api.test.ts`
- `tests/chatgpt-oauth.test.ts`

Required cases:

- manual import disabled by default;
- existing alias rejected before write;
- same refresh grant blocked;
- same verified `userPrincipalId` plus same `workspaceAccountId` with different local alias/display email rejected before credential write, leaving existing credential and metadata unchanged;
- same workspace different user principal accepted;
- decoded JWT-only fabricated identity not authoritative.

## Verification

```bash
bun test tests/codex-auth-collision.test.ts tests/codex-auth-api.test.ts tests/chatgpt-oauth.test.ts
cd gui && bun run build
```
