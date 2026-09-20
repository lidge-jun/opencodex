# Lane C2 — telemetry projections on the landed vocabulary

Status: OPEN. Branch `codex/260920-lane-c2-telemetry-projections`, cut from `dev` at
`043aa435ff8f86095f55cbe08f74d45b9858da59`, which is where lane C's stage, cause and resend
vocabulary landed ([020_lane_c.md](020_lane_c.md)). One branch, ordered commits, one pull request
to `dev`.

## What this lane fixes

The completion condition for bundle 14 is that the UI, the durable log and Prometheus agree on
logical and physical counts and on terminal classification. They did not, and the disagreement was
not subtle:

- Three surfaces classified a terminal three different ways. The durable row carried
  `terminalStatus` and `closeReason`; the exporter kept its own private `classifyResult`; the
  dashboard read the numeric HTTP status and nothing else. A turn cut short by
  `max_output_tokens` is durably `status: 200, terminalStatus: "incomplete"`, which the exporter
  reported as `incomplete` and the dashboard rendered as a green 200. The metric said incident and
  the operator saw success, for the same request.
- The dashboard showed no physical send count at all. `sendCount` and `spend` were never rendered,
  so an attempt that sent three times appeared as one row with nothing to say otherwise.
- The dashboard's recovery-kind union had drifted to nine of the durable thirteen, so `key-401`,
  `oauth-account-429`, `opaque-blob-rejection` and `reasoning-effort-downgrade` all reached the
  operator as "Unknown recovery reason" — four real causes rendered as the absence of one.

The fix is one classifier in `src/usage/request-outcome.ts` that the exporter imports, the
management payload already carries, and the dashboard calls. Agreement is structural rather than a
rule someone maintains. The data was never missing: `requestLogDto` spreads the whole durable
entry, so the page only had to declare the fields and stop reinventing the precedence.

The exporter's result label set **is** the shared vocabulary rather than a copy of it. Restating
those four strings is what let the two drift while both looked correct.

### The dashboard may only reach a contract leaf

Adversarial review caught this before the first push and it is worth recording, because the
mistake is invisible from the backend side. The dashboard is a separate TypeScript project with
`erasableSyntaxOnly`, and a **type-only** import still pulls the imported file's entire import
graph into that project. Importing the recovery roster from `src/usage/log.ts` therefore dragged
`node:fs`, `node:crypto` and the config barrel into the browser build, where a parameter property
in `src/config/atomic-write.ts` does not compile. "It is only a type import" is not a defence.

So the names a browser legitimately needs now live in `src/usage/telemetry-contract.ts`, which has
no imports at all and must keep none. `src/usage/log.ts` re-exports them so every existing importer
keeps its path, and `src/lib/request-failure-model.ts` stopped depending on the ledger module as a
side effect. Three cases hold the boundary: the page must not name `src/usage/log`, the contract
must have no imports, and the outcome module must reach nothing but the contract.

The same review caught the send total disagreeing in the other direction. An earlier draft reported
`max(sends, reserved)`, on the reasoning that a budget charge with no attempt row behind it is
still a send that left. That is true, and it still made the dashboard say four where the exporter,
summing the same attempts the recorder summed, said three. Two defensible formulas are two answers;
the surfaces now read the recorded totals and recompute nothing, and a case asserts the exporter's
`opencodex_physical_sends_total` equals what the dashboard shows.

## Dispositions, updated

### Who is credited, and why only one

Attribution follows what was actually taken, not what was read. Only #2366's work is carried here,
so only its author carries a `Co-authored-by` trailer, and that trailer sits in a branch commit so
it survives the squash. The other three were analysed in depth and their designs informed the
deferral reasons below, but no line of their work is in this branch; crediting them would claim a
landing that did not happen and would make the contributor graph say something false.

