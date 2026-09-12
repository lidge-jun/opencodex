# wp4 — land what the probes proved, or record the verdict

One branch per wp2/wp3 outcome. Only the branch the evidence selects gets built.

## Branch A — wp2 = LATE

The 50 ms base grace cancels the stream before upstream serializes conversation state.
**Branch A is one edit.** The wp1 audit removed a second one; see "What branch A is
deliberately not doing" below.

**A1. MODIFY `src/adapters/cursor/live-transport.ts`.** Give a drained client-tool
turn one bounded extension when a checkpoint is wanted and none has arrived. The
extension must happen *before* the terminal events are pushed — once `done` reaches
the client the turn is over.

```diff
   private scheduleClientToolFinalize(
     state: ReturnType<typeof createCursorProtobufEventState>,
     push: (message: CursorServerMessage) => void,
+    graceMsOverride?: number,
   ): void {
     this.clearPendingFinalize();
     this.pendingFinalize = setTimeout(() => {
       this.pendingFinalize = undefined;
      if (this.expectedClose) return;
-      const terminal = finalizeAfterDrain(state);
-      if (terminal.length === 0) return;
+      // A suspended tool turn is the turn whose state we most want to resume from,
+      // and the one turn we cancelled before upstream could send it (#4245). Extend
+      // once, bounded, rather than raising the blanket grace: the common case stays
+      // at 50 ms and a stream that never sends a checkpoint still dies at a known
+      // deadline.
+      // This MUST run before finalizeAfterDrain(): that call reaches
+      // finalizeTurnEvents(), which sets state.terminated = true, and
+      // finalizeAfterDrain() returns [] for a terminated state. Draining first and
+      // then re-arming would make the retry return [] at the length check and leave
+      // the stream uncancelled. So mirror its two guards here instead of calling it.
+      if (!state.terminated
+        && state.openToolCalls.size === 0
+        && this.wantsCheckpointCapture
+        && !this.capturedCheckpointBytes
+        && !this.checkpointGraceExtended) {
+        this.checkpointGraceExtended = true;
+        this.scheduleClientToolFinalize(state, push, CHECKPOINT_CAPTURE_GRACE_MS);
+        return;
+      }
+      const terminal = finalizeAfterDrain(state);
+      if (terminal.length === 0) return;
       for (const event of terminal) push(event);
       debugProviderDiagnostic("cursor", "client-tool-suspend", {
         reason: "Responses bridge owns client tools; ending turn without fake mcpResult",
         framesReceived: this.framesReceived,
         elapsedMs: Date.now() - this.turnStartedAt,
+        graceMs: graceMsOverride ?? this.activeClientToolFinalizeGraceMs,
+        checkpointGraceExtended: this.checkpointGraceExtended,
       });
       this.cancelCursorRun();
-    }, this.activeClientToolFinalizeGraceMs);
+    }, graceMsOverride ?? this.activeClientToolFinalizeGraceMs);
   }
```

Also NEW beside the constants at :114-117:
`const CHECKPOINT_CAPTURE_GRACE_MS = <measured>;` sized from the arrival latency wp2
actually observed, not guessed. NEW private fields beside `pendingFinalize`:
`private checkpointGraceExtended = false;` and
`private wantsCheckpointCapture = false;` — the latter set where the run request is
applied (:643, next to `activeClientToolFinalizeGraceMs`) from
`activeRequest.contextUsageStoreCheckpoints !== false`. Reset
`checkpointGraceExtended = false` in `open()` (:1033) alongside `framesReceived`.

The added `graceMs` field also repays wp2's instrumentation debt: after this lands,
the NEVER verdict 010 could not reach becomes measurable from shipped diagnostics.

**Termination.** `checkpointGraceExtended` is set before the re-arm, so at most one
extension happens per turn; the second pass falls through to `finalizeAfterDrain` and
cancels. A sibling tool call reopening `openToolCalls` during the window is handled by
the `size === 0` guard, which also stops the one extension from being spent on a turn
that was not actually drained.

### A1b — fire early when the frame lands (required, not optional)

A1 alone makes every suspended tool turn pay the full extension, including the turns
that were never going to send a checkpoint. Measured arrival is well inside the window,
so waiting out the remainder is pure added latency on the tool path.

Make the timer body reusable and let the capture site run it immediately:

```diff
   private pendingFinalize?: ReturnType<typeof setTimeout>;
+  private pendingFinalizeRun?: () => void;
+  private checkpointGraceExtended = false;
+  private wantsCheckpointCapture = false;
```

`scheduleClientToolFinalize` stores the callback instead of inlining it:

```diff
     this.clearPendingFinalize();
-    this.pendingFinalize = setTimeout(() => {
+    const run = (): void => {
       ... body from A1 ...
-    }, graceMsOverride ?? this.activeClientToolFinalizeGraceMs);
+    };
+    this.pendingFinalizeRun = run;
+    this.pendingFinalize = setTimeout(run, graceMsOverride ?? this.activeClientToolFinalizeGraceMs);
```

and `handleServerMessage`, right after `capturedCheckpointBytes` is set:

```diff
     if (message.message.case === "conversationCheckpointUpdate") {
       try {
         this.capturedCheckpointBytes = toBinary(ConversationStateStructureSchema, message.message.value);
       } catch {
         this.capturedCheckpointBytes = undefined;
       }
+      // We are only still open because the grace was extended waiting for exactly this
+      // frame. Stop waiting. Deferred by one tick so this frame finishes being mapped
+      // and pushed before the terminal events go out — firing inline would reorder them.
+      if (this.checkpointGraceExtended && this.pendingFinalizeRun && this.capturedCheckpointBytes) {
+        const run = this.pendingFinalizeRun;
+        this.clearPendingFinalize();
+        this.pendingFinalizeRun = undefined;
+        this.pendingFinalize = setTimeout(run, 0);
+      }
     }
```

