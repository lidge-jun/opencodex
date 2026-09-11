# 120 — #1527: enforce the replay envelope on the final root set

Revised after the plan audit returned FAIL. Blockers 8 through 13 applied. The
first draft would have broken legitimate checkpoint continuation and measured the
envelope in the one place where the true root set is not yet known.

## Scope

IN: `src/adapters/cursor/protobuf-request.ts` (`rootPromptMessages`,
`buildPreparedCursorRunRequest`), `src/adapters/cursor/cursor-errors.ts`,
`src/adapters/cursor/transport-retry.ts`, `src/adapters/cursor/native-exec.ts` (a
read-only blob-size accessor), `src/adapters/cursor.ts` (terminal catch),
`tests/cursor-blob.test.ts`, `tests/cursor-transport-retry.test.ts`,
`tests/cursor-adapter.test.ts`.

OUT: native Composer and Auto replay behavior, the #2277 checkpoint continuation
design, and the transport retry policy itself.

One PR: final-envelope construction, its typed failure mapping, and the
regressions. The audit found no seam that splits cleanly, because the guard and the
measurement it depends on are the same change.

## Defect 1 — the envelope is measured on the wrong set

`CURSOR_EXTERNAL_ROOT_BLOB_LIMIT` (192) and `CURSOR_EXTERNAL_ROOT_BYTE_LIMIT`
(512 KiB) live at `src/adapters/cursor/protobuf-request.ts:71-73` and are checked
against `keptPrior` only. System roots are all retained before the history budget is
computed (`:309-380`), and trailing active tool results are byte-pruned but never
count-pruned.

Reproduced in isolated probes: 193 roots from 193 system prompts; 614,430 root bytes
from a single 600 KiB system prompt; 194 roots from one system plus 193 trailing
results. Each reported `continuationMode: "full-replay"`.

Two further escapes the first draft missed:

- **Cumulative checkpoint roots (blocker 9).** Suffix roots are appended AFTER
  existing checkpoint roots (`:937-947`) but `rootPromptMessages` sees only the
  suffix. A probe with 192 checkpoint roots plus a two-root suffix emitted 194.
- **The empty-history early return (blocker 10).** `rootPromptMessages` returns
  before external enforcement when `rawMessages` is empty (`:198-215`). A guard
  placed only in the external-history branch leaves this path unbounded; a probe
  emitted 193 system roots through it.

Both mean the guard cannot live inside `rootPromptMessages`. The final root set
exists only after checkpoint or full-replay assembly completes (`:959-974`), and
that is where enforcement belongs.

## Defect 2 — a tool result can be sent without the request that caused it

External replay omits assistant tool-call roots by design (`:288`). The pruner puts
every trailing tool result into `active` (`:321-326`), so one large result can
consume the whole history budget and drop the preceding user turn (`:348-357`). The
orphan guard preserves that lone result and sets `historyMessageStart` to it
(`:365-369`); `conversationTurns()` then finds no current user turn and drops it from
`turns[]` too (`:719`, `:763`).

The emitted request is system roots, an assistant-role tool-result marker, zero turn
blobs, and the generic Continue action. The audit's one correction to the framing:
it is not literally instruction-free — system instructions and the Continue action
are present. What is missing is the initiating user instruction, which is what makes
a large-context turn answerable. A model given that answers in a handful of tokens,
matching the report (200 OK, 4-19 output tokens at 80-95k input), reproduced with no
Cursor account.

`tests/cursor-blob.test.ts:474` asserts the oversized result and its truncation
marker survive. It never asserts the initiating turn survives, which is why CI stayed
green over a request shape that cannot work.

## Blocker 8 — why the obvious rule was wrong

The first draft said: never emit a result-only continuation. That is correct for full
replay and WRONG for checkpoint continuation. Production sets `checkpointSuffixStart`
to the covered message count (`src/adapters/cursor/request-builder.ts:479-488`), so a
valid suffix may legitimately begin with a tool result — the initiating turn is
already inside the checkpoint. `rootPromptMessages` receives only the sliced suffix
(`:915-933`) and cannot recover it, so a blanket rule would reject or corrupt correct
continuation.

The distinction must be an explicit argument, not inferred from message shape. Pass a
replay origin: `"checkpoint-covered"` only from the branch where checkpoint decoding
succeeded (`conversationState` established at `:917-918`) and `checkpointSuffixStart`
passed validation (`:919-926`); `"full-replay"` from every fallback path (`:959-960`).
Do not derive it from the advisory `request.continuationMode`.

## Change map

### `rootPromptMessages` — replay origin

Accept an explicit origin (`:198-204`).

Full replay retains the initiating user or developer root together with every
contiguous trailing tool-result root; if that group cannot fit, fail rather than emit
a result-only replay. Checkpoint-covered replay may begin with tool results.

### `rootPromptMessages` — atomic tool-result block (blocker 11)

