# Lane C — retry stage table (7) and one event model (14)

Status: OPEN. Branch `codex/260920-lane-c-retry-event-model`, cut from `dev` at
`b9483b3b510f9a8d99d465282517f7bf91678de3`. One branch, ordered commits, one pull request to
`dev`, per [010_phase2.md](010_phase2.md).

## What this lane fixes first

Bundles 7 and 14 want the same substrate, so the branch defines it before touching anything that
consumes it. `src/lib/request-failure-model.ts` is now the single statement of three things:

- **Stage** — how far a failed exchange got, ordered by what the DOWNSTREAM CLIENT observed:
  `pre-header`, `headers-only`, `protocol-prelude`, `semantic-output`, `side-effect`, `terminal`.
  Ordering by client observation rather than by upstream progress is deliberate: the question the
  table answers is whether a resend can duplicate something the caller already saw.
- **Cause** — one closed dictionary, with `rate-limit`, `quota-exhausted`, `policy-refusal` and
  `ciphertext-refusal` as four separate members because their remedies are four different actions.
  `parameter-rejected` is separate from `policy-refusal` for the same reason: the same content
  succeeds once the parameter changes, and `payload-too-large` is separate from `payload-rejected`
  because a smaller rebuild succeeds where no repair helps the other.
- **Resend permission** — derived from three small per-member facts, not written out as a
  stage-by-cause matrix. A 6×14 matrix is a restatement that has to be re-derived by hand whenever
  a member is added, and the cell nobody revisited is how two individually correct branches merge
  into a wrong table. That is the class that blocked 2.60.0.

A stage is how far the observable progression got, not which events happened to arrive. A turn that
settled carrying no output — an empty completion, a 4xx error body — did not reach `terminal`; it
stalled at `protocol-prelude`, because the caller saw no answer. `terminal` means the answer was
delivered, which is why it is both last and refused. Commitment is a named per-stage fact rather
than a rank comparison, so a stage added later cannot default into permission.

`refused-ambiguous` forbids an AUTOMATIC resend. It does not forbid a narrowly scoped, explicitly
opted-in recovery that a maintainer reasoned about and bounded. That distinction is what separates
a sanctioned single-shot rebuild from a retry loop that fires because a counter had room, and it is
why this table can be honest about the recoveries the proxy already performs.

Funding follows the disposition rather than the permission, for the same reason. The opt-in reset
replay, the bounded empty-completion rebuild and the transient 5xx ladder are all refused
automatically and all really send, so all three still name the allowance they draw on. Keying
funding on permission would leave exactly those paths unfunded, which is how a per-layer counter
comes back.

Two classifications were corrected during review after being checked against what the code actually
does rather than against what the recovery kind is called. `transient-5xx` covers a status set that
mixes a 503 the origin declined with a 500 it may already have run, so it classifies as
`upstream-fault` and the table never claims the resend was provably safe. `console-go-upload-retry`
replays a byte-identical body that the gateway accepts seconds later, so nothing about the payload
was wrong and it classifies as `upstream-declined`.

## No second store

The durable shapes stay `PersistedUsageAttempt`, `PersistedRequestSpend` and
`PersistedUsageEntry` in `src/usage/log.ts`, joined by `addFinalRequestLog()`. That join is already
the one place a logical request id, its attempts, their physical `sendCount` and the terminal
outcome meet, so this lane derives from it rather than growing a parallel history. The new module
declares no record type and holds no state; both of its imports are types and are erased at
runtime, so it stays a leaf.

## Restatements removed

Two live instances of the union-defect class, both found while fixing the substrate:

- `AttemptRecoveryKind` was written twice — as a union and as the read-back whitelist
  `normalizedAttempt` filters against. A member added only to the union compiles, is written to
  disk, and is dropped on the next read, so the row loses the field that says why it recovered.
  Both vocabularies are now frozen rosters with the types derived from them.
- `recoveryClass()` in `src/server/request-metrics.ts` ended in `default: return "other"`, so a
  recovery kind added later compiled cleanly and vanished into an unactionable bucket. It is now
  total over the shared cause dictionary; a missing member is a typecheck failure.

## Ownership

This lane owns `sendCount`, the request-wide send budget, and the stage and cause vocabulary.
Lanes D and E consume them and do not redefine them. #4793 and every per-model cache view belong to
lane D; this branch edits neither and derives nothing from them.

## Dispositions

### Carried

