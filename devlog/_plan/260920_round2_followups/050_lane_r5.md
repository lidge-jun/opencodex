# Lane R5 — the four telemetry pull requests as derived consumers of the recorder

Status: OPEN. Branch `codex/260920-r5-telemetry-derived`, rebased onto `dev` after `origin/dev`
advanced mid-lane. One branch, ordered commits, one pull request to `dev`.

Lane C deferred #2366, #3748, #3983 and #5063 "as implemented", because each adds a parallel store
or a second emission path. [030_lane_c2.md](../260920_meaning_preservation_batch/030_lane_c2.md)
then specified the derived form for each. This lane builds those four forms. It adds no store: the
durable shapes stay `PersistedUsageAttempt` and `PersistedUsageEntry`, and every projection reads
them.

## What landed, per pull request

### #2366 (chilung-cgu) — durable failure attribution, in the landed vocabulary

`failureStage` and `failureCause` now ride the attempt that ended a request and the logical row,
both closed roster members. `FailureSide` and the seven-member `FailureStage` are not here: two
attribution vocabularies for one question is the class that blocked 2.60.0. The PR's widening of
`transportPhase` and `terminalSource` to arbitrary strings is not here either; those validators
stay closed, and `terminalStatus` — which was a plain `string` — joined them, because it is now a
grouping-key slot and it is assembled from an upstream frame.

The derivation reads only closed values. `errorCode` and `upstreamError` are excluded on purpose:
both carry upstream text, so a classification keyed on them is a different answer per provider and
per locale, and a key built from them cannot promise it carries no content. That exclusion is what
lets the pair be a Prometheus label and a fingerprint component with no masking pass.

It runs at `addFinalRequestLog`, the one seam every request passes exactly once, and before the
attempt snapshot so the disk row and the live attempt carry the same pair. `addRequestLog` rebuilds
the persisted row field by field, so the pair is written there explicitly — a field omitted at that
line reaches `/api/logs` and never reaches `usage.jsonl`.

**The resend verdict is not stored.** `/api/logs` computes `resendPermission` at read time for the
row and each attempt. The tables that decide it live in this build; a row written months ago must
not assert a permission the current tables refuse.

**Known limit, recorded rather than hidden.** Only the attempt that ends a request, plus the one
sealed by a key-account rotation, carry attribution. The other intermediate finalizers —
`policy-fallback.ts` and five sites in `core-combo.ts` — still reach the ledger unattributed. Each
has different evidence in scope and a branch verified by static review alone should not add six new
classification call sites at once. The logical row is attributed in every case, which is what the
projection and the exporter read.

**Second known limit.** A ciphertext or reasoning-parameter recovery that SUCCEEDED, followed by an
unrelated 400 on the same attempt, still reads as that recovery's cause. The rule is narrowed to
the last recorded kind on the matching status, and the proper fix — clearing recovery evidence on
success in `core-opaque-recovery.ts` — belongs in the recovery path, not the derivation.

### #3748 (yansigit) — a failure grouping, not a second ledger

`src/telemetry/` and its SQLite store are not built. Failed rows are grouped by a versioned
fingerprint over a fixed-arity tuple of closed roster members, folded during a scan of
`usage.jsonl` through the existing `scanUsageLedgerCooperatively`. The projection holds a count and
two timestamps per group; delete a ledger row and it leaves the grouping on the next rebuild.

The free-text `signature` and its regex masking are replaced by construction rather than by a
better regex: an expression can only assert it removed what it matched, while a tuple whose every
slot comes from a frozen list has nothing to remove. Absent facts are explicit nulls in fixed
positions, because omitting them would let `[a, null, b]` and `[a, b]` collide.

**A deliberate divergence from 030_lane_c2.md, flagged for the coordinator.** That document says
"No provider". The lane brief for R5 says the fingerprint is over "closed cause + provider + model
class". The brief is the later and more direct instruction, so `providerClass` is in the tuple —
resolved against the provider registry so it is a registry id or `null`, never the alias a user
typed. Model class is NOT in the tuple: no closed model-class vocabulary exists in this repository
and inventing one is the union-exhaustive hazard this batch exists to avoid. Removing
`providerClass` is one slot and a version bump if the coordinator prefers the C2 shape.

The mutable `monitoring/dispatched/fixed/ignored` status and its notes are absent. They are
operator state; they cannot be reconstructed from immutable request rows, so presenting them as a
derived ledger would be a claim this projection cannot make.

The reader is `GET /api/usage?failures=1` rather than a new route: it answers a different question
from the usage summary and costs a scan, so it is opt-in and no new CLI-parity surface appears.

### #3983 (yansigit) — five counts on the attempt, no second emission path

`emitDebugLine` writes the in-process ring AND stderr, and stderr is redirected to the service log
under launchd and systemd, so the PR's per-event lines would give an installed service a durable
per-event history beside the ledger. Its per-payload HMAC used a process-global random key, making
every repeated prompt fragment, tool name and error message correlatable for the process lifetime.

Instead the attempt carries adapter events, relayed frames, semantic bytes, side effects and
terminal frames. Adapter events are counted at the existing adapter-parse seam; relayed frames
after a SUCCESSFUL `controller.enqueue`. Counting both at the reader would make them equal by
construction and erase the loss signal. The recorder is bound to the request's translator budget
and reaches the current attempt through a callback, so a mid-request attempt rotation credits the
live attempt rather than one already finalized. The debug ring now FORMATS one line per finalized
attempt from those counts, through `appendDebugLogLine` and never `emitDebugLine`.

