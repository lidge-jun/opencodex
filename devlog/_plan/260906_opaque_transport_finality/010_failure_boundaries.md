# Preserve preflight read failures and inspection finality

## Current ownership

Core selects native encrypted-output candidates and awaits combo-stream-preflight
before exposing headers. The preflight owns a bounded retained prefix and one
reader; replayBufferedResponse already emits that prefix and forwards later read
errors. Client relays own synthetic failed tails. consumeForInspection owns the
independent tee terminal callback used by native account health. The shared SSE
inspector reports real terminals and exposes parsed payload callbacks.

## Planned change

- src/server/responses/combo-stream-preflight.ts: native-only replayReadErrors
  option, default false. Catch only reader.read rejection; opted-in callers get
  an accepted reconstructed stream retaining the bounded prefix and the errored
  reader. Never cancel that errored reader: its original rejection must survive
  the replay into relay/inspection. Default combo callers preserve their prior throw behavior. Do not retry
  or classify a read reset as a decrypt rejection, swallow it, or grow buffers.
- src/server/responses/core.ts: enable that option only on the native opaque
  preflight. After its await, caller abort takes the existing cancellation cleanup
  path before any replay/rebuild. Other read failures reach the normal mid-stream
  relay and inspection path, not a connect-phase error classifier.
- src/server/relay.ts: reuse a bounded/redacted bare-error message helper at the
  client boundary and within consumeForInspection's parsed-payload callback.
  Keep that evidence local to this reader rather than borrowing stale log state.
  At clean EOF without a real terminal, a witnessed bare error reports failed
  using the shared terminal HTTP mapper; an error-free EOF remains incomplete.
  Preserve the caller's parsed-payload callback. Real terminals and cancellation
  retain precedence; no extra terminal callback or healthy-account reset.

## Rejected alternatives and scope

A blanket core catch mapped as a connect error can misclassify an already-started
response's account outcome. Globally replaying all preflight errors changes combo
behavior. Reporting failure at the first bare error would override a later real
terminal. Borrowing the client relay's mutable state revives tee scheduling races.
Use the existing preflight/relay ownership and callback seams instead; no new
public inspector method, provider policy or retry budget.

## Verification

Existing native request fixtures add created-then-reset and created-then-caller-
abort cases: no uncaught handleResponses rejection, no sanitize resend, normal
failed stream or 499 cancellation and appropriate attempt/terminal metadata.
Run tee/eager variants where selected by the existing harness. Preflight tests
prove default read-error behavior is unchanged and native opt-in preserves prefix
and exact failure. Inspection/account-health fixtures cover flat/nested bare
errors at EOF, prior failure/avoidance not cleared, real-terminal precedence,
error-free EOF compatibility and cancellation neutrality. Existing redaction,
byte bounds, no-persistence and one-shot recovery tests remain.

Independent plan/source/final review; exact parent and cascaded child hosted
Linux/macOS/gates CI. Final Windows six-shard and release gates remain mandatory.

## Usage-marker parity amendment

Source review confirms the account-health blocker is closed by failed EOF. The
existing eager callback still labels every synthetic failure as streamAborted,
though a clean EOF after an explicit upstream error is a semantic failure, not a
body-read reset (PersistedUsageAttempt documents that distinction). Criterion c-2
also requires usage outcome parity, so include this small related correction:
relay-eager passes optional upstream_error provenance only for that clean-EOF tail;
core records its semantic failed status without streamAborted. Ordinary reset
callbacks retain their one-argument shape, 502 and streamAborted. Add request-level
tee/eager assertions for repeated bare errors versus actual reset; do not infer
this marker from a stale log message or change real-terminal precedence.