A note on the gate, because getting this right took two attempts. `pr-carry-attribution.cjs` looks
for a carry verb and reads the pull request numbers in the eighty characters after it. A first
draft of the description read "#2366's rehydration half is carried and ... ; #3748 is blocked",
which put #3748 inside that window and asked for a trailer naming an author whose work is
deliberately absent. Rewording split the sentences — but it also moved #2366 out of every window,
so the check went green by having nothing left to check. A gate that passes because the trigger was
removed is not evidence. The provenance sentence now names #2366 after the verb, in the commit
itself, so the check resolves the author and matches the trailer instead of skipping.

### #2366 (chilung-cgu) — partially carried

**Carried:** the rehydration and UI-projection half. The durable terminal facts now reach an
operator instead of stopping at the API boundary.

**Not carried, and why:** `FailureSide` and the seven-member `FailureStage` are a second
attribution vocabulary beside the one that just landed, and defining two is the exact class that
blocked 2.60.0. The PR also widens `transportPhase` and `terminalSource` from their existing closed
unions to arbitrary strings, which would let bounded upstream-controlled text into the durable row;
those validators stay. Copying the request-relative timeline into an attempt at finalization is
simply wrong — request-relative elapsed values do not become attempt-relative by being copied.

**Next step, specified:** persist `failureStage?: RequestFailureStage` and
`failureCause?: RequestFailureCause` on `PersistedUsageAttempt`, projected onto the entry, with
`resendPermission` computed at read time and never persisted. That is the smallest durable record
that makes a failure attributable, and it is the prerequisite for #3748 below. It is not in this
branch because it is new classification logic on the finalization path, and a branch whose only
verification is static review plus hosted CI should not add a new derivation and the surface that
consumes it in the same change.

### #3748 (yansigit) — still deferred, reason updated

The earlier reason was the parallel SQLite store. That still holds, but the blocking reason today is
narrower and more useful: **the recorder does not yet record why a request finally failed.**
`causeForRecoveryKind` answers why a *recovery* was attempted, which is a different question — a
request that failed without any recovery, or that recovered and then failed for another reason,
has no cause to group by. A derived failure ledger therefore cannot compute a grouping key today
without reading `errorCode` or `upstreamError`, which are open strings.

The design is otherwise settled and should be built once the field above exists: group failed rows
scanned through the existing `scanUsageLedgerCooperatively` by a versioned fingerprint over closed
vocabularies only — cause, status class, inbound protocol, terminal status, close reason, transport
phase, terminal source — with fixed tuple positions so a missing field cannot collide structurally.
No provider, no model, no account label, no free-text signature. First-seen, last-seen and count
fall out of the scan; no second timestamp list is retained.

Two parts of the original are not derivable from request history at all: the mutable
`monitoring/dispatched/fixed/ignored` remediation status and its free-text notes. Those are
operator state, not event history, and need their own owner rather than being presented as a
derived ledger.

### #3983 (yansigit) — still deferred as an emission path, reason updated

The earlier reason was "a second emission path". The updated reason is stronger: the path is not
ephemeral. `emitDebugLine` writes the in-process ring **and** stderr, and stderr is redirected to
the service log under both launchd and systemd, so an installed service gets a durable per-event
record with its own retention, sequencing, request identity and masking — beside the ledger and
sourced from something other than it.

Two further facts: four of its eighteen files no longer apply, including
`run-turn-execution.ts` where carrying it literally would regress the current send-budget
accounting; and its per-content HMAC is a process-global random key, so equality of every prompt,
tool name and error message is correlatable for the process lifetime.

**The useful half, specified:** a bounded normalized summary on the attempt — adapter events,
actually relayed events, semantic bytes, side-effect events, terminal events — counted where the
event is delivered rather than where it is read. That keeps the signals worth having (missing
terminal, adapter-to-relay loss, empty output, partial output size) and inherits the ledger's
normalization, masking and retention instead of inventing its own.

### #5063 (Vocllum) — still deferred, reason updated

The earlier reason was "a separate product slice with GUI surface". The updated reason is a
correctness one found while reviewing it against current `dev`:

- Retention captures the file size, copies a retained suffix to a temp file and renames. A row
  appended by **another process** between the size snapshot and the rename is silently dropped.
  The PR's own "concurrent re-entrancy" test performs two sequential calls and says it cannot test
  true concurrency.
