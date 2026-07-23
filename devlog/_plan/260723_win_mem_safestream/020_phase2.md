# 020 — WP2: Eager bounded single-reader relay + core.ts wiring + invariant lockstep

Depends: WP1 (decideEagerRelay + config.streamMode). Consumes: 001 §1-§3, §5.

WP2-P stale-check (post-WP1 tree 3781448a): core.ts SSE branch unchanged at
:1024-1075; consumeForInspection at relay.ts:407 with per-chunk machinery =
buffer + decoder + nextSseBlock + terminalStatusFromSsePayload +
completedResponseFromSsePayload + inspectResponseLogSsePayload +
createFirstOutputReporter; mirror comment at index.ts:135-150; invariant test
string list confirmed (bans relaySseWithHeartbeat( and trackStreamLifetime( in
the sse branch slice). `config` is in scope at the wiring site (handleResponses
param). decideEagerRelay imported from ../lib/bun-stream-caps (WP1, landed).

## Why NEW module instead of extending relaySseWithHeartbeat (P3 disposition)

relaySseWithHeartbeat is client-paced pull: inspection runs inside pull(), so a
stalled client delays terminal recording, and there is no post-cancel drain or
bounded queue. The eager relay is a producer-loop + bounded-queue + drain shape —
a different concurrency structure, not a parameterization. Retrofitting would
internally fork heartbeat and risk its 3 existing call sites. NEW module keeps
the risky surface isolated and separately testable.

## NEW src/server/relay-eager.ts

Contract (preserves the FULL side-effect inventory of 001 §2):

```ts
export type EagerRelayHooks = {
  inspectChunk: (chunk: Uint8Array) => void;   // feeds existing SSE inspection
  sawTerminal: () => boolean;                   // audit blocker 1: relay observes terminal state
                                                // (fed by the inspector; ends discard-drain early,
                                                //  suppresses onClientCancel after late terminal)
  onClientCancel: () => void;                   // fires ONLY if no terminal later arrives
  onDone: () => void;                           // exactly once, after upstream fully drained/errored
};

export type EagerRelayOptions = {
  maxQueueBytes?: number;      // default 8 MiB — bounded client queue
  postCancelDrainMs?: number;  // default 15000 — bounded discard-drain window
  postCancelDrainBytes?: number; // default 32 MiB — drain byte cap
};

export function relaySseEagerBounded(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  hooks: EagerRelayHooks,
  opts?: EagerRelayOptions,
): ReadableStream<Uint8Array>;
```

Semantics:
1. EAGER producer loop `reader.read()` runs independently of client pull; every
   chunk → `inspectChunk` FIRST, then enqueue to a byte-bounded queue.
2. Backpressure: when queue > maxQueueBytes, producer PAUSES (await queue
   drain) — upstream stops being pulled → fetch-level backpressure propagates.
   This is the actual #314 mitigation: bounded JS queue instead of unbounded
   native tee branch queue. HONESTY CAVEATS (audit M5): (a) efficacy assumes a
   gate-passing runtime also carries the #29831 fetch-backpressure fix —
   ordering assumption, unverified; (b) whether Bun's native Response sink
   pull-paces a JS ReadableStream is unverified — bun:test JS readers always
   pace, so tests prove queue mechanics, not native sink pacing. Both stay
   under the "awaiting Windows user verification" label.
2b. PAUSE-GATE WAKEUP (audit blocker 2): the pause gate is a promise resolved
   by ANY of: client read (queue drained below cap), client cancel(), upstream
   AbortController signal abort (shutdown), or producer teardown. cancel() and
   the upstream.signal listener both resolve the gate so the producer always
   resumes to run discard-drain/cleanup — onDone/unregisterTurn are
   unconditionally reachable; drainAndShutdown never hangs on a paused relay.
3. Client cancel: switch to DISCARD-DRAIN mode — keep reading upstream (chunks
   go to inspectChunk only, queue dropped) until hooks.sawTerminal() OR drainMs OR
   drainBytes cap; then `upstream.abort()`. Preserves #44 late-terminal
   semantics with a BOUND (today's tee drain is unbounded — improvement).
   If terminal never arrives within bounds → hooks.onClientCancel() fires.
   Stated behavior change on the eager path (allowed): client-cancel request-log
   finalization may be delayed by up to drainMs/drainBytes after the cancel.
4. Producer error mid-stream → controller.error + onDone. Shutdown/abort
   discrimination (audit M3): before any synthetic failed-502 recording, check
   `upstream.signal.aborted` (and cancelled state) — abort-driven teardown must
   NOT record synthetic terminals, mirroring the cancelled-flag suppression at
   relay.ts:499-505.
5. onDone exactly-once → unregisterTurn parity.

Inspection reuse: extract the per-chunk SSE scanning state machine from
consumeForInspection (buffer + nextSseBlock + terminal/completed-response
detection, relay.ts:407-505) into a shared factory
`createSseInspector(handlers) → { feed(chunk), finish(opts), reported(): boolean }` in relay.ts, used by
BOTH consumeForInspection (unchanged behavior) and the eager relay hooks.
consumeForResponseLogMetadata parity: the inspector factory takes the same
logCtx/onCompletedResponse/onFirstOutput handlers; the non-recording variant
constructs it without onTerminal recording.

Extraction-fidelity invariants (audit M4 — MUST hold, add extraction-lock tests):
- reported gating: logCtx SSE inspection stops after terminal (relay.ts:480);
  in the metadata config `reported` stays permanently false because no
  onTerminal is configured — the same gate reproduces both behaviors.
- done-flush asymmetry: the finish() trailing-buffer scan is skipped when
  reported (relay.ts:448) while per-block onCompletedResponse continues firing
  after reported (relay.ts:494).
- logCtx mutation order: transportPhase/terminalSource are set BEFORE
  onTerminal fires (relay.ts:486-491).
- finish() cannot decide synthetic-incomplete alone: caller passes cancelled
  state; factory exposes reported() so the caller makes the
  `!reported && !cancelled` decision (relay.ts:467-470).

## MODIFY src/server/responses/core.ts (~:1058-1073)

Before (win32 branch of clientBody ternary):
```ts
const clientBody = process.platform === "win32" && !hasResponsesItemIdRepair(repairConfig)
  ? nativeBody
  : relaySseWithFailedTail(repairedBody, upstream);
```

After (gate consulted ONLY on win32-no-repair; all other paths byte-identical):
```ts
const winNoRepair = process.platform === "win32" && !hasResponsesItemIdRepair(repairConfig);
const eagerDecision = winNoRepair
  ? decideEagerRelay(config.streamMode ?? "auto")
  : null;
if (eagerDecision?.useEagerRelay) {
  // #314 path: no tee — single eager bounded reader with inline inspection.
  // (constructed INSTEAD of the tee above; see restructure note below)
} 
const clientBody = winNoRepair && !eagerDecision?.useEagerRelay
  ? nativeBody
  : relaySseWithFailedTail(repairedBody, upstream);
```

Restructure note: the tee() call itself moves behind the decision — eager mode
never calls tee(): upstream body goes straight into relaySseEagerBounded with
inspector hooks wired to the SAME callbacks currently given to
consumeForInspection/consumeForResponseLogMetadata (reportNativeTerminal,
unregisterTurn, onNativePassthroughCancel, rememberPassthroughResponse,
onFirstOutput, logCtx). registerTurn stays before either branch. Exact final
shape to be re-verified at WP2's own P against the then-current tree.

## Lockstep updates (audit F5/H4)

- src/server/index.ts:131-150 mirror comment: describe BOTH shapes (default tee
  + gated eager relay) and keep banned-identifier lines true.
- tests/passthrough-abort.test.ts:33-60: amend source-invariant to assert the
  new two-shape contract: tee() present, `? nativeBody` present, AND
  `decideEagerRelay` + `relaySseEagerBounded` referenced; still bans
  relaySseWithHeartbeat(/trackStreamLifetime( in the passthrough block.
- src/lib/crash-guard.ts:160-166 comment: note shape 2 applies to the legacy
  tee path (still default); eager path may surface its own benign teardown
  shape — leave detection unchanged, extend comment only.

## Activation scenarios

- streamMode unset ("auto") on any current runtime → tee path (byte-identical
  behavior; existing tests prove).
- streamMode "eager-relay" → eager path: slow-client test shows producer pause
  (queue cap respected); cancel test shows discard-drain then late terminal
  recorded as completed (NOT cancel); drain-timeout test shows onClientCancel
  after bounds with upstream aborted.
- streamMode "legacy-tee" on a future fixed runtime → tee path.

## TESTS

- NEW tests/relay-eager.test.ts: synthetic ReadableStream fixtures —
  (a) side-effect parity: terminal recorded once, completed-response captured,
  onDone once, first-output once; (b) bounded queue: producer pauses at cap with
  a slow reader — deterministic pull-count fixture (upstream pull() resolves
  from a deferred queue + invocation counter; assert pull count freezes at
  ceil(cap/chunkSize)+1 then resumes exactly once per client read; no
  wall-clock); (c) post-cancel late terminal → terminal recorded, onClientCancel NOT
  fired; (d) post-cancel drain timeout → onClientCancel fired, upstream.abort
  called; (d2) post-cancel drainBytes cap → same, byte-bounded branch;
  (e) mid-stream error → controller.error + onDone; (f) cancel-while-paused and
  abort-while-paused → gate wakes, onDone fires, no deadlock; (g) shutdown
  abort mid-stream → onDone fires, NO synthetic failed-502 recorded;
  (h) extraction-lock: reported-gated logCtx inspection, done-flush skip when
  reported, post-reported onCompletedResponse continuation.
- MODIFY tests/passthrough-abort.test.ts per lockstep above.
- Existing consume-for-inspection-cancel.test.ts / server-combo-failover-e2e
  stay green untouched (default path unchanged).

## Verification (C)

- bun x tsc --noEmit; bun test tests/relay-eager.test.ts tests/passthrough-abort.test.ts;
  bun run test (full — shared server surface); bun run privacy:scan.
