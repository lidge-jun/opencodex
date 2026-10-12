# 020 — wp7e execution record

## What shipped

Presence-driven activation for generic OAuth 429 failover, plus the four defects that default-off
was hiding and one test that could not see a regression it was supposed to guard.

### Activation (the owner's decision)

`isGenericOAuthFailoverEnabled` now answers in three steps:

1. `providers.<name>.oauthAccountFailover.enabled`, when it is an explicit boolean;
2. `oauthAccountFailover.enabled`, when it is an explicit boolean;
3. otherwise, 2 or more eligible stored accounts.

Only an explicit boolean overrides presence, so a malformed value falls through instead of taking
a provider out of service. Every existing config keeps its current meaning: someone who wrote
`false` still gets strict single-account behaviour, and someone who wrote `true` sees no change.

Presence rather than a bare `true` because this predicate does more than gate the rotation loops.
At `core.ts:4660` and `:4745` it decides whether the runTurn stream is wrapped in
`preflightRunTurnFailover`. For a single-account install that wrapper can never rotate — the
rotator returns null below two accounts — so an unconditional `true` would add a preflight to
users who get nothing from it.

### The presence cache

`loadAuthStore` has no cache: each call chmods the config dir and the secret file, reads the whole
store, parses it and normalizes it. Since presence now decides activation, the predicate runs on
requests that never see a 429 at all, so the naive version would put a synchronous file read in
front of every OAuth request.

The module memoizes a COUNT per provider for two seconds, invalidated on every rotation and by
`clearGenericFailoverHealth`. Two seconds is shorter than the time it takes an operator to finish
logging in elsewhere and send a prompt, so a fresh login is not hidden. No credential is cached.

### applyFailoverSnapshot: one place where the identity is assembled

Three rotation sites each inlined the same four lines, and that duplication WAS the bug. Two
account-scoped values travel with a Copilot or Antigravity bearer, and the inlined code carried
neither correctly:

- **Copilot** pins its bearer to an account-scoped regional origin. The initial route pairs them
  (`core.ts:2882-2887`), but `OAuthAccessSnapshot` did not carry `apiBaseUrl`, so a rotation sent
  account B's token to account A's host. `resolveGithubCopilotTransport` fails closed to the
  canonical host for an unvalidated origin, which is why this was wrong routing rather than a
  token leak — but it was still wrong, and default-on would have made it everyone's problem.
- **Antigravity** needs an account-matched Cloud Code Assist project. The old code wrote `project`
  only when the new snapshot had one, so a project-less account inherited the FAILED account's
  project. That account is reachable: the refresh path tolerates project discovery failing
  (`google-antigravity.ts:233-235`).

The helper now assembles the whole identity or refuses. A cloud-code-assist snapshot without a
project aborts the rotation, because not rotating is better than rotating into a mixed identity.
A structural test pins that `apiKey: snapshot.accessToken` appears exactly once in `core.ts`, and
that the one occurrence is inside the helper.

### The opt-out had to survive a login

`upsertOAuthProvider` rebuilds the provider row from the registry preset and carries forward an
allowlist. Without this change, the sequence was: operator sets `enabled: false`, operator logs in
a second account, and that single action both deletes the opt-out and creates the quorum that
turns rotation on. The opt-out is now preserved, in both directions — an explicit `true` survives
too, because the rule is about operator intent, not about a preferred answer.

## Falsification

Two new contracts were driven red before being trusted:

| Contract | How it was falsified | Result |
| --- | --- | --- |
| First delta reaches the client before completion | forced `preflightAdapterEvents` to buffer the whole turn | test failed at the 5s bound instead of passing |
| Opt-out survives login | disabled the preservation branch | both upsert cases failed |

The delivery test reads the SSE body incrementally against a completion the fixture holds closed,
so it fails on latency rather than on content. The previous whole-body assertion could not have
caught either regression.

## Deliberately not done

`/api/providers` POST and its GUI payload drop unknown provider keys, including this one. Real,
but it is the Add Provider path: operator-initiated wholesale replacement that already discards
every unrecognized field. Fixing it means changing the payload contract in general, which is a
different unit. The login path was the one that fires without the operator asking, and that is the
one this cycle closed.