Adversarial review caught the case this design gets wrong on its own: a non-streaming turn delivers
one body and calls no per-frame recorder, so every buffered response would have persisted adapter
events with zero relayed ones — the loss signal, raised on every buffered request. The buffered
seam now records its delivery from the body it built.

`run-turn-execution.ts` is untouched. Its accounting distinguishes adapters that report their own
physical sends, and the PR's unconditional pre-count would double-charge them.

### #5063 (Vocllum) — retention with a revision contract

`usageLedgerMaxBytes` is unset by default and unset means unlimited. When set, an append that
crosses it publishes the newest whole rows byte for byte through the shared atomic writer.

The defect this closes: #5063 captured a size, copied a suffix and renamed over whatever was there,
so a row appended in between was silently dropped; its own concurrency test performed two
sequential calls and said it could not test concurrency. Two things close it. The append is
synchronous and the compaction runs inside the same call stack, so no in-process append can
interleave, and a second server on the same home cannot append at all — it is refused by the
existing ledger-owner lease, which is why the hook is installed after ownership. And
`validateBeforeRename` re-opens the target immediately before the rename and refuses unless
identity, size and revision metadata are byte-for-byte what was copied. A focused test drives that
exact window through an injected hook.

Rows are copied and never parsed, which is what keeps a field a newer build wrote intact through a
compaction. The writer gained a streaming form so the retained span is not held in memory, and that
form fsyncs the temp before the rename and the parent directory after it.

The invalidation half was missing from the original entirely. A compaction now discards the
2,000-entry Logs ring, the retained usage aggregate and failure projection, and the request-history
index — otherwise `/api/logs` keeps serving rows the ledger no longer has.

**This does not close #5063.** The Usage-page control it also asks for is not here: this lane may
not build or run the GUI, so it cannot produce the screenshot the gate requires, and shipping an
unverifiable control is worse than shipping the policy it would set. The limit is settable in
`config.json` today and the configuration reference says so. Remaining scope: the dashboard
control, its management route, and the ten catalog strings.

## The GUI screenshot gate

This branch changes `gui/src/pages/Logs.tsx` and the ten locale catalogs, so `missing_ui_screenshot`
fires. It fires on changed paths under `gui/`, not on words in a description, and this lane may not
run `bun run build:gui`. A maintainer comment or the `gui-screenshot-waived` label is the documented
resolution.

The evidence to judge it without the screenshot: the catalog edits are purely additive (+29 lines,
0 removed, in each of ten files, all exempt from the file-size ratchet), every new key exists in all
ten catalogs, and three `satisfies` clauses make a missing label a typecheck failure rather than a
silent fallback. The visible change is three rows added to the Logs detail dialog for a failed
request — the cause, the stage it reached and the resend verdict — and a named cause where the
attempt table previously led with a bare wire code.

## Pre-existing defect found and deliberately not fixed here

`src/config/atomic-write.ts` scrubs a failed temp through `effective.write(tmp, "")`, but the default
writer opens with `"wx"`, so that fallback always fails with `EEXIST` on an existing temp. It only
matters when `truncate` has also failed, and the temp is owner-only. It predates this branch and
affects every atomic config write, including secret-bearing ones, so fixing it is a change to a
security-adjacent path that belongs in its own lane rather than inside a telemetry branch.

## The file-size ratchet caught this branch once

`src/server/request-log.ts` carries the whole request-logging surface and was 1,962 lines against
the repository's 2,000-line seed threshold. The attribution wiring pushed it to 2,015, and
`file-size ratchet: repository` reported `NEW_OVERSIZED` on the first exact-head run. The remedy is
the one AGENTS.md gives — a move, never a number — so the two places a stage and cause are decided
and written moved to `src/server/request-log-failure-attribution.ts`, leaving the file at 1,979.

Worth recording for the next lane that touches this file: 21 lines of headroom is not much, and
the cap only ever moves down.

## Verification

Static source review plus exact-head hosted CI, and three adversarial reviews at high effort
covering typecheck hazards, repository gates, and runtime correctness and privacy. Their findings
are in the branch: the transport-evidence precedence, the 402 mapping, `transport-unsent` no longer
being the fall-through, the parent-directory fsync, the buffered delivery accounting, the rosters
read instead of restated in two tests, and the invariant split into INV-RESEND-01 and
INV-ATTRIBUTION-01 so each binds exactly one test.

NOT RUN on this branch, by instruction: `bun run test`, any individual `bun test` file,
`bun run typecheck`, `bun run build:gui`, `bun run lint:gui`, `bun install`,
`bun run structure:check`, `bun run privacy:scan`, and any live `ocx` execution. None of these may
be recorded as passing.

Checked statically:

- no file this branch touches is at or over its file-size ratchet cap; `src/server/index.ts` sits at
  884 against 893, and the ten catalogs are exempt;
- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json` agree key for key,
  and each new test's regex seed resolves to the domain it is registered to — `failure-attribution`
  is named to avoid the `request-` seed that would have placed it in `usage`;
- `src/usage/telemetry-contract.ts` still has no imports, `src/usage/request-outcome.ts` still reaches
  nothing but it, and `gui/src/pages/Logs.tsx` still never names `src/usage/log`;
- no test or document restates a source constant: the rosters, the fingerprint version and the label
  keys are read from the modules that declare them.

## Issues

#2366, #3748 and #3983 are addressed by these derived forms; the coordinator decides closure. #5063
is partially addressed and must not be closed — its dashboard control is named above as remaining
scope.
