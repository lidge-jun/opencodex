/**
 * The single reader of `advisor` config.
 *
 * Nothing else reads the `advisor` key directly: the sidecar planner, the management API and the
 * CLI all resolve through here, so they cannot disagree about defaults or validity. Type-only
 * config import keeps this module free of runtime edges.
 */
import type { OcxConfig } from "../types";
import { ADVISOR_CONTEXT_SHARING_CONSENT_VERSION } from "./disclosure";

export { ADVISOR_CONTEXT_SHARING_CONSENT_VERSION };

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
  /**
   * Current context-sharing consent, or null when absent, stale, or malformed.
   * `enabled` does not imply this. Only the current version allows data transfer.
   */
  contextSharingConsent: typeof ADVISOR_CONTEXT_SHARING_CONSENT_VERSION | null;
  /** Where each resolved value came from, so the GUI/CLI can show real runtime state. */
  sources: {
    enabled: "default" | "configured";
    model: "default" | "configured";
    effort: "default" | "configured";
    policy: "default" | "configured";
    contextSharingConsent: "default" | "configured";
  };
}

export const DEFAULT_ADVISOR_SETTINGS: Readonly<AdvisorSettings> = Object.freeze({
  enabled: false,
  model: "",
  effort: "max",
  policy: "manual",
  timeoutMs: 120_000,
  contextSharingConsent: null,
  sources: Object.freeze({
    enabled: "default",
    model: "default",
    effort: "default",
    policy: "default",
    contextSharingConsent: "default",
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

/** True only for the current context-sharing consent version. Anything else is not a grant. */
export function isCurrentAdvisorContextSharingConsent(
  value: unknown,
): value is typeof ADVISOR_CONTEXT_SHARING_CONSENT_VERSION {
  return value === ADVISOR_CONTEXT_SHARING_CONSENT_VERSION;
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
  // A present but non-current value (stale version, wrong type) resolves as no consent.
  // The stored bytes are left untouched; this reader never writes an upgrade.
  const consentConfigured = Object.prototype.hasOwnProperty.call(raw, "contextSharingConsent");
  const contextSharingConsent = isCurrentAdvisorContextSharingConsent(raw.contextSharingConsent)
    ? raw.contextSharingConsent
    : null;
  return {
    enabled,
    model,
    effort,
    policy,
    timeoutMs,
    contextSharingConsent,
    sources: {
      enabled: typeof raw.enabled === "boolean" ? "configured" : "default",
      model: typeof raw.model === "string" && raw.model.trim() !== "" ? "configured" : "default",
      effort: isValidAdvisorEffort(raw.effort) ? "configured" : "default",
      policy: isValidAdvisorPolicy(raw.policy) ? "configured" : "default",
      contextSharingConsent: consentConfigured ? "configured" : "default",
    },
  };
}

/**
 * Whether a consultation may send task context. Requires the switch, a model, and the
 * current context-sharing consent. `enabled` is not consent. A miss fails closed for the
 * data transfer and leaves the worker request itself running.
 */
export function advisorRunnable(settings: AdvisorSettings): boolean {
  return settings.enabled
    && settings.model.trim() !== ""
    && settings.contextSharingConsent === ADVISOR_CONTEXT_SHARING_CONSENT_VERSION;
}

/**
 * Enabled, with a model, but without current consent. The management surface reports
 * `advisor_context_sharing_consent_required` and the runtime sends no task context.
 */
export function advisorContextSharingBlocked(settings: AdvisorSettings): boolean {
  return settings.enabled
    && settings.model.trim() !== ""
    && settings.contextSharingConsent !== ADVISOR_CONTEXT_SHARING_CONSENT_VERSION;
}
