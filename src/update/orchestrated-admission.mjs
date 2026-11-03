/** Resolve decisions that require no mutation before starting an update worker. */
export function decideOrchestratedApply(plan, request, now) {
  const result = { schema: "ocx.update.result/1", applied: false, fromVersion: plan.currentVersion,
    toVersion: plan.targetVersion, installer: plan.installer, restarted: false, healthy: false, rolledBack: false };
  const refuse = error => ({ kind: "done", exitCode: 10, result: { ...result, error } });
  if (request.expectPlan && request.expectPlan !== plan.planToken) return refuse("plan-changed");
  if (request.notAfter !== undefined && now > request.notAfter) return refuse("deadline-passed");
  if (plan.updateInFlight) return refuse("update-in-flight");
  if (plan.reason === "up-to-date") return { kind: "done", exitCode: 0, result };
  if (!plan.canApply) return refuse(plan.reason ?? "plan-unavailable");
  return { kind: "proceed" };
}
