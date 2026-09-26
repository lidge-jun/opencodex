/**
 * The single reader of `advisor` config.
 *
 * Nothing else reads the `advisor` key directly: the sidecar planner, the management API and the
 * CLI all resolve through here, so they cannot disagree about defaults or validity. Type-only
 * config import keeps this module free of runtime edges.
 */
import type { OcxConfig } from "../types";

export type AdvisorPolicy = "manual" | "preflight";

export const ADVISOR_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type AdvisorEffort = (typeof ADVISOR_EFFORTS)[number];

export const ADVISOR_POLICIES = ["manual", "preflight"] as const;

export interface AdvisorSettings {
  enabled: boolean;
  model: string;
  effort: AdvisorEffort;
  policy: AdvisorPolicy;
  timeoutMs: number;
  /** Where each resolved value came from, so the GUI/CLI can show real runtime state. */
  sources: {
    enabled: "default" | "configured";
    model: "default" | "configured";
    effort: "default" | "configured";
    policy: "default" | "configured";
  };
}

export const DEFAULT_ADVISOR_SETTINGS: Readonly<AdvisorSettings> = Object.freeze({
  enabled: false,
  model: "",
  effort: "max",
  policy: "manual",
  timeoutMs: 120_000,
  sources: Object.freeze({
    enabled: "default",
    model: "default",
    effort: "default",
    policy: "default",
  }),
});

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isValidAdvisorEffort(value: unknown): value is AdvisorEffort {
  return typeof value === "string" && (ADVISOR_EFFORTS as readonly string[]).includes(value);
}

export function isValidAdvisorPolicy(value: unknown): value is AdvisorPolicy {
  return typeof value === "string" && (ADVISOR_POLICIES as readonly string[]).includes(value);
}

/**
 * Resolve advisor settings with conservative defaults for every absent or malformed field.
 * A malformed block resolves to fully disabled defaults rather than throwing: the advisor is
 * optional and must never take the request path down with it.
 */
export function resolveAdvisorSettings(config: Pick<OcxConfig, "advisor">): AdvisorSettings {
  const raw: unknown = config.advisor;
  if (!isRec(raw)) return { ...DEFAULT_ADVISOR_SETTINGS, sources: { ...DEFAULT_ADVISOR_SETTINGS.sources } };
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_ADVISOR_SETTINGS.enabled;
  const model = typeof raw.model === "string" ? raw.model.trim() : DEFAULT_ADVISOR_SETTINGS.model;
  const effort = isValidAdvisorEffort(raw.effort) ? raw.effort : DEFAULT_ADVISOR_SETTINGS.effort;
  const policy = isValidAdvisorPolicy(raw.policy) ? raw.policy : DEFAULT_ADVISOR_SETTINGS.policy;
  const timeoutRaw = raw.timeoutMs;
  const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000
    ? Math.min(Math.floor(timeoutRaw), 600_000)
    : DEFAULT_ADVISOR_SETTINGS.timeoutMs;
  return {
    enabled,
    model,
    effort,
    policy,
    timeoutMs,
    sources: {
      enabled: typeof raw.enabled === "boolean" ? "configured" : "default",
      model: typeof raw.model === "string" && raw.model.trim() !== "" ? "configured" : "default",
      effort: isValidAdvisorEffort(raw.effort) ? "configured" : "default",
      policy: isValidAdvisorPolicy(raw.policy) ? "configured" : "default",
    },
  };
}

/**
 * Whether the advisor can actually run with the current settings. `enabled` alone is not
 * enough: without a resolvable model string every consultation would fail, so the planner
 * treats this as disabled (fail-open for the worker, logged once per request that checks).
 */
export function advisorRunnable(settings: AdvisorSettings): boolean {
  return settings.enabled && settings.model.trim() !== "";
}
