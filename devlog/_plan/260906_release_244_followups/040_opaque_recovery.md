# Opaque output rejection and terminal error recovery

Depends on parsed-input/Kiro integration; C4. Carry #3535 2396829bded6d2aaf319e67dddb5918d83d1d3a0 (base 7e7ab281cca35600b41f1f80222f3462a87dd4e1), Co-authored-by: yxr1995-maker <257504378+yxr1995-maker@users.noreply.github.com>.

## Exact diff map
- MODIFY src/lib/errors.ts: one ENCRYPTED_FUNCTION_OUTPUT_REJECTION constant, flat error message extraction alongside existing nested form.
- MODIFY src/server/responses/combo-stream-preflight.ts: optional narrow retryableTerminal predicate; existing two-argument callers retain default behavior. Bare error events count as uncommitted only where correctly retryable, not blanket authorization to replay effects.
- MODIFY src/server/relay.ts createSseTerminalOutputBoundary/upstreamErrorTailFrame and src/server/relay-eager.ts: observe upstream error on their own bounded client frame reader; at repeated bare-error EOF emit response.failed carrying real error instead of adapter_eof. Avoid async inspection branch race.
- MODIFY src/server/responses/core.ts encrypted function/custom outputs and agent_message detection, prepareOpaqueBlobRecovery, preflight: one sanitized rebuild before client output commitment; exact decrypt rejection predicate, not all HTTP 502. Mutate existing raw-body identity to preserve nonpersistable WeakSet marker. Preserve current rewrite ordering, cancellation and missing-call-id rejection.
- MODIFY tests/responses/responses-opaque-blob-recovery.test.ts, sse-failed-tail.test.ts, passthrough-abort.test.ts, tests/routing/combo-stream-preflight.test.ts as needed.
- MODIFY docs-site/src/content/docs/guides/sub-agent-surface.md and structure/04_transports-and-sidecars.md with bounded recovery/terminal behavior.

Before: encrypted function output rejection can terminate without Responses terminal and surface adapter_eof; recovery handles fewer opaque shapes. After: one narrow sanitize/rebuild attempt; a repeated error is surfaced as failed with the actual message from the reader that delivers output.

## Activation / review
Remote tests: encrypted function-output or agent_message + exact decrypt failure permits one recovery; nondecrypt 502 stays unchanged; repeated flat/nested bare errors in tee and eager produce response.failed once; valid existing terminal wins; after client output commit no retry; raw-body identity/no-persist preserved; default combo caller compatibility maintained; caller cancellation remains cancellation.
Existing maintainer CHANGES_REQUESTED targeted older 2d90f9684 reader race; independent review of port must confirm remedy rather than asserting GitHub approval was granted. Remaining review threads checked for substance against final head. No preemptive stripping of all previous_response_id history, no broader retry policy.

## Stack and proof
Owner explicitly requests stacked PR workflow; use this relay foundation before combo-recovery and Grok terminal integration as an integration-validation stack, even though fixes are independently useful. Each layer remains independently tested via exact-head ci.yml runtime/gates. Security analysis stays scratch until public diff; no live Kiro.

