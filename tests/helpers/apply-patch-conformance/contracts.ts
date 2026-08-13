export const APPLY_PATCH_FIXTURE = [
  "*** Begin Patch",
  "*** Update File: a \\\"quoted\\\" path.txt",
  "@@",
  "-old\\\\value",
  "+new\\\\value",
  "+unicode: Ω 漢字 🚀",
  "+json-ish: {\\\"x\\\":\\\"\\\\\\\\n\\\",\\\"quote\\\":\\\"\\\\\\\"\\\"}",
  "*** End Patch",
].join("\n");

export type ApplyPatchContractId =
  | "tools.code-mode-nested-helper"
  | "tools.freeform-exact-roundtrip"
  | "tools.tool-choice-final-catalog"
  | "tools.continuation-replay"
  | "mutation.codex-owned";

export interface ApplyPatchObservation {
  finalAdvertisement?: string;
  restoredInput?: string;
  expectedPatchAdvertised?: boolean;
  actualPatchAdvertised?: boolean;
  continuationInput?: string;
  codexOwnsMutation?: boolean;
  alternateMutationAllowed?: boolean;
}

const prohibition = /(?:do not|don't|never|must not|cannot|can't)[^.]{0,260}\bapply_patch\b|\bapply_patch\b[^.]{0,180}\b(?:forbidden|unavailable|off-limits)/i;

export function applyPatchContractFailures(observation: ApplyPatchObservation): ApplyPatchContractId[] {
  const failures: ApplyPatchContractId[] = [];
  if (observation.finalAdvertisement !== undefined) {
    if (!observation.finalAdvertisement.includes("apply_patch(input: string)") || prohibition.test(observation.finalAdvertisement)) {
      failures.push("tools.code-mode-nested-helper");
    }
  }
  if (observation.restoredInput !== undefined && observation.restoredInput !== APPLY_PATCH_FIXTURE) {
    failures.push("tools.freeform-exact-roundtrip");
  }
  if (
    observation.expectedPatchAdvertised !== undefined
    && observation.actualPatchAdvertised !== observation.expectedPatchAdvertised
  ) {
    failures.push("tools.tool-choice-final-catalog");
  }
  if (observation.continuationInput !== undefined && observation.continuationInput !== APPLY_PATCH_FIXTURE) {
    failures.push("tools.continuation-replay");
  }
  if (observation.codexOwnsMutation === true && observation.alternateMutationAllowed === true) {
    failures.push("mutation.codex-owned");
  }
  return failures;
}