Net effect: a turn whose checkpoint arrives pays roughly the real arrival latency; a turn
whose checkpoint never arrives pays `CHECKPOINT_CAPTURE_GRACE_MS` once and then dies at a
known deadline, as before.

### Sizing `CHECKPOINT_CAPTURE_GRACE_MS`

Measured on macbookpro-2 against a live account, 12 tools held constant on the wire:

| Local grace | Post-`toolCallStarted` checkpoint | `capturedBytes` |
|---|---|---|
| 50 ms | no | 0 |
| 1500 ms | yes | 3036 |

750 ms and 1000 ms arms were attempted but their results are void — they were collected
through the line-count windowing that `012` shows returns empty once the 500-line log
ring fills. They are not evidence and are not used here.

**Choose 1500 ms**, the only window with a clean positive. With A1b the cost is paid only
when no checkpoint comes. Revisit with a bracketed rerun using tail-based reading if that
ceiling proves too slow in practice; do not lower it on the void 750/1000 ms data.

### Acceptance criteria for this work-phase

1. `bun run typecheck` clean.
2. A focused test proves: checkpoint after `tool_call_end` but past the base grace is
   captured and committed for an external wire model with `checkpointUsable: false`;
   a transport that never sends one still refuses and still cancels;
   a native wire model still refuses (the gate is untouched);
   the extension happens at most once.
3. `bun test tests/providers/cursor` green.
4. No change to `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.

## Landed

`src/adapters/cursor/live-transport.ts`: `CHECKPOINT_CAPTURE_GRACE_MS = 1_500`, the
exported pure predicate `shouldExtendForCheckpointCapture`, the one-shot extension inside
`scheduleClientToolFinalize` placed before `finalizeAfterDrain`, the early fire from the
`conversationCheckpointUpdate` branch of `handleServerMessage`, and `graceMs` /
`checkpointGraceExtended` added to the `client-tool-suspend` diagnostic.

Tests in `tests/providers/cursor/cursor-tool-finalize-race.test.ts`, reusing that file's
existing transport harness. Measured in the suite: the turn that never sends a checkpoint
finalizes at 1816 ms, the turn whose checkpoint arrives finalizes at 256 ms. That gap is
A1b doing its job — without it both would sit out the full window.

Two low findings from the implementation audit were folded rather than accepted:
`pendingFinalizeRun` is restored alongside the early-fire timer so the pair never
diverges, and `capturedCheckpointBytes` is reset in `open()` so a reused transport cannot
inherit a stale snapshot. Neither was reachable in production; folding them removes the
reachability argument.

**Still open:** the native wire-model gate. `capturedAfterClientTool` is an arrival proof,
not a coverage proof, so wp5 owns decoding the captured `ConversationStateStructure`
before that gate moves.

### What branch A is deliberately not doing

The obvious companion edit — dropping `isCursorExternalWireModel` from
`toolSuspendedCommit` in `src/adapters/cursor.ts:190` so native models also commit a
tool-suspended checkpoint — is **excluded**, folded from the wp1 audit (high).

`capturedAfterClientTool` is set at `cursor.ts:312` from *arrival order*
(`capturedAfterClientTool = emittedClientTool` when the byte-set changes). But
`live-transport.ts:1221` classifies `conversationCheckpointUpdate` as **liveness-only**,
the same bucket as a heartbeat. A periodic liveness snapshot can arrive after the tool
call while its *contents* predate it. Arrival order is therefore not coverage, and
committing on it would claim a prefix the bytes do not contain — the exact failure this
unit was opened to prevent.

A1 alone is still a real fix: it makes the external tool-suspended path, which the code
already intends and which has never once succeeded in production, actually work.
`checkpointUsable` stays `!toolSuspendedCommit`, so nothing widens what a checkpoint
claims.

Extending this to native models needs content coverage proven, not assumed. That is a
separate work-phase (wp5) whose first task is to decode a captured
`ConversationStateStructure` and check whether the tool call is in it. The wp1 auditor
explicitly left that decode UNVERIFIED; do not skip it.

**Tests.** `tests/providers/cursor/cursor-tool-suspended-checkpoint.test.ts`: a fake
transport that emits `conversationCheckpointUpdate` after `tool_call_end` but later
than the base grace must yield `checkpointRef` defined and `checkpointUsable: false`;
one that never emits must still refuse with `capturedBytes: 0`; and composer-2.5 must
keep whatever `cursorNeedsExternalToolContinuation` already guarantees.

**Risk.** Every suspended tool turn gets up to one extra bounded wait before the
stream closes. That is added latency on the tool path, so the constant must come from
the measurement, and the no-frame case must still terminate.

## Branch B — wp3 = UNSTABLE

Identity, not capture. The checkpoint exists and is simply unreachable because turn
N+1 derives a different `conversationId`. The fix is in how
`_cursorConversationId` / `_providerContinuation` are threaded on the Responses path,
which is request-assembly territory rather than adapter transport.

Do not start this as a patch. Write the observed identity chain into a `021` doc
first, then decide whether the correct owner is the Cursor adapter or the Responses
state layer. If it turns out to need `src/server/responses/core.ts`, it is out of this
unit's scope and becomes NEEDS_HUMAN with the evidence attached.

## Branch C — wp2 = NEVER and wp3 = STABLE

Nothing is safely fixable here. Deliverable is the recorded verdict: this file gains a
closing section, `000_plan.md` gets the outcome, issue #4245 gets a comment naming
what was measured and what would change the answer, and the unit moves to `_fin/`.

A recorded negative with captured evidence is a real outcome. The failure mode this
unit was opened against was a plausible patch that fixed nothing, so shipping nothing
beats shipping that.
