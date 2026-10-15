import { expect, test } from "bun:test";
import { firstLoadTimePathTo, resolvedImportEdges, slashed } from "../helpers/import-graph";
import { activateAdvisor } from "../../src/lib/advisor-activation";
import { createRegisteredAdvisorPlan } from "../../src/server/responses/advisor-plan-slot";
import type { OcxConfig } from "../../src/types";

const PROTECTED = [
  "src/router.ts", "src/server/lifecycle.ts", "src/server/responses/core.ts",
  "src/server/management-api.ts",
];

for (const entry of PROTECTED) {
  test(`${entry} cannot eagerly reach Advisor or directly load it`, () => {
    const target = (path: string) => path.includes("/src/advisor/");
    const chain = firstLoadTimePathTo(entry, target);
    expect(chain, chain?.join(" -> ")).toBeNull();
    expect(resolvedImportEdges(entry).filter(edge => edge.resolved && target(slashed(edge.resolved)))).toEqual([]);
  });
}

test("activation is config-scoped, supports enable after startup, and detaches on disable", async () => {
  const inactive = { port: 10100, providers: {} } as OcxConfig;
  const input = (config: OcxConfig) => ({ config, workerIdentity: "worker", workerModelId: "worker" });
  activateAdvisor(inactive);
  expect(createRegisteredAdvisorPlan(input(inactive))).toBeNull();
  const active = { ...inactive, advisor: { enabled: true, model: "expert" } };
  activateAdvisor(active);
  const plan = await createRegisteredAdvisorPlan(input(active));
  expect(plan?.tool.name).toBe("advisor");
  expect(createRegisteredAdvisorPlan(input(inactive))).toBeNull();
  active.advisor.enabled = false;
  activateAdvisor(active);
  expect(createRegisteredAdvisorPlan(input(active))).toBeNull();
});
