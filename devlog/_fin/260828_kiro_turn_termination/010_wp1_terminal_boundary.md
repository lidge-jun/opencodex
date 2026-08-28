# wp1 — terminal boundary for a delivered final answer

Consumes: `000_research.md` mechanism 2.

## Problem

`buildKiroPayload` (`src/adapters/kiro.ts`) turns a trailing delivered final
answer into a synthetic user turn carrying `KIRO_ANSWER_DELIVERED_MESSAGE` and
then performs a real upstream inference. Neutral wording is still a prompt, so
the model answers again — the closed task reads as an open goal.

`60537f067` suppresses the completion contract for that shape. Keep that as
defence in depth; it is not the boundary.

## Change (revised after the A-phase audit — audit verdict was FAIL on the
## original placement, see 011_audit_round1.md)

Short-circuit BEFORE the provider fetch, but NOT inside `buildRequest` and NOT
as a bare outputless `done`. Three constraints the audit established, each
verified against current source:

1. **An outputless `done` is retried, not accepted.** `guardEmptyCompletionEventStream`
   treats a `done` with no content event as an empty completion, suppresses the
   terminal, and re-invokes the identical turn; a second empty terminal becomes
   `empty_completion_retry_failed`
   (`src/server/responses/empty-completion-guard.ts:246-270`). So the naive
   terminal turns one loop into either another inference or a stated error.
   The local terminal must therefore bypass the empty-completion guard as well as
   the transport.
2. **`buildRequest` cannot emit events.** The adapter contract returns an
   `AdapterRequest`; events only exist once a `Response` reaches `parseStream`
   (`src/adapters/base.ts`). The server then records and sends the attempt
   unconditionally. Manufacturing a fake `Response` inside `fetchResponse` is
   also wrong: it records a physical send and still meets the guard.
3. **A phantom estimate must not be logged.** Kiro attaches an estimated input
   count during build and the server notes the attempt send before fetching, so
   short-circuiting after a build would log a request that never happened.

Placement: an explicit adapter-owned local-terminal decision consulted in
`handleResponsesInner` AFTER adapter resolution and BEFORE the ordinary
build/send path, short-circuiting to a locally constructed terminal response.
Reuse `hasTrailingDeliveredFinalAnswer` as the predicate; do not introduce a
second notion of "delivered". The hook must not intercept the adapter-owned
bounded retry, which builds with a forced `text_fallback` mode.

Usage accounting for the local terminal: no build-time estimate, `sendCount`
zero, response usage explicitly zero for input/output/total, and no estimated
usage in the request log.

## Out of scope

- Any change to how the completion tool is parsed or consumed.
- Any change to the empty-exec normalisation from `cf1a5720c` / `60537f067`.
- The duplicate-rendering defect, which is wp2.

## Criteria

1. Replaying a delivered final answer issues ZERO upstream requests and yields a
   completed turn with `endTurn: true`.
2. Criterion 1 holds with `emptyCompletionRetry` BOTH enabled and disabled, for
   streaming and non-streaming Responses. This is the criterion the audit added;
   without it the fix passes a test and still loops in the user's config.
3. The short-circuited turn logs `sendCount === 0` and no estimated usage.
4. A genuine later user message after a delivered final answer still performs a
   normal inference (control).
5. An unfinished trailing assistant turn still gets the continuation prompt and
   still performs an inference (control, already covered — must stay green).
6. The adapter-owned bounded `text_fallback` retry is NOT intercepted.
7. `60537f067`'s completion-mode suppression remains asserted.

## Completion language

Closing wp1 fixes the repeated inference ONLY. The user-visible duplicate answer
remains until wp2 lands, and the wp1 report must say so rather than implying the
reported symptom is fully resolved.

## Evidence

`bun test tests/kiro-adapter.test.ts tests/kiro-stream.test.ts tests/server-kiro-completion-e2e.test.ts`
plus new public-server coverage in `tests/server-kiro-completion-e2e.test.ts`,
each new assertion driven red once by reverting the change.
