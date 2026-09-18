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
  return config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
}

type AdvisoryConfig = Pick<OcxConfig, "multiAgentMode" | "multiAgentSurfaceAdvisoryVersion">;

/**
 * True when this install should be told once that v1 is now the default surface.
 *
 * A v1 install is silent because it has nothing to decide. A fresh install is silent
 * because `getDefaultConfig()` writes the current version alongside the v1 default. What
 * is left is the case this exists for: an install that predates the change and is running
 * base or v2, where a ChatGPT-native parent cannot hand a task to a routed child.
 */
export function multiAgentSurfaceAdvisoryRequired(config: AdvisoryConfig): boolean {
  if (resolveMultiAgentMode(config) === "v1") return false;
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
