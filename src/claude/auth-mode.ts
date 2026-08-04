/**
 * Claude auth-mode resolution.
 *
 * The resolver answers exactly ONE question: does the opencodex-owned dummy token
 * (`ANTHROPIC_AUTH_TOKEN=opencodex-proxy`) get injected? That is narrower than "how
 * will Claude authenticate" — native passthrough additionally needs an `sk-ant-`
 * credential on the incoming request — so the field is `markerMode`, not
 * `effectiveAuthMode` (devlog/_plan/260726_claude_auth_auto/002 R2-1).
 *
 * The admission-key axis is separate and untouched: when the proxy requires an
 * admission key, `buildClaudeEnv` injects it regardless of mode.
 */
import type { OcxConfig } from "../types";
import type { AuthDetectResult, AuthSourceId } from "./auth-detect";

export type MarkerMode = "proxy" | "subscription";

export type AuthModeOrigin = "manual" | "auto-present" | "auto-absent" | "auto-unknown";

export interface ResolvedAuthMode {
  /** Does the owned dummy marker get injected. NOT a claim about native auth. */
  markerMode: MarkerMode;
  origin: AuthModeOrigin;
  /** The detector source that proved presence (origin auto-present only). */
  foundBy?: AuthSourceId;
  detection: AuthDetectResult;
}

/**
 * Reads `authMode`; never writes it. An explicit "proxy"/"subscription" bypasses the
 * detector forever, which is what makes a manual choice stick across auth changes.
 *
 * `unknown` resolves to subscription — the historical default — because flipping a
 * subscriber into proxy mode on a failed read (denied keychain, unreadable file) is
 * the worst outcome this feature can produce.
 */
export function resolveClaudeAuthMode(config: OcxConfig, detection: AuthDetectResult): ResolvedAuthMode {
  const authMode = config.claudeCode?.authMode;
  if (authMode === "proxy") return { markerMode: "proxy", origin: "manual", detection };
  if (authMode === "subscription") return { markerMode: "subscription", origin: "manual", detection };

  switch (detection.presence) {
    case "present":
      return {
        markerMode: "subscription",
        origin: "auto-present",
        ...(detection.foundBy ? { foundBy: detection.foundBy } : {}),
        detection,
      };
    case "absent":
      return { markerMode: "proxy", origin: "auto-absent", detection };
    default:
      return { markerMode: "subscription", origin: "auto-unknown", detection };
  }
}

/** The three-state intent as the API and GUI express it. */
export type AuthModeIntent = "auto" | "proxy" | "subscription";

export function authModeIntent(config: OcxConfig): AuthModeIntent {
  return config.claudeCode?.authMode ?? "auto";
}
