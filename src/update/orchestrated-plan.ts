import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import { createUpdatePlanToken } from "./orchestrated-token.mjs";
import type { ServingIdentity } from "./orchestrated-identity";

export const ORCHESTRATED_MUTATION_BOUND_MS = 900_000;
type Installer = "npm" | "pnpm" | "bun" | "mise" | "desktop-app" | "source" | "unknown";
type RuntimeOwner = "service" | "desktop-app" | "unmanaged" | "none" | "unknown";
type Reason = "desktop-app-owned" | "source-checkout" | "mise-managed" | "installer-unknown" | "plan-unavailable" | "serving-install-unknown" | "cli-not-serving-install" | "runtime-ownership-refused" | "target-unresolved" | "downgrade-refused" | "up-to-date";

export interface PlanInputs {
  currentVersion: string;
  targetVersion: string | null;
  installer: Installer;
  runtimeOwner: RuntimeOwner;
  cliRoot: string;
  identity: ServingIdentity;
  ownershipPermits: boolean;
  updateInFlight: boolean;
}

/** Construct the public plan from already-observed facts, refusing every uncertain boundary. */
export function buildOrchestratedPlan(input: PlanInputs) {
  const live = input.identity.kind === "live" ? input.identity : null;
  const servingRoot = live?.servingRoot ?? null;
  const current = parseStrictSemver(input.currentVersion);
  const target = parseStrictSemver(input.targetVersion);
  let reason: Reason | undefined;
  if (input.installer === "desktop-app") reason = "desktop-app-owned";
  else if (input.installer === "source") reason = "source-checkout";
  else if (input.installer === "mise") reason = "mise-managed";
  else if (input.installer === "unknown") reason = "installer-unknown";
  else if (input.identity.kind === "unknown") reason = "serving-install-unknown";
  else if (input.identity.kind === "mismatch") reason = "cli-not-serving-install";
  else if (live && servingRoot !== input.cliRoot) reason = "cli-not-serving-install";
  else if (!input.ownershipPermits || input.runtimeOwner === "unknown") reason = "runtime-ownership-refused";
  else if (!current || !target) reason = "target-unresolved";
  else if (compareStrictSemver(target, current) < 0) reason = "downgrade-refused";
  else if (compareStrictSemver(target, current) === 0) reason = "up-to-date";
  const planToken = createUpdatePlanToken({
    currentVersion: input.currentVersion, targetVersion: input.targetVersion, installer: input.installer,
    cliRoot: input.cliRoot, servingRoot, runtimeOwner: input.runtimeOwner, runtime: live?.runtime ?? null,
  });
  return {
    schema: "ocx.update.plan/1" as const, currentVersion: input.currentVersion, targetVersion: input.targetVersion,
    installer: input.installer, runtimeOwner: input.runtimeOwner, servingPath: servingRoot, cliPath: input.cliRoot,
    canApply: reason === undefined, ...(reason ? { reason } : {}), restartRequired: live !== null,
    planToken, updateInFlight: input.updateInFlight, mutationBoundMs: ORCHESTRATED_MUTATION_BOUND_MS,
  };
}
