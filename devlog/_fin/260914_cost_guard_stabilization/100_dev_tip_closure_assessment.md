# 100 — how much of #4546 the current dev tip actually closes

Assessed against `dev@61ee64747b` (`test(cli): measure cold status setup before timed
projections (#4948)`). Static source reading only; no local suite, typecheck, build or
`ocx` invocation was run, by explicit instruction for this lane.

## The one-line answer

**The cache-destruction half of #4546 is closed. The token-burn half is not, and the
reason is not routing.**

Cohort keying (#4935) and the bound-binding policy (#4581, #4580) together make the
reported ping-pong structurally impossible: a live conversation now cannot be moved for a
quota preference at all, and every member of one conversation tree resolves to one
account. What remains is the Phase 1 mechanism in the reporter's own telemetry — a
high-volume fan-out of one-off requests, each carrying a large cold prefix — and that
prefix is cold because each request is a *distinct prompt*, not because it landed on a
different account. No account-affinity rule can warm it. The instrument that would bound
it exists, journals to disk, and has no reachable configuration, so it measures the volume
and never refuses it.

## What is closed, with the code that closes it

### The threshold no longer evicts a live conversation

`mayRebindAffinityForQuota` is the bar a voluntary move must clear, and by default it is
genuine exhaustion rather than a threshold crossing
(`src/codex/routing/cache-affinity.ts:57`):

```ts
const overThreshold = threshold > 0 && !isUnknownUsage(usage) && usage >= threshold;
if (!retainsBoundAccountForQuota(config, selectionOptions)) return overThreshold;
return !isCodexAccountUsable(config, accountId, selectionOptions)
  || (!isUnknownUsage(usage) && usage >= 100);
```

`retainsBoundAccountForQuota` reads `isCacheAffinityEnabled`, which is
`config.pool?.cacheAffinity !== false` — on unless explicitly disabled
(`src/codex/routing/selection.ts:275`). So an install that has never heard of the flag
keeps its binding through the entire 80–99% band. That is the exact band the report
measured, and it is also the reporter's remediation 1 ("never switch accounts
mid-conversation") and 3 ("sequential drain") as the default.

### The destination has a floor even when an operator opts back out

With `cacheAffinity: false` the historical rule returns, but the destination must still
have real headroom *and* be strictly cooler (`src/codex/routing.ts:649`,
`pickCacheSafeQuotaReplacement`). `CODEX_UNKNOWN_USAGE_SCORE` is 101, so an unmeasured
account can never win the strictly-cooler compare. The all-hot case — 95/90/97, every
candidate over threshold — therefore selects nothing under either setting.

### One re-score bar, so the interval is not short-circuited

The original report's sharpest observation was that crossing the threshold also bypassed
the 60-second re-evaluation interval, turning a once-a-minute decision into a per-request
one. `reevaluateAffinityQuota` now keys the short circuit off the *same* predicate as the
rebind decision (`src/codex/routing.ts:680`):

```ts
const mayRebind = mayRebindAffinityForQuota(config, entry.accountId, usage, threshold, selectionOptions);
if (!mayRebind && now - entry.lastReevalAt < CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS) return null;
```

Because `mayRebind` is now false throughout the 80–99% band, a bound thread in that band
is re-scored once a minute, not once a request. The in-file comment states the coupling
deliberately.

### Preview and resolve answer identically

`previewReusableAffinityAccount` carries the same rule (`src/codex/routing.ts:536`
onward), including the transient detour, so the subagent-fallback preview cannot decide
against a binding the next real request would have held.

### A tree is one cache domain

Cohort keying derives one key for a whole conversation tree from the session id, falling
back to the parent's recorded key when there is no session (`src/codex/lineage.ts:168`,
`:189`). Root, child and grandchild share it, so a fan-out cannot split its family across
accounts. First-placement lineage hinting survives only for the case cohort keying cannot
unify — a session-less chain whose parent this scope never recorded
(`src/codex/routing.ts:397`).

## What is not closed

### 1. Cold input volume is measured and never bounded

This is the remaining mechanism, and it is precise.

The durable spend ledger supports per-scope token ceilings at root, identity and pool
scope. Its default policy sets none (`src/lib/spend-reservation-ledger.ts:124`):

```ts
/**
 * Unconfigured default: every limit undefined, so token accounting runs in observe-only
 * mode and the count caps remain the only enforcement. Real numbers belong behind
 * explicit operator configuration.
 */
export const DEFAULT_SPEND_RESERVATION_POLICY: SpendReservationPolicy = {
  root: {}, identity: {}, pool: {}, retentionMs: 7 * 24 * 60 * 60_000,
};
```

"Behind explicit operator configuration" is the part that did not ship. The process-wide
ledger is constructed with no `policy` argument at all
(`src/lib/spend-reservation-ledger.ts:944`):

```ts
sharedLedger = createSpendReservationLedger({
  journal: createFileSpendJournal(join(home, SPEND_LEDGER_JOURNAL_FILENAME)),
  salt: loadOrCreateSpendLedgerSalt(join(home, SPEND_LEDGER_SALT_FILENAME)),
});
```

