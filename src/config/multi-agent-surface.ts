import type { MultiAgentMode } from "../codex/catalog/parsing";
import type { OcxConfig } from "../types";

/**
 * Bump to raise the sub-agent surface advisory again for installs that already answered
 * the previous one. A version rather than a boolean, so that the day the upstream
 * encrypted-task limitation is fixed, the notice saying so reaches the same operators
 * without a second config key.
 */
export const MULTI_AGENT_SURFACE_ADVISORY_VERSION = 1;

/** The published explanation both advisory surfaces link to. */
export const SUBAGENT_SURFACE_GUIDE_URL = "https://opencodex.me/guides/subagent-v1-default/";

/**
 * The surface an operator effectively runs. An absent key still means base: the key is
 * deleted when base is selected, so its absence cannot be read as "never configured".
 * What changed in this release is the written default, not this resolution.
 */
export function resolveMultiAgentMode(config: Pick<OcxConfig, "multiAgentMode">): MultiAgentMode {
  return config.multiAgentMode === "v1" || config.multiAgentMode === "v2" || config.multiAgentMode === "v2-plaintext"
    ? config.multiAgentMode
    : "default";
}

/**
 * Whether v2 collaboration messages are compiled to plaintext on the canonical
 * ChatGPT forward route. Two independent opt-ins activate it: the standalone
 * experimental `plaintextV2AgentMessages` flag, and mode `"v2-plaintext"`, which is
 * itself the operator's explicit consent. Mode transitions never rewrite the flag,
 * and the flag alone never changes the resolved mode.
 */
export function isPlaintextV2AgentMessagesEnabled(
  config: Pick<OcxConfig, "multiAgentMode" | "plaintextV2AgentMessages">,
): boolean {
  return config.plaintextV2AgentMessages === true || resolveMultiAgentMode(config) === "v2-plaintext";
}

type AdvisoryConfig = Pick<OcxConfig, "multiAgentMode" | "multiAgentSurfaceAdvisoryVersion">;

/**
 * True when this install should be told once that v1 is now the default surface.
 *
 * A v1 install is silent because it has nothing to decide. A fresh install is silent
 * because `getDefaultConfig()` writes the current version alongside the v1 default.
 *
 * A "v2-plaintext" install is silent too: the mode explicitly opts into a different
 * native-to-routed delivery mechanism, and entering it required the
 * dedicated plaintext acknowledgement, so re-raising the generic "v1 recommended" notice
 * would repeat a decision the operator just made. The stored advisory version is left
 * alone, so leaving the mode for base or v2 still raises an unanswered advisory.
 *
 * What is left is the case this exists for: an install that predates the change and is
 * running base or v2, where a ChatGPT-native parent cannot hand a task to a routed child.
 */
export function multiAgentSurfaceAdvisoryRequired(config: AdvisoryConfig): boolean {
  const mode = resolveMultiAgentMode(config);
  if (mode === "v1" || mode === "v2-plaintext") return false;
  return (config.multiAgentSurfaceAdvisoryVersion ?? 0) < MULTI_AGENT_SURFACE_ADVISORY_VERSION;
}

export type MultiAgentSurfaceAdvisory = {
  /** Whether the dashboard should raise the notice. */
  required: boolean;
  /** The surface stored today. */
  mode: MultiAgentMode;
  /** What the notice recommends. */
  recommended: "v1";
  /** The advisory revision a client acknowledges. */
  version: number;
  /** Where the notice sends a reader for the explanation. */
  docsUrl: string;
};

/** Response-only projection; none of this is a writable config field. */
export function multiAgentSurfaceAdvisory(config: AdvisoryConfig): MultiAgentSurfaceAdvisory {
  return {
    required: multiAgentSurfaceAdvisoryRequired(config),
    mode: resolveMultiAgentMode(config),
    recommended: "v1",
    version: MULTI_AGENT_SURFACE_ADVISORY_VERSION,
    docsUrl: SUBAGENT_SURFACE_GUIDE_URL,
  };
}
