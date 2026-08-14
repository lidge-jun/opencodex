import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("Compatibility Lab core isolation", () => {
  test("ordinary responses do not statically load or run Lab subject code", () => {
    const source = readFileSync("src/server/responses/core.ts", "utf8");
    expect(source).not.toContain(
      'import { resolveProductionRouteSubject } from "../../routing/compatibility/subject"',
    );
    expect(source).toContain("config.labIntegrationEnabled === true");
    expect(source).toContain('require(\n        "../../routing/compatibility/subject",');
  });

  test("concrete routing does not statically load compatibility evidence", () => {
    const source = readFileSync("src/router.ts", "utf8");
    expect(source).not.toContain(
      'import { assemblePolicyCandidateEvidence } from "./routing/compatibility/assemble"',
    );
    const profileBranch = source.indexOf("if (profile && policyId)");
    const lazyLoad = source.indexOf('require(\n      "./routing/compatibility/assemble",');
    expect(profileBranch).toBeGreaterThanOrEqual(0);
    expect(lazyLoad).toBeGreaterThan(profileBranch);
  });

  test("ordinary server startup and shutdown have no static Lab automation dependency", () => {
    const indexSource = readFileSync("src/server/index.ts", "utf8");
    const lifecycleSource = readFileSync("src/server/lifecycle.ts", "utf8");

    expect(indexSource).not.toContain('from "../lab/automation/orchestrator"');
    expect(indexSource).not.toContain('from "../lab/automation/persistence"');
    expect(indexSource).not.toContain('from "../lib/lab-live-route-production"');
    expect(indexSource).toContain("config.labIntegrationEnabled === true");
    expect(indexSource).toContain('require("../lab/automation/orchestrator")');

    expect(lifecycleSource).not.toContain("../lab/automation/orchestrator");
    expect(lifecycleSource).toContain("runLabAutomationShutdownHook()");
  });

  test("normal management traffic does not load Lab or routing-profile compatibility routes", () => {
    const source = readFileSync("src/server/management-api.ts", "utf8");

    expect(source).not.toContain('from "./management/lab-routes"');
    expect(source).not.toContain('from "./management/lab-automation-routes"');
    expect(source).not.toContain('from "./management/routing-profile-routes"');
    expect(source).toContain('import("./management/lab-routes")');
    expect(source).toContain('import("./management/lab-automation-routes")');
    expect(source).toContain('import("./management/routing-profile-routes")');
  });

  test("Lab integration flag is explicit opt-in in config parsing", () => {
    const source = readFileSync("src/config.ts", "utf8");
    expect(source).toContain("labIntegrationEnabled: z.boolean().optional().catch(false)");
  });
});
