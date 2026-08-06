# 110 — Issue #993: Kiro profileArn 400 for Builder ID accounts

Independent lane. Research: explorer batch G (incl. external Kiro/AWS
evidence).

## Verified current state

- `createKiroAdapter()` resolves an optional ARN, omits it when absent,
  selects CLI wire: `src/adapters/kiro.ts:1695,1723-1754`.
- `resolveKiroProfileArn()` reads account metadata / accountless env /
  imported CLI state only: `src/oauth/kiro.ts:425`. CLI SQLite import checks
  `api.codewhisperer.profile`: `src/oauth/kiro-credentials.ts:282-303,347-356`.
- `kiro-cli whoami --format json` is the documented introspection surface
  (schema undocumented). No verified safe formula or public Builder-ID
  lookup API exists. Never hardcode an ARN, derive from undocumented token
  claims, borrow another account's metadata, or auto-pick from an
  administrative profile list.
- Generic Kiro 400s → `invalid_request_error` with raw detail but no stable
  actionable code: `src/adapters/kiro-errors.ts:95-151`.

## Diff-level plan

MODIFY `src/oauth/kiro.ts`:
- Extend `readKiroCliIdentity()` (`:175-185`) to return
  `{email?, profileArn?}`; parse only documented `whoami --format json`
  shapes (`profileArn`, `profile_arn`, `profile.arn`); validate length +
  `arn:<partition>:codewhisperer:<region>:<account>:profile/<id>` structure.
- `oauthCredentialFromImported()` (`:249-264`):
  `resolvedProfileArn = imported.profileArn ?? identity.profileArn` →
  `credential.kiro.profileArn` + `accountId`. Account-safe: `whoami` runs
  against the same active CLI session just imported. Fail closed when
  absent.

MODIFY `src/adapters/kiro-errors.ts` — before the generic validation branch,
recognize evidence containing both `profilearn` and `required` → status 400,
`invalid_request_error`, stable code `kiro_profile_required`, non-retryable,
actionable redacted message (re-login/re-import the matching account).

No `src/adapters/kiro.ts` change (it already sends a resolved ARN in header
+ payload).

MODIFY `tests/kiro-oauth.test.ts` (whoami parsing + persistence),
`tests/kiro-retry.test.ts` (400 classification), `tests/kiro-stream.test.ts`
(event-stream ValidationException classification).

## Tests / activation

Activation: import active CLI credential → SQLite lacks ARN → `whoami`
exposes a valid ARN for that session → persisted account-scoped → adapter
sends `x-amzn-kiro-profile-arn` + payload `profileArn`.

Matrix (fake CLI runner, no AWS): valid top-level/nested shapes;
malformed/wrong-service/oversized ARN ignored; imported SQLite ARN wins;
whoami failure/no ARN → login still usable for ungated models; no
cross-account borrowing; `ksk_...` API-key path still omits; exact upstream
"profileArn is required" → `kiro_profile_required`, no retry, no leakage;
unrelated ValidationException → existing behavior; enterprise ARN paths
unchanged.

## Risks / limitations

- whoami JSON schema undocumented — discovery optional, fail closed.
- Builder ID may expose only a username — then gated models still fail and
  the improved error is the safe terminal behavior.
- No live Kiro/AWS verification — PR body states this.

## Accept criteria

- Structural matrix green; gates as 030.
