/** Host activation seam. Registration is synchronous; optional code loads only on use. */
import type { OcxConfig } from "../types";
import { setAdvisorPlanFactory } from "../server/responses/advisor-plan-slot";

export function activateAdvisor(config: OcxConfig): void {
  if (config.advisor?.enabled !== true || typeof config.advisor.model !== "string" || !config.advisor.model.trim()) {
    setAdvisorPlanFactory(config, null);
    return;
  }
  setAdvisorPlanFactory(config, async input => {
    // A later settings write may disable the same live config before this request starts.
    if (config.advisor?.enabled !== true || !config.advisor.model?.trim()) return null;
    const { createAdvisorRuntimePlan } = await import("../advisor/runtime");
    return createAdvisorRuntimePlan(input);
  });
}
