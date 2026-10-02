import type { TKey } from "../i18n/shared";
import type { ClaudeCodeState } from "./claude-code-types";

export const FIRST_PARTY_PROXY_STATUSES = [
  "none", "live", "stopped", "disabled", "broken", "foreign", "local", "unknown",
] as const satisfies readonly ClaudeCodeState["sharedProxy"][];

export const firstPartyProxyStatusCoverage: Record<ClaudeCodeState["sharedProxy"], true> = {
  none: true,
  live: true,
  stopped: true,
  disabled: true,
  broken: true,
  foreign: true,
  local: true,
  unknown: true,
};

export type FirstPartyNotice =
  | "unknown"
  | "foreign"
  | "local"
  | "residual"
  | "disabled"
  | "routingOff"
  | "stopped"
  | "broken"
  | "notApplied"
  | "shared"
  | null;

/** Only an absent field in an older DTO defaults to none; malformed values warn. */
export function normalizeSharedProxy(value: unknown): ClaudeCodeState["sharedProxy"] {
  if (value === undefined) return "none";
  return FIRST_PARTY_PROXY_STATUSES.find(status => status === value) ?? "unknown";
}

export function selectFirstPartyNotice(
  state: Pick<ClaudeCodeState, "sharedProxy" | "desktopFirstParty" | "cliFirstParty" | "interceptEligible">,
): FirstPartyNotice {
  if (state.sharedProxy === "unknown") return "unknown";
  if (state.sharedProxy === "foreign") return "foreign";
  if (state.sharedProxy === "local") return "local";
  if (!state.desktopFirstParty && !state.cliFirstParty && state.sharedProxy !== "none") return "residual";
  if (state.sharedProxy === "disabled") return "disabled";
  if ((state.sharedProxy === "stopped" || state.sharedProxy === "broken") && !state.interceptEligible) return "routingOff";
  if (state.sharedProxy === "stopped") return "stopped";
  if (state.sharedProxy === "broken") return "broken";
  if (state.sharedProxy === "none" && state.cliFirstParty) return "notApplied";
  if (state.sharedProxy === "live" && state.desktopFirstParty !== state.cliFirstParty) return "shared";
  return null;
}

export function interceptReasonKey(reason: string | null | undefined): TKey {
  switch (reason) {
    case "disabled": return "claude.intercept.reason.disabled";
    case "client_role": return "claude.intercept.reason.client_role";
    case "ephemeral_port": return "claude.intercept.reason.ephemeral_port";
    case "port_in_use": return "claude.intercept.reason.port_in_use";
    case "port_mismatch": return "claude.intercept.reason.port_mismatch";
    case "stopped": return "claude.intercept.reason.stopped";
    default: return "claude.intercept.reason.failed";
  }
}
