/** Proxy-owned refusal text for an exhausted late-attribution budget. A compaction on the same
 *  Ollama route resends the same history, so the only reliable recovery is a new thread.
 *
 *  Kept in its own module so combo failover can recognize this proxy-owned 413 without pulling
 *  the Ollama adapter into its import graph. */
export const OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE =
  "Late tool-output attribution for this conversation exceeded the 256 KiB per-request limit. Start a new thread to continue.";
