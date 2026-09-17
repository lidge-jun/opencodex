# 030 — is #4850 a precondition for this stack?

Issue #4850 reports that a `thread_spawn` request authenticating with its own
forwardable Codex bearer still opens the operator's physical native-main
`auth.json` during request preview. The existing fence
(`nativeMainReadsForbidden`, threaded through `request-prepare.ts`,
`auth-context.ts`, `core-normalize.ts` and `subagent-model-fallback.ts`) already
covers quota priming, entitlement discovery, denial-cache validation,
reconciliation and final selection. Pool eligibility is outside it:
`isCodexAccountUsable` reaches `isMainAccountCredentialUsable()` for the main
account unless `nativeMainSelectionOnly` is set, and the preview closures at
`request-prepare.ts:550` and `:731` call `previewCodexAccountForRequest` without
that suppression.

## Mechanically, no

The four pull requests touch nothing in that path. Taking the whole stack at
#4864's head against its included `dev`:

```bash
git diff --name-only 7ef3f67452 pr4864 -- src/codex src/routing \
    src/server/responses/request-prepare.ts
# (no output)
```

Nothing under `src/codex/`, nothing under `src/routing/`, and not
`request-prepare.ts`. The stack adds a control channel below the point where
preview and selection have already run. It does not re-enter them either: a
continuation is rebuilt from the original create frame inside
`codex-ws-exchange`, so `previous_response_id` never reaches the account
selector, and the per-frame guard gets a copy of the original headers. So #4850
is not a merge-order blocker, and none of the four PRs can fix or worsen the
read itself.

## Substantively, yes — for turning the flags on

Two facts make it a precondition for activation rather than for merging.

First, the request class is the same one. #4850's reproduction is a
`thread_spawn` request carrying a caller-owned bearer, and a multi-agent
injection turn is exactly that class: every injection create traverses
`prepareResponsesRequest`, and therefore the unfenced pool-eligibility preview,
before any channel exists. Enabling `codexNativeInjection` does not introduce the
read, but it makes the affected request class the primary use of the feature.

Second, the stack's whole value is that the create-time decision is pinned. C1
holds precisely because the account chosen at create time is the account the
entire chain uses, and C4 shows that chain can be long. #4850's observable
consequence — operator-main liveness, cached quota and plan state influencing a
subagent model rewrite for a request that owns its own credential — is a
one-request inconsistency today. Under this stack the same preview result governs
up to 128 responses on one pinned credential, with no re-evaluation point in
between, because there deliberately is none.

## Determination

#4850 does not gate landing #4782, #4858, #4861 or #4864. It gates documenting
or recommending `codexNativeInjection: true`, and it should be resolved before
any operator is told to enable it. The lane that owns #4850 should know that
fixing pool eligibility inside the fence is enough for this stack; no additional
seam is needed on the native control path.
