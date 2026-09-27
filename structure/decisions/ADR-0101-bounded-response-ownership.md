# ADR-0101 — decision recorded under "Bounded response ingestion and OrcaRouter login"

- Contract owner: [transports/inventory.md](../transports/inventory.md#bounded-response-ingestion-and-orcarouter-login)

## Decision Log

- Purpose and intent: Keep bounded response ingestion's wait bookkeeping independent of
  transport fragmentation and release rejected Devin HTTP bodies before reporting failure.
- Existing implementation and constraints: Both readers consume serially into a geometric
  buffer. Byte ceilings, exact-cap EOF, UTF-8 handling, first-byte versus inactivity deadlines,
  total deadlines, abort reason identity, and best-effort cancellation remain compatibility
  requirements. Devin errors expose status only; response bodies are not diagnostic text.
- Alternatives considered: Race each read against shared abort/deadline promises; create and
  detach a new listener and timer set per chunk; or keep one replaceable current-read slot.
  For rejected HTTP responses, draining or awaiting cancellation would defer error delivery.
- Selected approach: Long-lived callbacks settle only the current-read slot, cleared in a
  per-read finally. A latched interruption covers setup and between-read gaps. Each underlying
  read gets its own fulfillment and rejection handlers. Devin starts body cancellation with
  the original CloudChatError as its reason and observes failures without waiting for it.
- Why this approach: Pending promises cannot detach reactions from completed races. A single
  slot expresses the serial-reader invariant without per-chunk listener churn or restarting
  the total deadline. Nonblocking cancellation preserves the primary error even for a broken
  transport, while avoiding unnecessary body ingestion.
- Benefits, tradeoffs, and impact: Wait bookkeeping is constant-size in chunk count and old
  chunk objects can be collected during an unfinished response. A per-read promise still
  allocates, and the existing payload ceiling is not a process-wide heap bound. Cancellation
  remains an attempt, not a guarantee of transport cleanup. GC regression tests allow a small
  constant number of conservative stack roots and are paired with reaction-attachment checks;
  neither claims a fixed resident-memory footprint across JavaScript engines.