There is no `configureSharedSpendLedger`, and `src/types/config.ts` declares no spend
key. A `SpendReservationPolicy` with a real `maxTokens` is constructed in exactly two
places in the tree, both of them tests (`tests/lib/spend-reservation-ledger.test.ts:26`,
`tests/lib/workflow-budget.test.ts:37`). **No configuration an operator can write turns
token enforcement on.** The reserve/dispatch/settle vocabulary is live and journaling via
`createRequestSpendTracker` (#4707), so the volume is recorded faithfully — and
`limitFor()` returns `undefined` for every scope, so the refusal branch is unreachable.

The admission path reinforces this: `src/server/index.ts:512` calls
`admitWorkflowTurn(workflowRootId, workflowLane, undefined, workflowThreadId)` with no
`spend` argument, so the reservation-at-admission path never runs in production either.

What *is* enforced is counts (`src/lib/workflow-budget.ts:72`): 256 physical sends and 64
distinct children per ten-minute window, 8 concurrent children with 1 slot reserved for the
interactive lane. Check those against the reporter's own Phase 1 figures — 732 one-off
subagent calls between 16:00 and 18:00 KST on account 2, ~142k uncached tokens each,
104,188,859 uncached tokens total:

| ceiling | value | Phase 1 rate | fires? |
| --- | --- | --- | --- |
| `maxPhysicalSends` | 256 / 10 min | ~61 / 10 min | no |
| `maxDistinctChildren` | 64 / 10 min | ~61 / 10 min | no, by three |
| `maxConcurrentChildren` | 8 (7 for workers) | throttles shape, not volume | n/a |
| token ceiling | unset and unsettable | ~8.7M uncached input / 10 min | **cannot** |

The measured incident passes every live ceiling. `090_remaining_stack.md` predicted this
in as many words — "the count caps from #4614 are already live and permissive" — and made
observational-first the deliberate choice. The choice was right; the configuration surface
that was supposed to follow it is the gap.

### 2. Cohort keying concentrates the fan-out onto the interactive account

This is a consequence of the fix, not a regression, and it should be stated plainly. Before
#4935, a fan-out drew on whichever account each child resolved to. Now the whole tree
shares one key by design, so 700 cold one-off children draw on precisely the account the
interactive conversation is bound to — and `cacheAffinity` then holds that conversation
there until `usage >= 100`.

That trade is correct for cache locality and it is what the reporter asked for. But it
means the workers drive the interactive account to hard exhaustion, and
`interactiveReserve: 1` does not help: it reserves a *concurrency slot*, not quota. The
reporter's remediation 2 — "allow users to designate a specific worker/agent account" — has
no implementation. `src/types/config.ts` contains no worker-lane account key, and the
cohort key deliberately prevents one from being honoured today.

Two further edges follow from the same keying. A request carrying no
`x-codex-parent-thread-id` has no root, and `admitWorkflowTurn` returns early on
`if (!rootId) return undefined` (`src/lib/workflow-budget.ts:425`), so unparented
one-off traffic sits outside every ceiling. And the lane is decided purely by header shape
at `src/server/index.ts:505`, so a client that omits `thread-id` on its children has
them admitted as interactive.

### 3. The quota/cache domain classifier is landed and unwired

wpc shipped `src/routing/identity-domains.ts` with `classifyCredential`,
`relateQuotaDomain`, `relateCacheDomain`, `assessQuotaRotation`,
`countQuotaCapacity` and `canPortConversationState`. Its only production consumer is
`src/config/schema/leaf-validators.ts`, which imports `credentialGroupIssues` for config
validation. Nothing in `src/codex/routing.ts` or the pool selection path consults
`relateCacheDomain` or `assessQuotaRotation`; `src/server/responses/account-change-state.ts:76`
still carries a comment deferring to "src/routing/identity-domains.ts ... once that module
lands". So pool routing continues to treat credential string identity as cache identity.
`090` named this honestly as the limitation of the first three layers; it is still true.

### 4. The wire still emits a synthetic cached_tokens: 0

`responsesUsage` emits zero-default token-detail objects unconditionally, because
grok-build's pinned `async-openai` fork deserializes them as required fields and omitting
them turns a completed turn into a hard exit (`src/bridge/internal.ts:36` onward). That is
a real compatibility constraint, not an oversight. Honest reporting landed one layer in:
`usageFromBridge` marks raw adapter provenance so re-parsing cannot overwrite it, and
`src/server/request-log.ts:170` records that a synthetic `cached_tokens:0` is not a
measured cache read. So OpenCodex's own accounting can now tell unreported from
measured-zero; a strict client reading the wire still cannot.

## Verdict on closure

#4546 should stay open, and the reason should be restated because it has changed. It is no
longer open for the defect it was filed about. Routing no longer destroys a prompt cache:
the splitting is closed, the eviction bar is exhaustion, the re-score interval is intact,
and preview agrees with resolve. It is open because the amplifier that produced two thirds
of the measured uncached volume is an unbounded cold-input rate, and the ledger built to
bound it cannot be switched on.

The next unit of work is therefore not a routing change. It is the configuration surface
for `SpendReservationPolicy` — an operator-set token ceiling at root scope, defaulting to
unset so no existing install is newly refused — plus the worker-lane account designation
that cohort keying currently makes impossible.

## Note on adjacent merges

#4071 (`perf(gui): cache immutable assets and static files`), #4676
(`feat(oauth): rank Antigravity failover by Gemini vs Claude quota family`) and #4921
(`fix(codex): decide flagship model availability by roster and refusal evidence`) merged
in the same window but are not in this issue's mechanism. #4071 is GUI static-asset HTTP
caching and shares only the word "cache"; #4676 is Antigravity failover ranking; #4921 is
flagship-model availability. #4935 is the only one of the four that moves #4546.
