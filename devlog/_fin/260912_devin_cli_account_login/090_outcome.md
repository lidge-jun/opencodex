# 090 — Outcome

**Merged to `dev` as `b09ef15c6f` (PR #4335).** PR head `2930a0a3bc` is an
ancestor of a freshly fetched `origin/dev`.

## What shipped

`devin-cli` is an account provider that imports the credential the installed
Devin CLI already holds and streams over Cognition's Connect-RPC api-server. It
appears in the dashboard Accounts tab beside Devin, with no `local` badge, and is
gone from the preset tabs.

Supporting changes that were not obvious at the start: tenant selection became
provider-scoped, because `resolveDevinApiServer` read a fixed `devin` credential
slot and would have crossed two accounts onto one host as soon as a second
provider shared the adapter. That required threading a provider id through
`AdapterFactoryContext`, `resolveAdapter` and both `core.ts` call sites.

## Evidence

| Check | Result |
| --- | --- |
| `GET /api/oauth/providers` | includes `devin-cli` |
| `GET /api/provider-presets` | excludes it |
| `ocx login devin-cli` | `{"loggedIn":true,"source":"local-cli"}`, no browser |
| `GET /v1/models` | 42 `devin-cli/*` rows from live discovery |
| `codex exec -m devin-cli/swe-2` | `CLOUD-OK` |
| context windows | `swe-2` 262,000 · Claude/GPT 1,000,000 · Gemini/GLM/Kimi 1,048,576 · Grok 500,000, from field #18 |
| dashboard | Accounts tab screenshot, Devin CLI row signed in |

Focused tests 128 pass / 0 fail, 18 of them new. GUI 1963 pass / 0 fail.
`structure:check` and `privacy:scan` pass. Hosted CI green on `2930a0a3bc`.

## What did not work, and what killed it

LOOP-PESSIMIST-01. The first design was wrong and took three audit rounds to
die. It kept the ACP transport and invented a marker credential so the provider
could have an account row without holding a token. Reviewers killed it in stages:
the request path would have 401'd every turn until someone clicked Login; the
`stdin` design could not deliver the one-time code it also required; the label
surface was the wrong file.

What actually ended it was not an argument but a measurement. Reading the CLI's
`credentials.toml` showed an ordinary `devin-session-token`, and feeding it to
the client already in this tree returned a real answer. Every blocker downstream
of "there is no credential we may hold" then evaporated, including the two that
had already been patched around.

The lesson worth carrying: three rounds were spent refining a design whose
premise nobody had tested, and the test took one minute. When a plan's central
constraint is an assumption about someone else's system, measure it before
designing around it.

## Residual

- The seven `two-lock xAI refresh` failures seen while checking this work
  reproduce on pristine `origin/dev` and are unrelated; they remain open.
- `identityFromApiKey` returned nothing for this account's token, so the Accounts
  row shows "signed in" without an address. That is what the CLI itself can say.
- Multi-account is out of scope: an identity-less credential replaces the active
  slot rather than adding one.

