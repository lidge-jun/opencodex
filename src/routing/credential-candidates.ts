/**
 * Additive 9Router hook for the Provider Access Control Plane.
 *
 * Existing routing remains authoritative when no managed credential is
 * eligible. This module never replaces provider.apiKey / keychain resolution.
 */
import { getCredentialRuntimeService } from "../credentials/service";
import type { CredentialCandidate, LeaseGrant, LeaseRequest } from "../credentials/types";

export function listCredentialCandidates(providerSlug?: string): CredentialCandidate[] {
  try {
    return getCredentialRuntimeService().listCandidates(providerSlug);
  } catch {
    return [];
  }
}

export function acquireCredentialLease(request: LeaseRequest): LeaseGrant | null {
  try {
    return getCredentialRuntimeService().acquireLease(request);
  } catch {
    return null;
  }
}

export function releaseCredentialLease(leaseId: string): void {
  try {
    getCredentialRuntimeService().releaseLease(leaseId);
  } catch {
    /* leases are best-effort for the existing evaluator */
  }
}

