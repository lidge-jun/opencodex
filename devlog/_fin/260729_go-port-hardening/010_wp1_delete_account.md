# 010 — WP1: deleting a pool account that lost its credential

## Symptom

Against the live dogfood binary on :10100:

```
GET /api/codex-auth/accounts
  chatgpt-1784255170365  hasCredential=false  needsReauth=true  health=refresh_failed

DELETE /api/codex-auth/accounts?id=chatgpt-1784255170365
  404 {"error":"Account not found"}
```

The account's own `healthSummary` says "reauthentication required ... Next: reauthenticate
via the dashboard Codex account pool". Until `abb4dbc32` landed, reauth could not present a
different identity either, so this account was unreachable from both directions: it could
not be repaired and it could not be removed. Editing `config.json` by hand was the only exit.

## Root cause

`go/internal/cli/codex_auth_management.go:254` decides whether the account exists using only
the credential store:

```go
removed, err := m.store.RemoveAccount(ctx, "openai", id)
if err != nil {
    return err
}
if !removed {
    return &management.BackendError{Status: http.StatusNotFound, Message: "Account not found"}
}
```

`RemoveAccount` (`go/internal/oauth/store_accounts.go:72`) reports whether a credential row
was deleted from `auth.json`. But a pool account has two halves: the credential row and the
`config.CodexAccounts` entry. A failed refresh drops the credential and leaves the config
entry, so `removed` is false while the account is still very much present — it is listed by
`ListCodexAccounts`, which merges both sources (`codex_auth_management.go:83`).

The oracle never makes this judgement. `src/codex/account-lifecycle.ts:46`:

```ts
export function deleteCodexAccount(runtimeConfig: OcxConfig, accountId: string): void {
  removeCodexAccountCredential(accountId);
  runtimeConfig.codexAccounts = (runtimeConfig.codexAccounts ?? []).filter(a => a.id !== accountId);
  ...
}
```

and `src/codex/auth-api.ts:565` returns `{ok:true}` unconditionally. The 404 branch is new
in the port, and it reads the wrong half of the account.

## MODIFY map

### MODIFY `go/internal/cli/codex_auth_management.go` — `DeleteCodexAccount`

Establish existence from either half before acting on the credential store.

Before:

```go
	credential, credentialFound, credentialErr := m.store.GetAccountCredential("openai", id)
	if credentialErr != nil {
		return credentialErr
	}
	removed, err := m.store.RemoveAccount(ctx, "openai", id)
	if err != nil {
		return err
	}
	if !removed {
		return &management.BackendError{Status: http.StatusNotFound, Message: "Account not found"}
	}
```

After:

```go
	credential, credentialFound, credentialErr := m.store.GetAccountCredential("openai", id)
	if credentialErr != nil {
		return credentialErr
	}
	// A pool account is a credential row plus a config entry, and a failed refresh
	// drops the credential while keeping the entry. Deciding existence from the
	// credential alone 404s exactly the accounts the dashboard tells the user to
	// remove and re-add.
	m.mu.Lock()
	configured := false
	for _, account := range m.config.CodexAccounts {
		if account.ID == id {
			configured = true
			break
		}
	}
	m.mu.Unlock()
	removed, err := m.store.RemoveAccount(ctx, "openai", id)
	if err != nil {
		return err
	}
	if !removed && !configured {
		return &management.BackendError{Status: http.StatusNotFound, Message: "Account not found"}
	}
```

Deliberately unchanged: the `__main__` 400 guard above, the `persistence.Update` block that
strips the config entry and clears `ActiveCodexAccountID`, the credential-restore rollback
when persistence fails, and `quota.Clear(id)`. The config-entry removal already runs through
`persistence.Update` regardless of the credential, so no second write path is needed.

The `m.mu` scan mirrors `StartCodexLogin` (`codex_auth_management.go:428`), which resolves
`configured` the same way. No new helper: two call sites do not justify one, and the existing
one is inline.

## TESTS

### MODIFY `go/internal/cli/management_backends_test.go`

Add `TestDeleteCodexAccountRemovesAConfiguredAccountWhoseCredentialIsGone`, modeled on the
existing delete assertion at `:130` and the fixture shape at `:40-52`.

- Arrange: `config.FreshInstall()` plus a `config.CodexAccount{ID: "stale"}` written to the
  config, and an `oauth.CredentialStore` that never stored `stale` — the on-disk state of an
  account whose refresh failed.
- Act: `callCLIManagement(t, api, http.MethodDelete, "/api/codex-auth/accounts?id=stale", nil)`.
- Assert: `200`, and `cfg.CodexAccounts` is empty afterwards.
- Assert the guard survives: a second DELETE for `id=ghost` (in neither store nor config)
  still returns `404`.

Existing coverage that must stay green: `management_backends_test.go:130` (delete with a
credential present -> 200 and the credential set is gone) and the `__main__` 400 case in
`go/internal/management/codex_auth_test.go`.

## Verification (C)

| Command | Expected |
|---|---|
| `cd go && go build ./...` | exit 0 |
| `cd go && go test ./internal/cli/... ./internal/management/...` | exit 0, 0 failures |
| rebuild dogfood binary, then `DELETE /api/codex-auth/accounts?id=chatgpt-1784255170365` | `200 {"ok":true}` |
| follow-up `GET /api/codex-auth/accounts` | the id is absent |

The live recheck is the criterion that matters (c1): the account in question is real state on
this machine, and removing it is what the user asked for.
