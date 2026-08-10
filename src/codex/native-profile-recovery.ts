/**
 * Pure recovery decision model for the native-main profile design spike.
 *
 * This module deliberately performs no credential, vault, or filesystem I/O.
 * The eventual transaction runner must make its observations first, then apply
 * exactly one decision returned here while holding the home-scoped lock.
 */

import type { NativeProfileJournalPhase } from "./native-profile-types";

export type { NativeProfileJournalPhase } from "./native-profile-types";

export type NativeProfileAuthObservation =
  | {
      identity: "source";
      digest: "exact" | "changed";
    }
  | {
      identity: "target";
      digest: "exact" | "changed";
    }
  | {
      identity: "unknown" | "other";
      digest: "unknown";
    };

export type NativeProfileRecoveryDecision =
  | {
      action: "rollback-source";
      publishRuntimeTransition: false;
      externallyRefreshed: boolean;
      reason: "source-active";
    }
  | {
      action: "commit-target";
      publishRuntimeTransition: true;
      externallyRefreshed: boolean;
      reason: "target-active-vault-pending";
    }
  | {
      action: "finalize-target";
      publishRuntimeTransition: true;
      externallyRefreshed: boolean;
      reason: "target-active-vault-committed";
    }
  | {
      action: "manual-recovery";
      publishRuntimeTransition: false;
      externallyRefreshed: false;
      reason: "auth-unconfirmed" | "third-identity";
    };

export function decideNativeProfileRecovery(
  phase: NativeProfileJournalPhase,
  observation: NativeProfileAuthObservation,
): NativeProfileRecoveryDecision {
  if (observation.identity === "unknown") {
    return {
      action: "manual-recovery",
      publishRuntimeTransition: false,
      externallyRefreshed: false,
      reason: "auth-unconfirmed",
    };
  }

  if (observation.identity === "other") {
    return {
      action: "manual-recovery",
      publishRuntimeTransition: false,
      externallyRefreshed: false,
      reason: "third-identity",
    };
  }

  if (observation.identity === "source") {
    return {
      action: "rollback-source",
      publishRuntimeTransition: false,
      externallyRefreshed: observation.digest === "changed",
      reason: "source-active",
    };
  }

  if (phase === "vault-committed") {
    return {
      action: "finalize-target",
      publishRuntimeTransition: true,
      externallyRefreshed: observation.digest === "changed",
      reason: "target-active-vault-committed",
    };
  }

  return {
    action: "commit-target",
    publishRuntimeTransition: true,
    externallyRefreshed: observation.digest === "changed",
    reason: "target-active-vault-pending",
  };
}