The first draft's "atomic block" contradicted the 192-root cap: 193 results plus a
system root cannot be both. Atomicity means MEMBERSHIP: every result present in
original order, or construction fails. Explicit text truncation of a result may
remain, but whole-result deletion — `shift`, `filter`, marker omission — is forbidden
(`:318-341`). A count-only assertion would let an implementation silently drop
results and still pass, so tests assert result IDENTITY, not just count.

### `buildPreparedCursorRunRequest` — one measurement, one guard

Immediately after `conversationState` is final (`:959-994`), measure
`rootPromptMessagesJson` once: `rootCount` from the final ID list; `rootBytes` as the
sum of stored blob lengths, counting repeated IDs repeatedly; fail closed if any final
ID is unmeasurable. For external models, reject when count exceeds 192 or bytes exceed
512 KiB. Use this same measurement for the `run-request` telemetry.

This single site fixes blockers 9 and 10 together: it sees checkpoint roots plus
suffix, and it is downstream of the empty-history early return.

### `native-exec.ts` — blob size accessor

Add a read-only `cursorBlobByteLength(blobId)` over the existing store
(`:333-340`, `:457-459`), returning stored byte length and never content. Requiring
resolvable sizes is safe because committed checkpoints already fail when a referenced
blob cannot be pinned (`src/adapters/cursor/checkpoint-store.ts:220-228`).

### `cursor-errors.ts` — typed failure (blocker 12)

Add `CursorRootEnvelopeLimitError` following the existing typed-error pattern
(`:36-71`): stable `name`, `code = "cursor_root_envelope_limit"`, `status = 400`, and
readonly `rootCount`, `rootBytes`, `maxRootCount`, `maxRootBytes`. Classify as an
invalid Cursor request. Add `CursorRootMeasurementError` for an unmeasurable final blob rather than logging
an invented number (re-audit blocker 6, which correctly noted the first revision left
it undefined): `code = "cursor_root_measurement_failed"`, `status = 500` because it
is an internal accounting failure rather than an oversized client request, carrying
the unmeasurable blob id and the count measured so far. It maps through the adapter
with the same non-retryable discipline.

`isRetryableCursorError` returns false for both classes before any text heuristic
(`transport-retry.ts:20-39`) — retrying an over-envelope request only reproduces it.
The terminal catch in `src/adapters/cursor.ts:477-488` preserves status 400,
`invalid_request_error`, the code, and `retryable: false` instead of degrading to a
message-inferred 502.

### Telemetry (blocker 13)

The first draft called telemetry defect-free. It is not. For a pure checkpoint,
`rootPromptMessagesState` is undefined and `:990-992` reports `rootBytes: 0` despite
real checkpoint roots. For suffix replay, `:948-953` records `suffixRoots.byteLength`
including a synthetic system root that was then removed. Both are fixed by reporting
the single final measurement above — which matters beyond observability, because the
blocker-9 guard depends on the same number being right.

Also drop the synthetic default-system root from suffix assembly (`:927-953`) so
suffix accounting stops including a root absent from the final envelope.

## Accept criteria

1. **Full replay keeps its initiating turn.** External full replay under cap, one
   initiating user root, uniquely identified trailing results: the final non-system
   sequence is the initiating user followed by every expected `call_id` in order.
   Mutation: classify the call checkpoint-covered, or drop the initiating root — red.
   (b) **Developer-root initiator (re-audit 5).** The same case with a `developer`
   root as initiator. Turn discovery currently scans for `user` only
   (`protobuf-request.ts:346-351`) even though its own comment says user or
   developer, so a user-only test would pass an implementation that still drops a
   developer-initiated turn. Fix the scan and assert the developer root survives.
2. **Checkpoint-covered result-only suffix stays valid.** A pinned checkpoint covers
   the initiating turn and the suffix slices to a tool result: checkpoint roots
   remain, the result is appended, no synthetic system root appears.
   Mutation: apply the full-replay rule to the suffix — rejects or loses the result,
   red. This is the blocker-8 regression guard.
3. **Count guard is cumulative.** 192 checkpoint roots plus a two-root suffix throws
   with `rootCount === 194`. Mutation: guard only `suffixRoots` — no throw, red.
4. **Byte guard is cumulative.** Under 192 roots whose hydrated final bytes exceed
   512 KiB throws, and `rootBytes` equals the independently hydrated sum.
   Mutation: count-only, or suffix-local byte accounting — no throw, red.
5. **The early return cannot bypass enforcement.** 193 system prompts with no
   `rawMessages` throws with `rootCount === 193`. Mutation: guard only the
   external-history branch — serializes fine, red.
6. **Tool-result membership is all-or-fail.** (a) An under-cap block with unique
   `call_id`s keeps every identity and order. (b) 193 active results plus one system
   root throws rather than emitting a shortened envelope.
   Mutation: restore `active.shift()` or any arbitrary deletion — identity or
   rejection assertion red even though the count still fits.
   (c) **Combined byte overflow (re-audit 4).** Several results, each individually
   representable, whose combined block exceeds the budget — the only shape that
   reaches the deletion loop at `protobuf-request.ts:328-330`. Assert every result
   identity survives or the request is rejected; never a silently shortened block.
   Without this case the `active.shift()` mutation is NOT red, because 193 small
   results stay under the byte budget and get caught by the count guard instead —
   the re-audit's correction.