- Both the temp-file fsync and the parent-directory fsync failures are swallowed, and replacement
  proceeds anyway. There is no revision, inode or digest comparison immediately before the rename.
- It hand-rolls the copy rather than using `src/config/atomic-write.ts`.
- It does not clear the 2,000-entry request-log ring, so rows deleted from disk stay visible
  through `/api/logs` until eviction or restart.
- `src/server/index.ts` is 892 lines against a 893-line cap, so the startup wiring cannot land as
  written without offsetting a line elsewhere.

Retention on the canonical ledger is the right architecture and its derived-index invalidation is
correct in shape. It needs a ledger-owner serialization and revision contract first.

### The dashboard roster defect — fixed here

Recorded in [020_lane_c.md](020_lane_c.md) as deferred because it needed strings across ten
catalogs and a screenshot. It is fixed in this branch because the agreement condition required
touching this page anyway. The union is now derived from the durable roster and a `satisfies`
clause makes the next added kind a typecheck failure rather than a silent fallback.

**This trips the `missing_ui_screenshot` gate.** That gate fires on changed paths under `gui/`,
not on words in the description, and this lane may not build or run the GUI, so it cannot produce
the screenshot itself. A maintainer comment or the `gui-screenshot-waived` label is the documented
resolution; the visible change is four attempt rows that said "Unknown recovery reason" now naming
their cause, plus an outcome row and a send count in the detail dialog.

## Retention and masking, stated in one place

The instruction was to unify rather than add a fifth policy. The honest form of that today is to
record what already exists and bind projections to it, because every bound below is already
enforced and none of them needs a new owner:

| Surface | Bound |
| --- | --- |
| Usage ledger rows (scanner) | 1 MiB per row, 1 MiB read chunks, 64 KiB boundary digest |
| Startup request-log hydration | 64 MiB read ceiling |
| Management usage snapshot | 64 MiB, 500,000 rows |
| Usage metadata strings | sanitized, capped at 64 characters |
| Upstream error text | `redactSecretString`, capped at 500 characters |
| Conversation correlation | rejects over 4,096 characters, persists a 32-hex digest |
| Debug ring | 2,000 lines, 16 KiB per line, 64 subscribers |
| Request-log ring | 2,000 entries plus app-owned-memory eviction |
| Routing history | rebuildable projection; pages capped, records over 1 MiB omitted |
| Email masking | masked unless `privacy.maskEmails: false` |

The policy this lane adopts: **masking happens at capture and projection boundaries, retention
deletes canonical rows, and every derived surface inherits both.** A projection does not get its
own TTL, its own row cap or its own redaction pass. The failure projection specified above obeys
this by construction — it holds only aggregates and a scanner checkpoint, and discards them when
the source is replaced.

## Issues

#4191 and #5180 stay open and are not closed here. What narrowed: the dashboard now reports the
terminal classification and the send count the durable row always carried, so an operator can tell
an incomplete turn from a successful one without reading the ledger. What remains unchanged: the
WebSocket-to-SSE fallback for #4191, and the shared cooldown and `Retry-After` handling for #5180.

## Verification

Static source review plus exact-head hosted CI.

NOT RUN on this branch, by instruction: `bun run test`, any individual `bun test` file,
`bun run typecheck`, `bun run build:gui`, `bun run lint:gui`, `bun install`,
`bun run structure:check`, `bun run privacy:scan`, and any live `ocx` execution. None of these may
be recorded as passing.

Checked statically on this branch:

- all eleven new label keys are present in all ten catalogs, and the catalog edits are purely
  additive (+11 lines, 0 removed, per file);
- the ten catalogs are explicitly exempt from the file-size ratchet, for the reason the exemption
  list gives: they grow by one line per UI string across every locale at once;
- no ratchet-capped file is touched by this branch;
- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json` agree key for
  key, and the new test's regex seed resolves to the same domain it is registered to, which is the
  oracle that failed lane C on its first push;
- no test restates a source constant: the outcome vocabulary, the recovery roster and the label
  keys are all read from the modules that declare them.
