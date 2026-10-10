# Shutdown fallback fixture clock

CI34021352755 on the documentation-only combo closeout failed one macOS test:
shutdown drain cap expiry enters the synchronous spill fallback. The run had
10,050 passes and one failure. This file and production state.ts were unchanged
from the previously green e1f5a5b8d runtime.

The fixture freezes ACL and spill clocks but the shutdown reserve uses Date.now.
An 80 ms reserve therefore still races host disk/scheduling latency (the failure
was ETIMEDOUT inside fallbackPendingResponseSpills). Freeze that third clock only
around flush, using the existing spy pattern from the neighboring ordering test.
The real 40 ms drain timer still expires while the async publication gate stays
held; positive synchronous-call, empty-pending and installed-stub assertions remain.
Release the gate, await the publication tail and restore the clock in finally.

This C1 verifier repair changes one fixture, no production timeout, skip or retry
policy. Budget-exhaustion/watchdog cases remain untouched. Land as a separate
prerequisite PR and cascade the combo branch. Independent fixture review and new
exact parent/child hosted CI are required; no local suite/typecheck/build runs.
