# 011 — wp7e audit response: the plan was a one-liner over three real defects

Three read-only auditors ran in parallel against the tree. Two returned **fail**, one
**near-pass**, for six findings total. I verified every one against the code. Five hold and are
folded into the build; one I accept as real but scope out with a reason.

The honest summary: the plan was right that the *activation* change is one predicate, and wrong
that flipping it is therefore safe. Default-off was hiding defects in the rotation path, and
turning it on is what makes them reachable.

## Accepted, folded into the build

**F1 — Copilot rotation pairs a new bearer with the old account's API origin. ACCEPTED,
security-relevant.** The initial route resolves Copilot's transport from the *active* credential's
`apiBaseUrl` (`core.ts:2882-2887` calling `getOAuthCredentialApiBaseUrl`, which reads
`getCredential(provider)` — the ACTIVE account, `oauth/index.ts:278-280`). But
`OAuthAccessSnapshot` deliberately omits `apiBaseUrl` (`oauth/index.ts:52-58`; only the
observation type `ObservedOAuthAccessSnapshot` carries it, `:64-67`), and all three rotation sites
replace `apiKey` alone (`core.ts:4283-4290`, `:4588-4595`, `:5180-5187`).

`resolveGithubCopilotTransport` fails closed to the canonical host when the supplied origin does
not validate (`github-copilot-transport.ts:43-50`), so the token cannot leak to an arbitrary host.
That is a real mitigation and it is why this is a correctness bug rather than a token-exfiltration
bug. It is still wrong: account B's bearer goes to account A's allowlisted regional origin, which
is exactly the pairing `core.ts` takes care to preserve on the initial resolve.

Fix: carry `apiBaseUrl` on the rotation snapshot and re-run `resolveProviderTransport` with it at
every rotation site, instead of mutating `apiKey` in place.

**F2 — Antigravity rotation keeps the failed account's project when the new one has none.
ACCEPTED.** Each site writes `project` only when the incoming `projectId` is truthy
(`core.ts:4286-4290`, `:4591-4595`, `:5183-5187`). A project-less account is reachable: the refresh
path re-discovers the project best-effort and returns credentials without one when discovery fails
(`google-antigravity.ts:233-235`). Under opt-in this was a narrow hazard; presence-driven
activation arms it for every operator with two Antigravity logins.

Fix: fail closed. A Cloud Code Assist provider whose rotated snapshot has no `projectId` is not a
usable rotation target — refuse the rotation rather than send the old project with the new bearer.

**F3 — the presence check would hit the filesystem on hot paths. ACCEPTED.** `loadAuthStore()`
has no cache (`store.ts:149-151`): every call runs `hardenConfigDir()` + `hardenExistingSecret()`
(two `chmodSync`), an `existsSync`, a full `readFileSync`, a `JSON.parse`, and a whole-store
normalize (`store.ts:136-147`). The predicate is called at five `core.ts` sites plus the sidecar
hook, and two of those run on EVERY streaming and non-streaming runTurn request before any 429
exists (`core.ts:4660`, `:4745`). The auditor counted four to five full store loads per 429 flow
once `rotateGenericOAuthAccountOn429` and `eligibleFailoverAccounts` re-load internally.

Fix: a small process-local quorum cache in the failover module, keyed by provider, invalidated by
the auth store's own mutation counter so a fresh login is visible immediately. No new persistence.

**F4 — login rebuilds the provider row and would erase a per-provider opt-out. ACCEPTED, and it
is the nastiest of the six.** `upsertOAuthProvider` reconstructs the provider from the registry
preset and carries forward an explicit allowlist only — `liveModels`, `commandCodeVersion`,
`modelCosts`, key material (`oauth/index.ts:1079-1119`) — then `runLogin` saves it after every
login, add-account, and reauth (`:1211-1223`).

So the sequence that matters is: operator writes `enabled: false`, then logs in a second account,
and the login both *deletes the opt-out* and *creates the quorum that turns rotation on*. The
repository already treats this class of loss as a bug worth a dedicated test
(`tests/oauth-upsert-preserves-api-key.test.ts`).

Fix: add `oauthAccountFailover` to the preserved-fields list with a regression test.

**F6 — the Cursor failover test cannot see stream buffering. ACCEPTED as a test gap.** The
two-account case arms `preflightRunTurnFailover` but reads the whole body
(`tests/adapter-event-oauth-failover.test.ts:101`), so it would not notice if the wrapper held the
first delta until `done`. Since default-on puts every multi-account user behind that wrapper, the
suite should pin delivery, not just content.

Fix: add a streaming case that proves the first delta reaches the client before the turn ends.

## Accepted as real, scoped out with a reason

**F5 — `/api/providers` POST and the GUI payload drop unknown provider keys**
(`provider-routes.ts:539-550`, `gui/src/provider-payload.ts:71-81`). True, but this is the
*Add Provider* path: it replaces a provider row wholesale by operator action, and it already drops
every unknown key, not only this one. Fixing it properly means teaching the payload contract about
preserved operator fields in general, which is a different unit with a different blast radius.

F4 is the one that fires without the operator asking for it, and that is the one this cycle fixes.
Recorded here so the next person does not think it was missed.

## Revised scope

| File | Change |
| --- | --- |
| `src/oauth/generic-account-failover.ts` | precedence chain, cached presence quorum, per-provider override read |
| `src/oauth/index.ts` | rotation snapshot carries `apiBaseUrl`; `upsertOAuthProvider` preserves `oauthAccountFailover` |
| `src/server/responses/core.ts` | rotation sites re-resolve transport with the rotated account's origin; Antigravity fails closed without a project |
| `src/types/provider.ts` | per-provider `oauthAccountFailover` |
| `src/types/config.ts` | doc comment: presence-driven, not opt-in |
| `docs-site/.../providers.md` | default, opt-out, caution rewritten |
| `tests/generic-oauth-failover.test.ts` | activation matrix rewritten; quorum cache invalidation |
| `tests/adapter-event-oauth-failover.test.ts` | no-knob default, explicit-false, streaming delivery |
| `tests/oauth-upsert-preserves-api-key.test.ts` (or sibling) | opt-out survives login |

The plan's original claim "no change to core.ts" is withdrawn: F1 and F2 both live there.

VERDICT accepted: **near-pass with five folded blockers**. Proceeding to B.
