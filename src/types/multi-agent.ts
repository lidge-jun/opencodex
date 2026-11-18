/**
 * Multi-agent surface override:
 * - "v1": force ALL models to v1 surface (override upstream pins)
 * - "default" | undefined: respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag)
 * - "v2": force ALL models to v2 surface (override upstream pins)
 * - "v2-plaintext": force ALL models to v2 surface via catalog pins while the global
 *   `multi_agent_v2` feature stays disabled. Selecting the mode is itself the explicit
 *   opt-in to plaintext delivery of native v2 collaboration messages; the separate
 *   `plaintextV2AgentMessages` flag is not required and is never rewritten by a mode change.
 * The "v2-plaintext" literal must never be written into `multi_agent_version`,
 * whose values Codex validates.
 */
export type MultiAgentMode = "v1" | "default" | "v2" | "v2-plaintext";
