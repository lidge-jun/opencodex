import { LEGAL_STATUS_TRANSITIONS, ROUTING_ELIGIBLE_STATUSES } from "./constants";
import type { CredentialStatus, HealthStatus } from "./types";

export function canTransitionStatus(from: CredentialStatus, to: CredentialStatus): boolean {
  if (from === to) return true;
  return (LEGAL_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: CredentialStatus, to: CredentialStatus): void {
  if (!canTransitionStatus(from, to)) {
    throw new Error(`Illegal credential status transition: ${from} -> ${to}`);
  }
}

export function routingEligibleFor(status: CredentialStatus, health: HealthStatus, circuitOpen: boolean): boolean {
  if (circuitOpen) return false;
  if (!ROUTING_ELIGIBLE_STATUSES.includes(status)) return false;
  if (health === "auth_failed" || health === "quota_exhausted" || health === "provider_down" || health === "unhealthy") {
    return false;
  }
  return true;
}

export function statusAfterHealth(current: CredentialStatus, health: HealthStatus): CredentialStatus {
  if (current === "revoked" || current === "disabled" || current === "expired") return current;
  if (health === "auth_failed") return "quarantined";
  if (health === "quota_exhausted" || health === "rate_limited" || health === "degraded" || health === "warning" || health === "provider_down") {
    return current === "active" || current === "valid" ? "degraded" : current;
  }
  if (health === "healthy" && (current === "valid" || current === "degraded" || current === "validating" || current === "new")) {
    return "active";
  }
  return current;
}

