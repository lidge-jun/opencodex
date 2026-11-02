import { isAbsolute } from "node:path";

function validOutcome(outcome) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  if (!["preflight", "mutating", "installed", "failed", "refused", "overrun"].includes(outcome.phase)) return false;
  if (outcome.error !== undefined && typeof outcome.error !== "string") return false;
  if (outcome.rollbackPerformed !== undefined && typeof outcome.rollbackPerformed !== "boolean") return false;
  if (outcome.terminationConfirmed !== undefined && typeof outcome.terminationConfirmed !== "boolean") return false;
  return outcome.phase !== "installed" || (typeof outcome.activeRoot === "string" && isAbsolute(outcome.activeRoot));
}

/** Classify only independently observed state after confirmed child termination. */
export function classifyOrchestratedOutcome(input) {
  const result = {
    schema: "ocx.update.result/1", applied: false, fromVersion: input.fromVersion,
    toVersion: input.toVersion, installer: input.installer, restarted: false,
    healthy: false, rolledBack: false,
  };
  const done = (exitCode, error) => ({ exitCode, result: error ? { ...result, error } : result });
  if (!input.childExited || input.childExitCode === null || !validOutcome(input.outcome) || input.outcome.phase === "overrun") return done(12, "outcome-unverified");
  if (input.outcome.terminationConfirmed === false) return done(12, input.outcome.error || "installer-termination-unconfirmed");
  if (input.outcome.phase === "refused" && input.childExitCode !== 0) return done(10, input.outcome.error || "runtime-ownership-refused");
  if (input.outcome.phase === "failed" && input.outcome.error === "installer-termination-unconfirmed") return done(12, input.outcome.error);
  if (input.outcome.phase === "installed") {
    result.applied = input.targetVerified;
    result.restarted = input.restarted;
    result.healthy = input.targetVerified && input.runtimeHealthy && input.childExitCode === 0;
    if (!input.targetVerified) return done(12, "install-unverified");
    if (!result.healthy) return done(12, "runtime-unhealthy");
    return done(0);
  }
  if (["preflight", "mutating", "failed"].includes(input.outcome.phase) && input.childExitCode !== 0
    && input.previousVerified && input.runtimeHealthy) {
    result.healthy = true;
    result.restarted = input.restarted;
    result.rolledBack = input.outcome.phase === "failed" && input.outcome.rollbackPerformed === true;
    return done(11, input.outcome.error || "update-failed");
  }
  return done(12, "outcome-unverified");
}
