# Lane P — #2895 / #2892 gap 5: one recovery budget for a stored Pool 401

Carries contributor PR #2895 (`luvs01`, `a838b071c`) onto current `dev` and corrects the one
blocker in it. The contributor's commit is preserved with its authorship; this unit is the
follow-up commit on top.

## What the contributor got right

#2889 gave an ordinary stored Codex Pool account one generation-fenced forced refresh plus one
same-account replay after a pre-stream 401. Gap 5 of #2892 is that the replay's *result* was not
treated as final: a replay 429/402 could still be composed with another Pool account, a remembered
compact model, a combo target, or a policy-fallback candidate — so a single logical request could
spend several accounts' quota after the budget was already used.

The contributor's structure is sound and is kept as-is: the boolean `codexMain401ReplayAttempted`
becomes a tri-state `codex401ReplayKind` (`"main" | "stored" | null`), an
`onStoredPool401ReplayDispatched` signal is threaded through combo and policy fallback, and compact
guards both its pool-rotation and remembered-model paths. `main-pool` keeps its full recovery
breadth, which is correct — a native main 401 is not a stored-account budget.

## The blocker: the budget bounds accounts, not rescue

The original patch enforced the bound with one line in `src/server/responses/core.ts`:

```ts
if (codex401ReplayKind === "stored" && upstreamResponse.status >= 400) break;
```

That break sits *above* two recovery ladders that send to the account already paying:

- `shouldRetryCodexPoolAccountModel400` (`:4200`) — an allow-listed gated-model 400, retried on
  the **same** account when the refreshed roster still grants the model
  (`retryCodexPoolOnAlternateAccount` sets `retryAuthCtx = firstAuthCtx` for exactly that case).
- `attemptOpaqueBlobRecovery` (`:4249`) — a rejected opaque reasoning/compaction blob, where the
  one-shot rebuild strips the blob and resends to the same refreshed account.

Neither charges a different account, so neither is inside the budget #2892 asked to bound. With the
broad break, `401 → refresh → invalid_encrypted_content` became a user-visible 400 where the
rebuild would have succeeded. A regression proves it: restoring that one line turns
*a stored-account replay may still rebuild a rejected opaque blob on the same account* red.

The corrected boundary is stated in terms of what is actually scarce — **another account's quota**,
not further sends:

- a quota failure (429/402) after a stored replay has no same-account move left, so it stays
  terminal at the pool-retry site;
- a gated-model 400 keeps its ladder, with `sameAccountOnly` refusing alternate-account resolution
  inside `retryCodexPoolOnAlternateAccount`;
- opaque-blob recovery is untouched.

`sameAccountOnly` is a new field on the retry args rather than a check at the call site, because
the decision belongs where the alternate is resolved — the existing `fixedAccount` guard already
lives on that line and means the same thing for a different reason.

## The timing defect in the dispatch signal

The signal fired immediately before `fetchWithHeaderTimeout`, but that helper awaits
`pacing.waitForPacing()` (`src/server/responses/fetch-helpers.ts:121`) and only then invokes the
executor. A rejected pacing admission therefore marked the budget spent for a send that never
reached the network, and the request lost its fallback for nothing.

`storedPoolReplayDispatchNotifier` wraps the executor so the signal fires at the last moment before
the send. It deliberately re-exposes `waitForPacing` and `unpacedFetch`: `fetchWithHeaderTimeout`
reads both off the executor, so a plain function wrapper would drop provider pacing — and a wrapper
that kept `waitForPacing` but dropped `unpacedFetch` would pace twice. Both are covered by named
mutations.

## Verification

196 pass / 0 fail across the pool-401, native-main, policy-fallback, fetch-helper, opaque-blob,
pool-rotation, compaction-routing, combo-recovery, stream-preflight, and request-pacing suites.
`bun x tsc --noEmit` clean; `privacy:scan` green.

Named mutations, each turning its own test red:

| Mutation | Test that fails |
| --- | --- |
| restore the broad `status >= 400` break | opaque blob rebuilt on the same account |
| remove the quota-terminal bound | both stored-replay-429 cases reach another account |
| `sameAccountOnly: false` | gated-model 400 after a stored replay reaches an alternate |
| notify eagerly instead of at send time | pacing-rejected case signals a phantom dispatch |
| drop `unpacedFetch` from the wrapper | pacing applied twice |

One process note worth keeping: the gated-model test was **vacuous on the first attempt**. The
injected entitlement resolver reported only the other account as entitled, so initial selection
picked that account and the stored 401 never happened — the assertion passed with one send and no
refresh. It now returns both accounts on the first resolution and only the other account from the
retry resolution onward, which is what actually reaches the alternate-account branch.

## Not in this unit

Gaps 1–4 of #2892 (refresh-flight abort ownership, superseding-generation freshness, rotated-grant
fan-out to inactive aliases, atomic generation validation) remain open and are the other PR that
issue asks for.
