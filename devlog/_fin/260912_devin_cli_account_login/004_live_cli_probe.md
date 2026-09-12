# 004 — Live probe of the installed CLI

Devin CLI 3000.10.21 installed to `~/.local/bin/devin` and signed in, so the
guesses `001` recorded as unconfirmed are now measured. Everything below is
observed output, not documentation.

## `devin auth status`

Exists, non-interactive, exit 0 when signed in:

```
$ devin auth status
Logged in (via Devin).

Credentials:
  File:              /Users/jun/.local/share/devin/credentials.toml
  API server:        https://server.codeium.com
  Devin webapp:      https://app.devin.ai
  Devin API:         https://api.devin.ai
$ echo $?
0
```

Signed out, before login, it printed `Not logged in.` with the same credentials
path and a hint to run `devin auth login`.

**No `--json`.** `devin auth status --json` fails with
`error: unexpected argument '--json' found`. `010`'s probe must therefore parse
exit status plus the literal prefix `Logged in`, not a JSON field. Parsing prose
is fragile, so the probe treats exit 0 as authoritative and the prose only as a
tiebreaker, and the `010` test set gains a case for a future wording change.

## No identity to report

`credentials.toml` holds four keys and none of them is an account identity:

```
windsurf_api_key = <redacted>
api_server_url   = <redacted>
devin_webapp_host = <redacted>
devin_api_url    = <redacted>
```

Neither does `auth status`. So the credential this unit stores carries **no**
`email` and **no** `accountId`. Two consequences `020` must handle:

1. The Accounts row shows a signed-in state without an address. That is honest and
   matches what the CLI itself can say.
2. `saveCredential` upserts by `accountId ?? email`, so an identity-less
   credential replaces the active slot rather than adding one
   (`src/oauth/store.ts:735-818`). Multi-account is therefore out of scope for
   this provider, and `020` should say so rather than leave a half-working
   "Add account" button implying otherwise.

## The file confirms the boundary this unit promised to keep

`windsurf_api_key` is a real credential sitting in the CLI's own file. opencodex
must not read it — doing so would turn "the CLI owns its credential" into a lie
and would give the proxy a Cognition key it has no reason to hold. The probe
checks **presence and exit status only**, never contents. `010`'s
`readDevinCliSignedInState` is written that way and its test asserts no file
bytes are read.

