# 110 — Eager relay caller-cancellation provenance

Class C3; spec-satisfaction repair. Depends on 100's corrected integration
baseline for the final six-shard check. Goal: actual caller abort records 499
without penalizing the pool; actual upstream reset still records 502. No auth,
permissions, logging schema, Bun pin, or Windows safety-selector changes.

## Proven mechanism and remaining uncertainty

`src/server/responses/core.ts:4861` enables field backfill, which makes the
Windows rewrite override select eager even with legacy-tee. Caller abort is
linked to the fetch controller at :4089. Eager receives a different turn
controller at :4893; the link is turn-to-fetch only. Its rejection classification
therefore lacks the caller provenance added by #3541 to tee inspection. Two
Windows runs observe the synthetic 502 shape. Exact native event order is not
yet traced; a deterministic rejected-read plus caller-abort fixture must go red
before the source patch. Negative upstream reset remains mandatory.

## MODIFY src/server/relay-eager.ts

Preserve existing controller semantics: generic shutdown is not client cancel.
Add one owner-local optional field to EagerRelayOptions:

```diff
 export type EagerRelayOptions = {
+  /** Caller cancellation, independent of the turn/shutdown controller. */
+  clientGoneSignal?: AbortSignal;
```

Extract current body-cancel transition into an idempotent local helper:

```ts
const markClientGone = () => {
  if (cancelled || doneFired) return;
  cancelled = true;
  drainDeadline = now() + drainMs;
  armDrainTimer();
  wakeUp();
};
```

Move drainedBytes/drainDeadline declarations above this helper. Reuse it from
body cancel and enqueue-after-disconnect. Register clientGoneSignal before
producer starts, observe already-aborted state, and remove its listener in
fireDone. After each read settles and at catch entry, inspect `.aborted` and
invoke the helper if needed; keep inspection of a settled real chunk before
honoring turn-controller abort. Do not cancel the source reader immediately
on caller signal: preserve bounded discard-drain/terminal precedence.

Replace synthetic/fallback eligibility's `!cancelled` predicate with a small
local predicate that refreshes caller provenance, then checks !cancelled and
!upstream.signal.aborted. Use it at all existing eligibility sites, including
after encodeFailedTail (error serialization can re-enter cancellation). No
per-read Promise.race and no new scheduling policy.

Keep finishInspection in the catch before final outcome classification. Finalize
onClientCancel exactly once if cancelled and no real terminal was observed.
Change the final controller close to guarded unconditional close: caller signal
may arrive without body.cancel, so cancelled does not prove the returned stream
is already closed. Repeated/late cancellation must not re-arm timers or duplicate
callbacks. Preserve existing rewrite disposal and bounded queue accounting.

## MODIFY src/server/responses/core.ts

Always pass options to the single production eager call:

```diff
-}, inlineEagerRewrite ? { rewriteBudget: translatorBudget } : undefined);
+}, {
+  clientGoneSignal: options.abortSignal,
+  ...(inlineEagerRewrite ? { rewriteBudget: translatorBudget } : {}),
+});
```

Field chain: creation from existing handleResponses abortSignal; local function
argument transport; no serialization/deserialization (in-memory AbortSignal);
consumer relaySseEagerBounded. All other direct callers are tests and may omit
the field. HTTP/WS/Chat/Claude inbound callers already supply the signal; their
outer logging ownership stays unchanged. No reversal of controller links.

## MODIFY tests/server/relay-eager.test.ts

Reuse makeHooks, controlledUpstream, and completion promises. Add deterministic
tests for these activation rows (no timing sleeps):

1. Read rejection, then caller.abort in the same turn, before body.cancel:
   synthetics=[], cancels=1, terminals=[], dones=1, disposes=1; downstream closes.
2. Identical read rejection without caller abort: synthetics=[failed], cancels=0.
3. A real completed chunk settles before same-turn caller abort: terminal wins.
4. An inspected delimiter-less terminal then rejection+abort: flush preserves
   completed/failed/incomplete (including upstream policy error status).
5. Silent source/paused producer plus caller abort: existing drain bound stops
   reader, one cancellation, no stranded downstream reader.
6. Error serialization triggers caller abort: no synthetic tail or double outcome.
7. Late/repeated signal/body cancel after finish: no new callback/timer.

Existing generic shutdown tests must still report zero client cancels. Existing
body-cancel terminal-wins tests remain unchanged. The original server-auth
499/502 pair is not weakened or skipped.

For baseline red, put the future option in a local options variable with an
existing property (postCancelDrainMs), so structural typing allows the extra
field while old runtime ignores it. Require observed [failed]/zero-cancels
before implementing. Restore the old source once to prove the same regression
fails again; never commit or push a mutant.

## Verification and delivery

- Focused local tests only: relay-eager.test.ts and sse-failed-tail.test.ts,
  then affected passthrough/stream-capability tests and typecheck. Direct file
  arguments observe the changed owner; no local repository-wide suite.
- Windows: reuse ci.yml workflow_dispatch lane=all, fixed task branch, Bun1.4.0,
  six shards, existing 25-minute ceiling, one workflow at a time. The preceding
  Windows baseline provides original red; unmodified server-auth pair must pass.
- Record each shard's exact head/job/count and assert all six success. No
  assertion retry accepted as a fix. macOS is not a completion dependency.
- Update `structure/04_transports-and-sidecars.md` and the existing cancellation
  paragraph in `docs-site/src/content/docs/reference/proxy-formats.md` to state
  eager/tee share caller-cancel accounting without changing terminal precedence.
- Separate follow-up PR layers for quota integration and eager cancellation;
  merge bottom-up --admin at verified heads. If rebasing brings new code, inspect
  the delta and repeat Windows integration evidence as needed; do not call old
  evidence exact-head evidence.
- Add an existing-corpus occurrence or a new landmine only when evidence proves
  novelty; validate corpus locally with its scripts, not an OpenCodex full suite.
- Completion record belongs to this unit and c-6. A failed Windows shard keeps
  c-6 open, regardless of macOS or prior pre-merge green runs.

## Implementation evidence before Windows dispatch

New rejected-read/caller-signal test on original source: exit1, expected no
synthetic outcome but received [failed]. After source fix: exit0, cancellation
once and downstream closed. Full eager file:71pass/0fail,354assertions. Failed-tail,
passthrough-abort and stream-capability files:73pass/0fail. WS upstream file:
40pass/1skip/0fail. Unchanged server-auth caller/reset pair:2pass/0fail locally
(Windows evidence still required). Typecheck exit0. Docs build:425pages,exit0.
Independent implementation reviewer: PASS, no blockers; caller provenance,
listener/timer cleanup, real terminal precedence and negative reset preserved.

Verification command correction: sse-failed-tail lives under tests/responses/,
and the WS file is tests/responses/ws-upstream.test.ts. An initially supplied
nonexistent filter selected no extra file; the corrected commands above were
run separately and counts match the files actually executed.
