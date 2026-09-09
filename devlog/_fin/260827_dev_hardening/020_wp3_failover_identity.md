# wp3 — rebind credential identity on every 429 rotation

Blocker 2 in `000_inventory.md`. A credential-routing defect, so it is also the phase
that needs maintainer security review per `MAINTAINERS.md` before it lands.

## The defect

`sentOAuthSnapshot` is assigned once (`src/server/responses/core.ts:2883`) and is the
input to the pre-stream 401 refresh at lines 3523 and 5050.
`applyFailoverSnapshot` (2830-2845) rotates the provider on 429 but never updates it.

Sequence that mixes identity:

```
1. request built with account A            -> sentOAuthSnapshot = A
2. upstream 429                            -> applyFailoverSnapshot(B)
                                              route.provider.apiKey = B
                                              Copilot transport = B's origin
                                              sentOAuthSnapshot STILL A
3. rebuilt request 401                     -> forceRefreshOAuthAccessSnapshot(A)
4. transport resolved from ACTIVE credential, not the refreshed snapshot
   -> A's bearer can travel to B's allowlisted *.githubcopilot.com origin
```

Preventing exactly that pairing is the stated purpose of the failover snapshot
(`src/oauth/index.ts:62`). The Copilot origin allowlist itself is tight
(`src/oauth/github-copilot.ts:118`) — the defect is using the RIGHT allowlist for the
WRONG account.

## Second half of the same root cause

Only the runTurn 429 path rebinds replay identity:

| rotation site | line | clears Cursor state | updates replayOAuthCredentialSnapshot | binds replay scope |
|---|---|---|---|---|
| runTurn 429 | 4632 | yes | yes | yes |
| HTTP 429 | 5219 | no | no | no |
| sidecar 429 | 4330 | no | no | binds WITHOUT oauthCredentialSnapshot |

So continuation and thought-signature state minted under A can be replayed under B, and
for Cursor image turns the conversation id copied back by `src/images/loop.ts:447` can
cross accounts.

## The fix

Move the identity rebind INTO `applyFailoverSnapshot` so no rotation site can forget
it. It becomes the single place that:

1. sets `sentOAuthSnapshot = snapshot`
2. sets `replayOAuthCredentialSnapshot = { accountId, generation }`
3. clears Cursor conversation/checkpoint state
4. calls `bindRouteReasoningReplayScope({ ..., oauthCredentialSnapshot })`

and on the 401 path, resolve the transport from `refreshed.apiBaseUrl` rather than
`getOAuthCredentialApiBaseUrl()`, which reads whatever credential is active now.

Doing it inside the helper rather than at each call site is the point: three sites
already diverged, and a fourth would diverge again.

## Regression tests

Behavioral, not `coreSource.indexOf` string checks — the existing coverage for this
area asserts on source text, which cannot catch a rotation site that forgets a step.

1. Copilot A -> 429 -> rotate to B -> 401: assert the retried request carries B's
   bearer AND B's origin. Fails today.
2. HTTP 429 rotation: assert `replayOAuthCredentialSnapshot` names the rotated account.
3. Cursor sidecar 429: assert `_cursorConversationId` does not survive the rotation.

## Independent verification (2026-08-27)

A second read-only audit checked every claim above against `dev` rather than trusting
the first pass. Two things changed.

**Confirmed.** The stale snapshot is real: `applyFailoverSnapshot` never updates
`sentOAuthSnapshot`, and `forceRefreshOAuthAccessSnapshot` refreshes the SNAPSHOT's
account (`src/oauth/index.ts:500`), which after a rotation is still A. The
three-site asymmetry is real too, exactly as tabled above. Generic 429 failover never
promotes the active account, so the active-credential helper still names A.

**Corrected.** The 429-then-401 cross-origin send is NOT reachable on today's control
flow, so the table above overstated the consequence. Copilot Responses models take an
early passthrough return that has no generic 429 rotator at all, and in the HTTP
recovery loop the 401 handler sits ABOVE the 429 rotator while the 429 branch does not
`continue recovery` - so a 401 after rotation falls out of the loop and is returned as
an upstream error rather than re-entering the refresh. The runTurn and sidecar paths
never re-enter those 401 blocks either.

That reframes the phase without weakening it. What exists today is latent identity
drift; the missing `continue recovery` is an ACCIDENTAL guard, not a designed one.
Adding that continue - a plausible future improvement to 429 recovery - would activate
the defect. So the fix order matters: rebind identity inside `applyFailoverSnapshot`
FIRST, and only then consider making 429 recovery continue.

The audit also named the specific pairing that would leak if the 401 handler did run:
not the allowlist itself, but the transport fallback that drops to `provider.baseUrl`
when the refreshed account carries no allowlisted origin of its own. After a rotation
that base URL is B's.

Test placement, from the same audit: `tests/generic-oauth-failover.test.ts` already
source-asserts the three `applyFailoverSnapshot` sites, and there is no Copilot
429-then-401 coverage anywhere. The behavioral cases belong beside
`tests/adapter-event-oauth-failover.test.ts` and
`tests/server-xai-oauth-401-replay.test.ts`.

## Boundary

This is an authentication/credential surface. `MAINTAINERS.md` requires explicit
security review, and the hygiene gate will label it `unsponsored_surface`. Do NOT
self-apply `maintainer-sponsored`. Land the branch, post the evidence, and let a
maintainer make the call.
