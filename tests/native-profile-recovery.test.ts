import { describe, expect, test } from "bun:test";

import {
  decideNativeProfileRecovery,
  type NativeProfileAuthObservation,
  type NativeProfileJournalPhase,
} from "../src/codex/native-profile-recovery";

const phases: NativeProfileJournalPhase[] = [
  "prepared",
  "auth-replaced",
  "vault-committed",
];

const sourceObservations: NativeProfileAuthObservation[] = [
  { identity: "source", digest: "exact" },
  { identity: "source", digest: "changed" },
];

const targetObservations: NativeProfileAuthObservation[] = [
  { identity: "target", digest: "exact" },
  { identity: "target", digest: "changed" },
];

describe("native profile crash recovery decisions", () => {
  for (const phase of phases) {
    for (const observation of sourceObservations) {
      test(`${phase}: ${observation.digest} source converges to source ownership`, () => {
        expect(decideNativeProfileRecovery(phase, observation)).toEqual({
          action: "rollback-source",
          publishRuntimeTransition: false,
          externallyRefreshed: observation.digest === "changed",
          reason: "source-active",
        });
      });
    }
  }

  for (const phase of ["prepared", "auth-replaced"] as const) {
    for (const observation of targetObservations) {
      test(`${phase}: ${observation.digest} target completes the vault commit`, () => {
        expect(decideNativeProfileRecovery(phase, observation)).toEqual({
          action: "commit-target",
          publishRuntimeTransition: true,
          externallyRefreshed: observation.digest === "changed",
          reason: "target-active-vault-pending",
        });
      });
    }
  }

  for (const observation of targetObservations) {
    test(`vault-committed: ${observation.digest} target finalizes runtime state`, () => {
      expect(
        decideNativeProfileRecovery("vault-committed", observation),
      ).toEqual({
        action: "finalize-target",
        publishRuntimeTransition: true,
        externallyRefreshed: observation.digest === "changed",
        reason: "target-active-vault-committed",
      });
    });
  }

  for (const phase of phases) {
    test(`${phase}: unreadable auth requires manual recovery`, () => {
      expect(
        decideNativeProfileRecovery(phase, {
          identity: "unknown",
          digest: "unknown",
        }),
      ).toEqual({
        action: "manual-recovery",
        publishRuntimeTransition: false,
        externallyRefreshed: false,
        reason: "auth-unconfirmed",
      });
    });

    test(`${phase}: a third identity requires manual recovery`, () => {
      expect(
        decideNativeProfileRecovery(phase, {
          identity: "other",
          digest: "unknown",
        }),
      ).toEqual({
        action: "manual-recovery",
        publishRuntimeTransition: false,
        externallyRefreshed: false,
        reason: "third-identity",
      });
    });
  }
});