| Item | Disposition |
| --- | --- |
| #5245 (cmdy) | **Carried, narrowed.** Only an embedded `invalid_request_error` / `invalid_encrypted_content` is admitted through the gateway wrapper. The original reruns the whole opaque classifier on the embedded payload, which would also admit the code-less unverifiable-ciphertext wording, the #4469 caller mismatch and the two xAI decoder strings — identities accepted on evidence about how one specific upstream words its own rejection, which a gateway in between is not. A gateway envelope is now decided ONLY by its embedded payload: the pre-existing anchored-wording checks run on the whole message, and a gateway quotes the upstream's message inside its own, so a relayed caller mismatch would otherwise have satisfied the #4469 identity and gained a resend the strict check exists to withhold. Attribution is in the branch commit. |
| #4191 | **Addressed in part.** The WebSocket failure classifier now has a tested projection onto the shared stage and cause, so its four outcomes are stated in the same words as every other surface and the shared table independently reaches the transport's own no-replay-after-send verdict. The projection is not yet threaded into the durable record, and the SSE fallback the issue also asks for is a transport change; neither is in this branch. |
| #5180 | **Addressed in part.** `rate-limit` and `quota-exhausted` are separate causes with different resend decisions and different metric label values. The shared cooldown and `Retry-After` handling the issue also asks for are routing behaviour and are not in this branch. |

### Deferred, with reasons

| Item | Disposition |
| --- | --- |
| #4942 (FredAmartey) | **Deferred to a follow-up on this substrate.** The pre-header ambiguous-reset stage and its default refusal are now expressed in the shared table, which is what the PR's `replaySafe`/`replayResets` pair was duplicating. The PR itself is a 28-file transport change touching provider config, key failover and passthrough dispatch, and `dev` has moved under it around `request-execution-budget.ts` and `physical-send.ts`. Landing that reworked and unrun in a branch whose verification is static review would be a worse trade than deferring it. |
| #4989 | **Deferred to the same follow-up.** Its protocol-prelude state gate (`responseCreated && !outputCommitted && !terminal`) is exactly the `protocol-prelude` row of the shared table and is the correct model. It overlaps #4942 in `src/lib/upstream-retry.ts` and `passthrough-dispatch.ts`, and the two must not each buy an independent replacement send for one logical request, so they belong in one reworked change rather than two. |
| #2366 (chilung-cgu) | **Deferred.** Its `StreamTimeline`, `FailureSide` and seven-stage `FailureStage` are good source material and store nothing in parallel, but they are a second stage vocabulary. Reconciling them with the one landed here is a rewrite of the PR, not a carry, and it is better done once the substrate is on `dev`. |
| #3748 (yansigit) | **Deferred as implemented.** It adds an authoritative SQLite failure ledger beside the usage ledger, which is the parallel store this lane exists to avoid. The derived equivalent is to group recorder terminals by a versioned fingerprint of closed cause plus provider and model class. Its API also accepts a free-text `signature`, and regex redaction cannot prove content was removed. |
| #3983 (yansigit) | **Deferred.** Content-free and durable-store-free, but it emits through a second path independent of request recording. The derived form routes the same structural observations through the recorder and formats the debug ring from them. |
| #5063 (Vocllum) | **Deferred.** Sound retention work on the canonical ledger, and orthogonal to the stage and event model. It also changes GUI surface, which this branch cannot evidence. |
| GUI recovery-kind roster | **Deferred, and it is a real defect.** `gui/src/pages/Logs.tsx` declares its own `AttemptRecoveryKind` with nine of the durable thirteen members, so `key-401`, `oauth-account-429`, `opaque-blob-rejection` and `reasoning-effort-downgrade` have no localized label. Fixing it needs new strings across ten locale catalogs and a screenshot of the changed dialog, which a branch that may not build or run the GUI cannot produce. It should be one follow-up that derives the GUI union from the durable roster instead of restating it. |

## Verification

Static source review plus exact-head hosted CI, per the batch execution constraints.

Checked statically on this branch:

- every assertion in the two new test files was re-derived by hand from the declared tables, and
  the only recovery kinds whose Prometheus class changes are `opaque-blob-rejection`
  (`payload` to `ciphertext`) and `console-go-upload-retry` (`payload` to `transient`), both
  corrections rather than side effects;
- every `satisfies Record<Union, ...>` added here is total over its roster, and every value it
  produces is a declared member of the target vocabulary;
- `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json` agree
  key-for-key, and both new test files sit in the domain they are registered to;
- no file this branch touches has a `tests/fixtures/file-size-baseline.json` cap, and the new test
  cases went into a sibling file rather than into `responses-opaque-blob-recovery.test.ts`, which
  sits 148 lines under the new-file threshold;
- `src/server/index.ts` is untouched; it has one line of headroom against its cap.

NOT RUN on this branch, by instruction: `bun run test`, any individual `bun test` file,
`bun run typecheck`, `bun run build:gui`, `bun install`, `bun run structure:check`,
`bun run privacy:scan`, and any live `ocx` execution. None of these may be recorded as passing.
Hosted CI at the exact head is the only execution evidence for this branch.