7. **Byte truncation cannot erase a result.** When the system leaves less room than
   the minimum result-plus-marker representation, throw. Mutation: restore the
   current omission path (`:332-340`) — succeeds without the result, red.
8. **The typed failure carries evidence.** Assert class, `name`, `code`,
   `status === 400`, exact measured counts, both limits, and
   `isRetryableCursorError(error) === false`; then the same class through the adapter
   for event status, type, code, retryability.
   Mutation: throw a generic Error, omit measured fields, or match on message regex
   — at least one assertion red. This is what makes blocker 12 non-vacuous.
9. **Telemetry equals the final envelope.** (a) Pure checkpoint with debug enabled:
   `rootBlobs` and `rootBytes` equal the hydrated checkpoint roots, not zero.
   (b) Checkpoint plus suffix: telemetry equals the final sum and excludes the removed
   synthetic system root.
   Mutation: restore `rootPromptMessagesState?.byteLength ?? 0` or
   `suffixRoots.byteLength` — red.
10. **An unmeasurable root is counted, not fatal (corrected during build).** A root
    carried inside a decoded checkpoint need not exist in the local blob store —
    Cursor minted some of them, and a resumed conversation legitimately references
    ids this process never wrote. The count limit still binds such a root; the byte
    total becomes a floor, and `unmeasuredRoots` in the diagnostic says so.
    Mutation `unmeasured-fatal` (throw on an unmeasurable root) — red, 5 fail.
11. Invalid checkpoint bytes still report `continuationMode: "full-replay"` with
    `checkpointInvalidationReason: "decode_failed"`.
12. Valid tool-suspended checkpoint continuation does not regress.

## Corrections made during implementation

Two things in the plan above were wrong and were changed rather than implemented as
written. Both were caught by running mutations, not by reading.

**`CursorRootMeasurementError` was designed and then deleted.** Criterion 10
originally required failing closed on an unmeasurable root. Implementing it broke
three already-passing checkpoint tests, which is the evidence that failing closed
rejects working continuation: checkpoint roots are *expected* to be absent from the
local store. With the fail-closed branch gone the class became unreachable, and an
unreachable error class cannot be tested, so it is not in the shipped diff. The
reasoning is recorded next to `isCursorRootEnvelopeError` so the next reader does not
re-add it.

**The `replayOrigin` parameter was removed as non-load-bearing.** The plan gated
orphan-result recovery on whether the call was a full replay or a checkpoint suffix.
A mutation that forced the suffix branch could not be made red — `activeStart > 0`
already confines the search to the current call's slice, so the flag never decided
anything. Worse, gating on it would have *recreated* the defect for a checkpoint
suffix that does contain its own initiating turn. A parameter that cannot be observed
is not a safeguard.

## Verification

`bun test tests/cursor-blob.test.ts tests/cursor-request-builder.test.ts
tests/cursor-transport-retry.test.ts`: 153 pass, 0 fail. `bun x tsc --noEmit` clean.
CI on the exact PR head is primary; the request path is shared, so the merged tree is
verified before merge. A broader Cursor sweep runs remotely via `ssh lidge` with
`ocx-run`, never as a local full suite.

Five mutations, all red — no claim here rests on a suite that was only ever seen
green:

| mutation | effect | failures |
| --- | --- | --- |
| `no-guard` | disable the external-model envelope check | 4 |
| `count-only` | drop the byte limit, keep the count limit | 1 |
| `bytes-only` | drop the count limit, keep the byte limit | 3 |
| `stale-bytes` | restore `rootPromptMessagesState?.byteLength ?? 0` in telemetry | 1 |
| `unmeasured-fatal` | throw instead of counting an unmeasurable root | 5 |

`stale-bytes` was green on the first attempt: the telemetry fix had no covering test,
and the first test written for it set `checkpointSuffixStart`, which populates the
very state the stale expression read. Only a *pure* checkpoint separates the two
expressions. That is the shape the test now uses.

## Risk

This changes model-visible replay content and therefore estimated input usage.
Retaining the initiating turn leaves less room for large tool output, so UTF-8-safe
truncation gets exercised harder. Rejecting oversized envelopes surfaces requests
that previously went out silently as explicit local 400s — better behavior, but
visible behavior change. Native Composer and Auto paths stay untouched.

Not verified: no live Cursor request was sent. The 192-root and 512-KiB limits are
taken as authoritative from the existing constants rather than re-probed upstream.

## Issue disposition

#1527 stays open. This fixes a request shape that cannot work and removes a plausible
mechanism for the reported collapse; it does not prove the reporter's account
asymmetry is gone. The comment names which of their five residuals this addresses and
repeats the matched direct-versus-proxy probe that would settle the rest.
