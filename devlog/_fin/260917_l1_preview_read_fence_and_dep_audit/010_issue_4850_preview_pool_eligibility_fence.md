# Unit A — issue #4850: pool eligibility is outside the preview read fence

## The gap, stated precisely

`src/server/responses/request-prepare.ts` already computes the ownership fence.
`previewRequestScopedMainCredential` is the route ownership predicate ANDed with
`hasCallerCodexBearer`, exactly as final authentication validates it, and
`nativeMainReadsForbidden` ORs it with retained recovery and a draining selector.
Quota priming, entitlement discovery, and the denied-model cache all honour it.

`previewSelectionOptions` does not. It carries `nativeMainSelectionOnly` and the
uploaded-file retention bit and stops there. When that object reaches
`previewCodexAccountForRequest -> pickPriorityPreemption -> getEligiblePoolAccounts`,
`codexAccountUnusableReason` in `src/codex/account-usability.ts` finds no
`isMainAccountTokenLive` override and falls through to its default,
`isMainAccountCredentialUsable()`, which opens and parses the physical `auth.json`.

It happens twice because the same options object is used twice: once for the direct
preview in `prepareResponsesRequest`, and once inside the callback
`applySubagentModelFallback` invokes per candidate model. The post-decryption
recovery re-preview builds `recoverySelectionOptions` the same way and has the same
omission.

## What is and is not at stake

Not a token leak. Final authentication never selects the physical main credential
for a caller-owned request: it passes `isMainAccountTokenLive: () => preserveRequestOwnedMainPin`
into its own selection options, so main is either served as the caller's own
credential or scored `main_credential_unavailable` and dropped. ADR-0086 already
rejected reading the physical main token for identity.

What is at stake is that operator-main liveness, cached quota, and plan state can
enter the score that decides whether a subagent's model is rewritten, for a request
that owns its credential. A preview that scores main differently from the resolution
it exists to predict is a correctness defect on top of the boundary defect.

## Chosen direction

Use the existing `CodexAccountUsabilityOptions.isMainAccountTokenLive` seam, and
give it the same value final authentication gives it rather than a preview-only
constant.

That answers the open question in the issue review directly. `preserveRequestOwnedMainPin`
is not an arbitrary choice: it is the only value that makes the preview agree with
the resolution in both branches. When the operator has an effective manual main pin
with quota headroom, final authentication returns the caller-owned main context, so
the request really is served by main and the preview should score main eligible.
When there is no such pin, final authentication drops main from pool eligibility,
and the preview must drop it too. A hardcoded `true` would be wrong in the second
case, and a hardcoded `false` would be wrong in the first.

Every input to that predicate is config, policy, or in-memory runtime state —
`activeCodexAccountPinned`, `isEffectiveCodexAccountPinned`, `pausedCodexAccountIds`,
the in-memory quota score, and `matchesMainQuotaCredential`, which compares HMACs
against an observed-credential record held in `main-account-cache.ts`. Nothing in
it opens a file, which is what makes it usable on the fenced side.

To keep preview and final authentication from drifting apart again, the predicate
moves into one exported function in `src/codex/auth-context.ts` that both callers
use. Two copies of a fence is how this gap appeared in the first place.

## Edit set

| File | Change |
|---|---|
| `src/codex/auth-context.ts` | Extract `requestOwnedMainPinState` and call it from `resolveCodexAuthContext` |
| `src/server/responses/request-prepare.ts` | Pass the synthetic `isMainAccountTokenLive` in `previewSelectionOptions` and `recoverySelectionOptions`, scoped to the ownership flag |
| `tests/responses/responses-preview-main-read-fence.test.ts` | Assertions (a) and (b) below |

No new test file, so `layout.json` and `test-layout-expected.json` are untouched.
No file here is on the size-ratchet baseline. No `src/` area is created or removed
and no invariant test disappears, so `structure:check` has nothing to consume.

## Completion criteria

Deliberately stricter than "the right token was eventually sent", because that was
already true before the fix and the defect survived it anyway.

(a) A caller-owned `thread_spawn` performs **zero** `auth.json` reads across the
whole request, asserted on the unfiltered read counter rather than through the
denial-cache stack filter that currently hides these two reads.

(b) Ordinary main selection is unchanged. A request with no caller bearer still
reads the physical credential and still selects main when it is healthy, so the
fix cannot be satisfied by making main globally ineligible.

(c) The #3166 healthy main-pin behaviour survives: a caller-owned request under an
effective main pin is still previewed as main.

## Risk

The behaviour change is confined to requests where `previewRequestScopedMainCredential`
is true. For every other request the option is absent and `account-usability.ts`
takes the identical default branch it takes today.
