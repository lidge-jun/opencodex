# 050 — Phase 5: Backpressure + abort race (classes 9, 12)

One PABCD cycle. Final hardening: bound the bridge's consumption when the
downstream client is slow, and close the headers-to-reader abort window.
Lands LAST: phases 1-3 pinned the terminal behavior this restructure must
preserve.

> SPLIT (A-gate round WP5): this phase was too large for one B. It is now an
> overview; the two dependency-ordered sub-phases live in
> 051_phase5a_abort_guard_queue_cap.md (low-risk, first) and
> 052_phase5b_pull_driven_backpressure.md (restructure, second). Each runs
> as its own PABCD cycle. The sequencing gate (#363/#352) is CLEARED.
>
> DECIDED semantics (A-gate folds, binding on both sub-phases):
> 1. False-stall: the stall clock measures UPSTREAM SILENCE ONLY. While the
>    consumption loop is pull-gated (client behind), stall time does not
>    advance — a healthy upstream is never killed for a slow client. The
>    resource bound for slow clients is the queue cap, not the stall timer.
> 2. No "stream cancel" primitive exists producer-side: synthesized
>    terminal frames (stall incomplete / failure) BYPASS the pull gate with
>    a small bounded allowance (a few frames), then controller.close();
>    the upstream is cut via onCancel. Downstream heartbeat frames also
>    bypass the gate but are skipped while gated (client is behind anyway;
>    bounded by the stall window).
> 3. No internal FIFO: events are processed atomically per pull (one
>    adapter event -> its frames enqueued within that pull), so lifecycle
>    pairs can never split across pulls. The macrotask-yield logic is
>    REMOVED in 052: pull cadence gives natural per-event delivery, and
>    bridge-live-delivery is the latency proof. WP2's terminal ordering
>    (abort -> break -> fire-and-forget return.catch) is preserved inside
>    the pull that handles the terminal event.
